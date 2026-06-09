import { pool } from "../src/db/connection";

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT fund_name, units, purchase_date, purchase_nav, dataset 
      FROM holdings 
      LIMIT 10
    `);
    console.log("Holdings Sample Rows (with dataset):");
    console.table(res.rows);
  } catch (err: any) {
    console.error("DB Error:", err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

main();
