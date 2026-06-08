import type { Pool, PoolClient } from "pg";
import {
  buildMerchantRegistry,
  matchMerchantTerm,
  type MerchantAliasGroup,
  type MerchantMatchResult,
  type MerchantRecord,
  type MerchantRegistry,
} from "./merchant-resolver";

type Queryable = Pool | PoolClient;

export interface MerchantSpendResult {
  userTerm: string;
  canonicalName: string;
  matchedAliases: string[];
  rawMerchants: string[];
  totalSpend: number;
  transactionCount: number;
  confidence: MerchantMatchResult["confidence"];
}

let registryCache: MerchantRegistry | null = null;

async function withClient<T>(
  db: Queryable,
  fn: (client: Pool | PoolClient) => Promise<T>
): Promise<T> {
  if ("query" in db) {
    return fn(db);
  }
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Load merchant records from the database and build alias registry. */
export async function loadMerchantRegistry(db: Queryable): Promise<MerchantRegistry> {
  if (registryCache) return registryCache;

  const records = await withClient(db, async (client) => {
    const res = await client.query(`
      SELECT
        m.raw_merchant,
        m.normalized_merchant,
        m.category,
        COALESCE(
          (
            SELECT array_agg(memo)
            FROM (
              SELECT DISTINCT t.memo
              FROM transactions t
              WHERE t.merchant = m.raw_merchant
                AND t.memo IS NOT NULL
                AND t.memo <> ''
              LIMIT 5
            ) memo_sample
          ),
          ARRAY[]::text[]
        ) AS sample_memos
      FROM merchant_mappings m
    `);

    return res.rows.map(
      (row): MerchantRecord => ({
        rawMerchant: row.raw_merchant,
        normalizedMerchant: row.normalized_merchant,
        category: row.category,
        sampleMemos: row.sample_memos ?? [],
      })
    );
  });

  registryCache = buildMerchantRegistry(records);
  return registryCache;
}

export function clearMerchantRegistryCache(): void {
  registryCache = null;
}

function uniqueDisplayAliases(group: MerchantAliasGroup): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of group.displayNames) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(name.trim());
  }
  return result;
}

/** Sum spending for all raw merchants in an alias group. */
export async function getSpendingForMerchantGroup(
  group: MerchantAliasGroup,
  db: Queryable
): Promise<{ totalSpend: number; transactionCount: number } | null> {
  if (!group.rawMerchants.length) return null;

  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE t.merchant = ANY($1::text[])
        AND t.category !~* 'transfer'
        AND m.category !~* 'transfer'
      `,
      [group.rawMerchants]
    );

    const row = res.rows[0];
    if (!row || parseFloat(row.total_spend) === 0) return null;

    return {
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    };
  });
}

/**
 * Resolve a user merchant query (e.g. "BMS", "BookMyShow") to aggregated spending
 * across all discovered aliases.
 */
export async function resolveMerchantSpending(
  userTerm: string,
  db: Queryable
): Promise<MerchantSpendResult | null> {
  const registry = await loadMerchantRegistry(db);
  const match = matchMerchantTerm(userTerm, registry);
  if (!match) return null;

  const spend = await getSpendingForMerchantGroup(match.group, db);
  if (!spend) return null;

  return {
    userTerm: userTerm.trim().toLowerCase(),
    canonicalName: match.group.canonicalName,
    matchedAliases: uniqueDisplayAliases(match.group),
    rawMerchants: match.group.rawMerchants,
    totalSpend: spend.totalSpend,
    transactionCount: spend.transactionCount,
    confidence: match.confidence,
  };
}

/** Resolve a merchant filter for transaction search — returns raw merchant IDs. */
export async function resolveMerchantFilter(
  userTerm: string,
  db: Queryable
): Promise<string[] | null> {
  const registry = await loadMerchantRegistry(db);
  const match = matchMerchantTerm(userTerm, registry);
  if (!match) return null;
  return match.group.rawMerchants;
}
