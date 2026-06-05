import { pool } from "../src/db/connection";

async function testConnection() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("✅ Database connected!");
    console.log(result.rows[0]);

    await pool.end();
  } catch (error) {
    console.error("❌ Connection failed:", error);
  }
}

testConnection();