import { pool } from "../src/db/connection";

async function checkTables() {
  try {
    const tablesRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log("Tables in database:", tablesRes.rows.map(r => r.table_name));

    for (const row of tablesRes.rows) {
      const columnsRes = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
      `, [row.table_name]);
      console.log(`\nColumns for table "${row.table_name}":`);
      console.log(columnsRes.rows);
    }
  } catch (err) {
    console.error("Error checking tables:", err);
  } finally {
    await pool.end();
  }
}

checkTables();
