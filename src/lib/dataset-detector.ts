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
  // All datasets (Sample A, B, and C) are loaded simultaneously, so we do not switch.
  return false;
}
