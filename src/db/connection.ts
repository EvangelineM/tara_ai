import { Pool } from "pg";
import dotenv from "dotenv";
import path from "path";
import { getProjectRoot } from "../lib/paths";

dotenv.config({ path: path.join(getProjectRoot(), ".env") });

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});