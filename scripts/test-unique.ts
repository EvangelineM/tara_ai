import fs from "fs";
import path from "path";
import { resolveDataDir } from "../src/lib/paths";

const dataDir = resolveDataDir();
const transactions = JSON.parse(
  fs.readFileSync(path.join(dataDir, "transactions.json"), "utf-8")
);

const uniqueMerchants = new Set<string>();
const merchantToCategory = new Map<string, Set<string>>();
const merchantToMemoSample = new Map<string, string[]>();

for (const tx of transactions) {
  uniqueMerchants.add(tx.merchant);
  if (!merchantToCategory.has(tx.merchant)) {
    merchantToCategory.set(tx.merchant, new Set());
  }
  merchantToCategory.get(tx.merchant)!.add(tx.category);

  if (!merchantToMemoSample.has(tx.merchant)) {
    merchantToMemoSample.set(tx.merchant, []);
  }
  if (merchantToMemoSample.get(tx.merchant)!.length < 2) {
    merchantToMemoSample.get(tx.merchant)!.push(tx.memo || "");
  }
}

console.log("Total transactions:", transactions.length);
console.log("Unique merchants count:", uniqueMerchants.size);
console.log("Unique merchants:", Array.from(uniqueMerchants).sort());
