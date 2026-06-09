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
import { unifyMerchantMappings } from "../src/lib/merchant-resolver";
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
    model: "google/gemini-2.5-flash-lite",
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

    const memoSamples = new Map<string, string[]>(
      Array.from(merchantMap.entries()).map(([raw, details]) => [
        raw,
        Array.from(details.memos).slice(0, 5),
      ])
    );
    mappings = unifyMerchantMappings(mappings, memoSamples);
    console.log("Applied alias discovery to unify canonical merchant names.");

    console.log("Inserting merchant mappings...");
    if (mappings.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < mappings.length; i += batchSize) {
        const batch = mappings.slice(i, i + batchSize);
        const values: any[] = [];
        const placeholders: string[] = [];
        batch.forEach((map, idx) => {
          const base = idx * 3;
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
          values.push(map.raw_merchant, map.normalized_merchant, map.category);
        });
        await client.query(
          `INSERT INTO merchant_mappings (raw_merchant, normalized_merchant, category)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (raw_merchant) DO UPDATE
           SET normalized_merchant = EXCLUDED.normalized_merchant, category = EXCLUDED.category`,
          values
        );
      }
    }

    console.log("Inserting transactions...");
    if (transactions.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const values: any[] = [];
        const placeholders: string[] = [];
        batch.forEach((tx, idx) => {
          const base = idx * 7;
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
          values.push(tx.id, tx.date, tx.merchant, tx.category, tx.amount, tx.currency, tx.memo);
        });
        await client.query(
          `INSERT INTO transactions (id, date, merchant, category, amount, currency, memo)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (id) DO NOTHING`,
          values
        );
      }
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

      if (Array.isArray(fund.nav) && fund.nav.length > 0) {
        const navRows = fund.nav;
        const batchSize = 100;
        for (let i = 0; i < navRows.length; i += batchSize) {
          const batch = navRows.slice(i, i + batchSize);
          const values: any[] = [];
          const placeholders: string[] = [];
          batch.forEach((navRow, idx) => {
            const base = idx * 3;
            placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            values.push(fund.id, navRow.date, navRow.value);
          });
          await client.query(
            `INSERT INTO fund_nav (fund_id, nav_date, nav)
             VALUES ${placeholders.join(", ")}
             ON CONFLICT (fund_id, nav_date) DO UPDATE
             SET nav = EXCLUDED.nav`,
            values
          );
        }
      }
    }

    console.log("Inserting holdings...");
    if (holdings.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < holdings.length; i += batchSize) {
        const batch = holdings.slice(i, i + batchSize);
        const values: any[] = [];
        const placeholders: string[] = [];
        batch.forEach((holding, idx) => {
          const base = idx * 5;
          placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
          values.push(holding.fund_id, holding.fund_name, holding.units, holding.purchase_date, holding.purchase_nav);
        });
        await client.query(
          `INSERT INTO holdings (fund_id, fund_name, units, purchase_date, purchase_nav)
           VALUES ${placeholders.join(", ")}`,
          values
        );
      }
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
