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
    const filePath = path.join(projectRoot, "data", dataset, "transactions.json");
    if (!fs.existsSync(filePath)) continue;

    try {
      const transactions = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Array<{ merchant: string }>;
      const merchants = new Set<string>();

      for (const tx of transactions) {
        if (tx.merchant) {
          // Add lowercase, cleaned keys to make comparisons robust
          const cleanKey = cleanMerchantKey(tx.merchant);
          if (cleanKey) {
            merchants.add(cleanKey);
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

  // Helper check to see if a query contains/matches a merchant
  function isMatch(merchants: Set<string>): boolean {
    const queryTokens = tokenizeMerchantName(term);
    const queryAcronym = queryTokens.length > 1 ? merchantAcronym(queryTokens) : "";

    for (const merchant of merchants) {
      // 1. Exact/Substring matches
      if (
        merchant === cleanedTerm ||
        cleanedTerm.includes(merchant) ||
        merchant.includes(cleanedTerm) ||
        term.includes(merchant)
      ) {
        return true;
      }

      // 2. Acronym matches
      const merchantTokens = tokenizeMerchantName(merchant);
      const mAcronym = merchantTokens.length > 1 ? merchantAcronym(merchantTokens) : "";
      if (mAcronym && (mAcronym === cleanedTerm || queryTokens.includes(mAcronym))) {
        return true;
      }
      if (queryAcronym && (queryAcronym === merchant || merchantTokens.includes(queryAcronym))) {
        return true;
      }

      // 3. Fuzzy match of full cleaned terms
      if (similarityRatio(merchant, cleanedTerm) >= 0.80) {
        return true;
      }

      // 4. Token-by-token comparison (fuzzy or substring)
      for (const qToken of queryTokens) {
        if (qToken.length >= 3) {
          // Check if any query token matches the merchant name or is a substring of it
          if (merchant.includes(qToken) || similarityRatio(merchant, qToken) >= 0.80) {
            return true;
          }
          // Check if any query token matches any merchant token fuzzy-wise
          for (const mToken of merchantTokens) {
            if (mToken.length >= 3 && similarityRatio(mToken, qToken) >= 0.80) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  // 1. Check if the current dataset already contains a match
  const current = datasets.find((d) => d.dataset === currentName);
  if (current && isMatch(current.merchants)) {
    return false; // Already matches, no switch needed
  }

  // 2. Search other datasets for a match
  const match = datasets.find((d) => d.dataset !== currentName && isMatch(d.merchants));
  if (!match) {
    return false; // No other dataset has a match
  }

  const targetDataset = match.dataset;
  console.log(`[Auto-Switch] Switching dataset from "${currentName}" to "${targetDataset}" to match query: "${searchTermOrQuery}"`);

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
