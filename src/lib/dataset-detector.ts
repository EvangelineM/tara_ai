import fs from "fs";
import path from "path";
import { getProjectRoot, listAvailableDatasets, resolveDataDir } from "./paths";
import { cleanMerchantKey, tokenizeMerchantName, merchantAcronym, similarityRatio } from "./merchant-resolver";

interface DatasetMerchants {
  dataset: string;
  merchants: Set<string>;
}

let cache: DatasetMerchants[] | null = null;

/** Load and cache the unique merchants present in each available dataset. */
export function getDatasetMerchants(): DatasetMerchants[] {
  if (cache) return cache;

  const projectRoot = getProjectRoot();
  const datasets = listAvailableDatasets();
  const result: DatasetMerchants[] = [];

  for (const dataset of datasets) {
    const merchants = new Set<string>();

    try {
      // 1. Load transactions
      const txPath = path.join(projectRoot, "data", dataset, "transactions.json");
      if (fs.existsSync(txPath)) {
        const transactions = JSON.parse(fs.readFileSync(txPath, "utf-8")) as Array<{ merchant: string }>;
        for (const tx of transactions) {
          if (tx.merchant) {
            const cleanKey = cleanMerchantKey(tx.merchant);
            if (cleanKey) {
              merchants.add(cleanKey);
            }
          }
        }
      }

      // 2. Load funds
      const fundsPath = path.join(projectRoot, "data", dataset, "funds.json");
      if (fs.existsSync(fundsPath)) {
        const funds = JSON.parse(fs.readFileSync(fundsPath, "utf-8")) as Array<{ name: string; id: string }>;
        for (const fund of funds) {
          if (fund.name) {
            const cleanKey = cleanMerchantKey(fund.name);
            if (cleanKey) merchants.add(cleanKey);
          }
          if (fund.id) {
            const cleanKey = cleanMerchantKey(fund.id);
            if (cleanKey) merchants.add(cleanKey);
          }
        }
      }

      // 3. Load holdings
      const holdingsPath = path.join(projectRoot, "data", dataset, "holdings.json");
      if (fs.existsSync(holdingsPath)) {
        const holdings = JSON.parse(fs.readFileSync(holdingsPath, "utf-8")) as Array<{ fund_name: string; fund_id: string }>;
        for (const holding of holdings) {
          if (holding.fund_name) {
            const cleanKey = cleanMerchantKey(holding.fund_name);
            if (cleanKey) merchants.add(cleanKey);
          }
          if (holding.fund_id) {
            const cleanKey = cleanMerchantKey(holding.fund_id);
            if (cleanKey) merchants.add(cleanKey);
          }
        }
      }

      result.push({ dataset, merchants });
    } catch (err) {
      console.error(`[DatasetDetector] Failed to parse dataset ${dataset}:`, err);
    }
  }

  cache = result;
  return cache;
}

/** Get the currently active dataset name. */
export function getCurrentDatasetName(): string {
  const currentDir = process.env.DATA_DIR || "";
  // Extends "data/sample_a" -> "sample_a"
  const base = path.basename(currentDir);
  return base || "sample_a";
}

/**
 * Scan all datasets for a merchant name matching the search term or query.
 * If a match is found in another dataset (but not the current one),
 * automatically switch and re-ingest.
 */
export async function autoSwitchDatasetIfNeeded(searchTermOrQuery: string): Promise<boolean> {
  const term = searchTermOrQuery.trim().toLowerCase();
  if (!term) return false;

  const datasets = getDatasetMerchants();
  const currentName = getCurrentDatasetName();

  // Clean the input to match our cached merchant keys
  const cleanedTerm = cleanMerchantKey(term);

  // Helper function to calculate a match score for a dataset's entities
  function getMatchScore(merchants: Set<string>): number {
    const queryTokens = tokenizeMerchantName(term);
    const queryAcronym = queryTokens.length > 1 ? merchantAcronym(queryTokens) : "";
    
    let maxScore = 0;

    for (const merchant of merchants) {
      // Tier 1: Exact match
      if (merchant === cleanedTerm) {
        return 3;
      }

      // Tier 2: Acronym or high similarity fuzzy match
      const isAcronymMatch = (() => {
        const merchantTokens = tokenizeMerchantName(merchant);
        const mAcronym = merchantTokens.length > 1 ? merchantAcronym(merchantTokens) : "";
        if (mAcronym && (mAcronym === cleanedTerm || queryTokens.includes(mAcronym))) {
          return true;
        }
        if (queryAcronym && (queryAcronym === merchant || merchantTokens.includes(queryAcronym))) {
          return true;
        }
        return false;
      })();

      if (isAcronymMatch || similarityRatio(merchant, cleanedTerm) >= 0.90) {
        maxScore = Math.max(maxScore, 2);
        continue;
      }

      // Tier 3: Substring / Token / Standard fuzzy match
      const isSubstringOrFuzzy = (() => {
        if (
          cleanedTerm.includes(merchant) ||
          merchant.includes(cleanedTerm) ||
          term.includes(merchant)
        ) {
          return true;
        }
        if (similarityRatio(merchant, cleanedTerm) >= 0.80) {
          return true;
        }
        // Token-by-token comparison
        const merchantTokens = tokenizeMerchantName(merchant);
        for (const qToken of queryTokens) {
          if (qToken.length >= 3) {
            if (merchant.includes(qToken) || similarityRatio(merchant, qToken) >= 0.80) {
              return true;
            }
            for (const mToken of merchantTokens) {
              if (mToken.length >= 3 && similarityRatio(mToken, qToken) >= 0.80) {
                return true;
              }
            }
          }
        }
        return false;
      })();

      if (isSubstringOrFuzzy) {
        maxScore = Math.max(maxScore, 1);
      }
    }

    return maxScore;
  }

  // 1. Get current dataset score
  const current = datasets.find((d) => d.dataset === currentName);
  let bestScore = current ? getMatchScore(current.merchants) : 0;
  let bestDataset = currentName;

  // 2. Search other datasets for a strictly better match
  for (const d of datasets) {
    if (d.dataset === currentName) continue;
    const score = getMatchScore(d.merchants);
    if (score > bestScore) {
      bestScore = score;
      bestDataset = d.dataset;
    }
  }

  if (bestDataset === currentName || bestScore === 0) {
    return false; // Already on the best dataset, or no dataset matches at all
  }

  const targetDataset = bestDataset;
  console.log(`[Auto-Switch] Switching dataset from "${currentName}" to "${targetDataset}" to match query: "${searchTermOrQuery}" with score: ${bestScore}`);

  // Update DATA_DIR env
  const targetDir = path.join("data", targetDataset);
  process.env.DATA_DIR = targetDir;

  // Run Ingestion
  const { ingestData } = await import("../../scripts/ingest");
  await ingestData(targetDir);

  // Clear caches
  const { clearMerchantRegistryCache } = await import("./merchant-service");
  clearMerchantRegistryCache();

  const { clearSemanticMatchCache } = await import("./semantic-matcher");
  clearSemanticMatchCache();

  return true;
}
