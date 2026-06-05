import { pool } from "../src/db/connection";

async function queryMerchant(searchTerm: string) {
  try {
    const pattern = `%${searchTerm}%`;
    const res1 = await pool.query(
      "SELECT * FROM merchant_mappings WHERE normalized_merchant ILIKE $1 OR raw_merchant ILIKE $1",
      [pattern]
    );
    console.log(`Merchant mappings matching "${searchTerm}":`, res1.rows);

    const res2 = await pool.query(
      "SELECT * FROM transactions WHERE merchant ILIKE $1 LIMIT 5",
      [pattern]
    );
    console.log(`Transactions matching "${searchTerm}":`, res2.rows);

    const res3 = await pool.query("SELECT COUNT(*) FROM transactions");
    console.log("Total transactions:", res3.rows[0]);
  } catch (error) {
    console.error("Query failed:", error);
  } finally {
    await pool.end();
  }
}

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error("Usage: npx tsx scripts/query.ts <merchant-search-term>");
  process.exit(1);
}

queryMerchant(searchTerm);
