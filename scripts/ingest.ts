import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { pool } from "../src/db/connection";
import { getProjectRoot, resolveDataDir } from "../src/lib/paths";
import {
  buildNormalizationPrompt,
  collectCategoryVocabulary,
  normalizeMerchantsFallback,
  type MerchantInput,
  type MerchantMapping,
} from "../src/lib/normalize";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";

dotenv.config({ path: path.join(getProjectRoot(), ".env") });

const NormalizationSchema = z.object({
  mappings: z.array(
    z.object({
      raw_merchant: z.string(),
      normalized_merchant: z.string(),
      category: z.string(),
    })
  ),
});

const LLM_BATCH_SIZE = 40;

async function normalizeWithLLM(
  merchants: MerchantInput[],
  categoryVocabulary: string[]
): Promise<MerchantMapping[]> {
  const normalizerAgent = new Agent({
    id: "normalizer-agent",
    name: "Normalizer Agent",
    model: "google/gemini-3.5-flash",
    instructions:
      "You normalize merchant names and assign spending categories using only labels supplied in the prompt.",
  });

  const mappings: MerchantMapping[] = [];

  for (let i = 0; i < merchants.length; i += LLM_BATCH_SIZE) {
    const batch = merchants.slice(i, i + LLM_BATCH_SIZE);
    const prompt = buildNormalizationPrompt(batch, categoryVocabulary);
    const res = await normalizerAgent.generate(prompt, {
      structuredOutput: {
        schema: NormalizationSchema,
      },
    });

    if (!res.object?.mappings?.length) {
      throw new Error("No mappings returned from LLM structured output.");
    }

    mappings.push(...res.object.mappings);
  }

  return mappings;
}

function ensureCompleteMappings(
  merchants: MerchantInput[],
  mappings: MerchantMapping[],
  categoryVocabulary: string[]
): MerchantMapping[] {
  const byRaw = new Map(mappings.map((mapping) => [mapping.raw_merchant, mapping]));
  const fallback = normalizeMerchantsFallback(merchants, categoryVocabulary);
  const fallbackByRaw = new Map(fallback.map((mapping) => [mapping.raw_merchant, mapping]));

  return merchants.map((item) => {
    return byRaw.get(item.raw_merchant) ?? fallbackByRaw.get(item.raw_merchant)!;
  });
}

export async function ingestData(dir?: string) {
  const dataDir = resolveDataDir(dir);
  const client = await pool.connect();
  try {
    console.log(`Starting ingestion from: ${dataDir}`);

    await client.query(`
      DROP TABLE IF EXISTS holdings CASCADE;
      DROP TABLE IF EXISTS fund_nav CASCADE;
      DROP TABLE IF EXISTS funds CASCADE;
      DROP TABLE IF EXISTS transactions CASCADE;
      DROP TABLE IF EXISTS merchant_mappings CASCADE;

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        date DATE,
        merchant TEXT,
        category TEXT,
        amount NUMERIC,
        currency TEXT,
        memo TEXT
      );

      CREATE TABLE funds (
        id TEXT PRIMARY KEY,
        name TEXT,
        category TEXT
      );

      CREATE TABLE fund_nav (
        fund_id TEXT,
        nav_date DATE,
        nav NUMERIC,
        PRIMARY KEY (fund_id, nav_date)
      );

      CREATE TABLE holdings (
        fund_id TEXT,
        fund_name TEXT,
        units NUMERIC,
        purchase_date DATE,
        purchase_nav NUMERIC
      );

      CREATE TABLE merchant_mappings (
        raw_merchant TEXT PRIMARY KEY,
        normalized_merchant TEXT,
        category TEXT
      );
    `);

    await client.query("TRUNCATE TABLE transactions, funds, fund_nav, holdings, merchant_mappings CASCADE");
    console.log("Database tables truncated successfully.");

    const transactionsPath = path.join(dataDir, "transactions.json");
    const fundsPath = path.join(dataDir, "funds.json");
    const holdingsPath = path.join(dataDir, "holdings.json");

    if (!fs.existsSync(transactionsPath) || !fs.existsSync(fundsPath) || !fs.existsSync(holdingsPath)) {
      throw new Error(`Data files missing in directory: ${dataDir}`);
    }

    const transactions = JSON.parse(fs.readFileSync(transactionsPath, "utf-8"));
    const funds = JSON.parse(fs.readFileSync(fundsPath, "utf-8"));
    const holdings = JSON.parse(fs.readFileSync(holdingsPath, "utf-8"));

    console.log(`Loaded from files: ${transactions.length} txns, ${funds.length} funds, ${holdings.length} holdings.`);

    const categoryVocabulary = collectCategoryVocabulary(transactions);
    console.log(`Discovered category vocabulary: ${categoryVocabulary.join(", ") || "none"}`);

    const merchantMap = new Map<string, { categories: Set<string>; memos: Set<string> }>();
    for (const tx of transactions) {
      if (!merchantMap.has(tx.merchant)) {
        merchantMap.set(tx.merchant, { categories: new Set(), memos: new Set() });
      }
      const data = merchantMap.get(tx.merchant)!;
      if (tx.category && tx.category !== "uncategorized") {
        data.categories.add(tx.category);
      }
      if (tx.memo) {
        data.memos.add(tx.memo);
      }
    }

    const uniqueMerchantsList: MerchantInput[] = Array.from(merchantMap.entries()).map(
      ([raw_merchant, details]) => ({
        raw_merchant,
        categories: Array.from(details.categories),
        memos: Array.from(details.memos).slice(0, 3),
      })
    );

    console.log(`Normalizing ${uniqueMerchantsList.length} unique merchants...`);
    let mappings: MerchantMapping[];

    if (process.env.GOOGLE_API_KEY) {
      try {
        mappings = await normalizeWithLLM(uniqueMerchantsList, categoryVocabulary);
        mappings = ensureCompleteMappings(uniqueMerchantsList, mappings, categoryVocabulary);
        console.log(`Successfully normalized ${mappings.length} merchants using LLM.`);
      } catch (err) {
        console.warn("LLM normalization failed, using heuristic fallback:", (err as Error).message);
        mappings = normalizeMerchantsFallback(uniqueMerchantsList, categoryVocabulary);
        console.log(`Completed heuristic normalization for ${mappings.length} merchants.`);
      }
    } else {
      mappings = normalizeMerchantsFallback(uniqueMerchantsList, categoryVocabulary);
      console.log(`Completed heuristic normalization for ${mappings.length} merchants.`);
    }

    console.log("Inserting merchant mappings...");
    for (const map of mappings) {
      await client.query(
        `INSERT INTO merchant_mappings (raw_merchant, normalized_merchant, category)
         VALUES ($1, $2, $3)
         ON CONFLICT (raw_merchant) DO UPDATE
         SET normalized_merchant = EXCLUDED.normalized_merchant, category = EXCLUDED.category`,
        [map.raw_merchant, map.normalized_merchant, map.category]
      );
    }

    console.log("Inserting transactions...");
    for (const tx of transactions) {
      await client.query(
        `INSERT INTO transactions (id, date, merchant, category, amount, currency, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [tx.id, tx.date, tx.merchant, tx.category, tx.amount, tx.currency, tx.memo]
      );
    }

    console.log("Inserting funds and NAVs...");
    for (const fund of funds) {
      await client.query(
        `INSERT INTO funds (id, name, category)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, category = EXCLUDED.category`,
        [fund.id, fund.name, fund.category]
      );

      if (Array.isArray(fund.nav)) {
        for (const navRow of fund.nav) {
          await client.query(
            `INSERT INTO fund_nav (fund_id, nav_date, nav)
             VALUES ($1, $2, $3)
             ON CONFLICT (fund_id, nav_date) DO UPDATE
             SET nav = EXCLUDED.nav`,
            [fund.id, navRow.date, navRow.value]
          );
        }
      }
    }

    console.log("Inserting holdings...");
    for (const holding of holdings) {
      await client.query(
        `INSERT INTO holdings (fund_id, fund_name, units, purchase_date, purchase_nav)
         VALUES ($1, $2, $3, $4, $5)`,
        [holding.fund_id, holding.fund_name, holding.units, holding.purchase_date, holding.purchase_nav]
      );
    }

    console.log("✅ Ingestion successfully completed!");
  } catch (error) {
    console.error("❌ Ingestion failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && process.argv[1].endsWith("ingest.ts")) {
  ingestData()
    .then(() => {
      console.log("Ingestion CLI script finished.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
