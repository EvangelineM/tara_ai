import { pool } from "../src/db/connection";

async function main() {
  console.log("URL:", process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    console.log("Dropping and recreating holdings table...");
    await client.query(`
      DROP TABLE IF EXISTS holdings CASCADE;
      CREATE TABLE holdings (
        fund_id TEXT,
        fund_name TEXT,
        units NUMERIC,
        purchase_date DATE,
        purchase_nav NUMERIC,
        dataset TEXT
      );
    `);

    const res = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'holdings'
    `);
    console.log("Columns after DDL:");
    console.table(res.rows);

  } catch (err: any) {
    console.error("DDL failed:", err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

main();
