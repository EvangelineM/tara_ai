import type { Pool, PoolClient } from "pg";

export interface LargestTransaction {
  merchant: string;
  category: string;
  amount: number;
  date: string;
  memo: string | null;
}

export interface LargestCategorySpend {
  category: string;
  totalSpend: number;
}

type Queryable = Pool | PoolClient;

const EXCLUDE_TRANSFERS = `
  AND t.category !~* 'transfer'
  AND m.category !~* 'transfer'
`;

/**
 * Definition A: Largest single positive transaction (expense), excluding transfers.
 * Sorted by amount DESC, LIMIT 1.
 */
export async function getLargestTransaction(
  db?: Queryable
): Promise<LargestTransaction | null> {
  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }
  const client = "query" in db ? db : await db.connect();
  const ownsClient = !("query" in db);

  try {
    const res = await client.query(
      `
      SELECT
        m.normalized_merchant AS merchant,
        m.category,
        t.amount::numeric AS amount,
        t.date::text AS date,
        t.memo
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE t.amount > 0
      ${EXCLUDE_TRANSFERS}
      ORDER BY t.amount DESC
      LIMIT 1
      `
    );

    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      merchant: row.merchant,
      category: row.category,
      amount: parseFloat(row.amount),
      date: row.date,
      memo: row.memo ?? null,
    };
  } finally {
    if (ownsClient) (client as PoolClient).release();
  }
}

/**
 * Definition B: Category with highest total positive spend, excluding transfers.
 */
export async function getLargestCategorySpend(
  db?: Queryable
): Promise<LargestCategorySpend | null> {
  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }
  const client = "query" in db ? db : await db.connect();
  const ownsClient = !("query" in db);

  try {
    const res = await client.query(
      `
      SELECT
        m.category,
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE 1=1
      ${EXCLUDE_TRANSFERS}
      GROUP BY m.category
      ORDER BY total_spend DESC
      LIMIT 1
      `
    );

    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      category: row.category,
      totalSpend: parseFloat(row.total_spend),
    };
  } finally {
    if (ownsClient) (client as PoolClient).release();
  }
}

/** Sum spending for a category (positive amounts, excluding transfers). */
export async function getCategorySpending(
  categoryPattern: RegExp,
  db?: Queryable
): Promise<{ category: string; totalSpend: number; transactionCount: number } | null> {
  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }
  const client = "query" in db ? db : await db.connect();
  const ownsClient = !("query" in db);

  try {
    const res = await client.query(
      `
      SELECT
        m.category,
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE 1=1
      ${EXCLUDE_TRANSFERS}
      GROUP BY m.category
      `
    );

    const match = res.rows.find((row) => categoryPattern.test(row.category));
    if (!match) return null;

    return {
      category: match.category,
      totalSpend: parseFloat(match.total_spend),
      transactionCount: match.transaction_count,
    };
  } finally {
    if (ownsClient) (client as PoolClient).release();
  }
}
