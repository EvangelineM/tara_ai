import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export interface SpendingFacet {
  kind: "category" | "merchant";
  category: string;
  merchant: string | null;
  searchText: string;
  totalSpend: number;
  transactionCount: number;
}

export interface SpendingIndex {
  facets: SpendingFacet[];
  categories: string[];
}

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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[?.!]+$/, "");
}

/** ILIKE patterns for a topic, including simple singular/plural variants. */
export function topicSearchPatterns(userTerm: string): string[] {
  const term = normalizeTerm(userTerm).replace(/[%_]/g, "");
  if (!term) return [];

  const patterns = new Set<string>([`%${term}%`]);
  if (term.endsWith("s") && term.length > 3) {
    patterns.add(`%${term.slice(0, -1)}%`);
  } else {
    patterns.add(`%${term}s%`);
  }
  return [...patterns];
}

let indexCache: SpendingIndex | null = null;

/** Build a searchable index from categories, merchants, and transaction memos. */
export async function buildSpendingIndex(db: Queryable): Promise<SpendingIndex> {
  if (indexCache) return indexCache;

  const facets = await withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        m.category,
        m.normalized_merchant,
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count,
        string_agg(DISTINCT COALESCE(t.memo, ''), ' ' ORDER BY COALESCE(t.memo, '')) AS memos
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE m.category !~* 'transfer'
        AND t.category !~* 'transfer'
      GROUP BY m.category, m.normalized_merchant
      ORDER BY total_spend DESC
      `
    );

    const byCategory = new Map<
      string,
      { totalSpend: number; transactionCount: number; searchParts: Set<string> }
    >();

    const merchantFacets: SpendingFacet[] = [];

    for (const row of res.rows) {
      const category = row.category as string;
      const merchant = row.normalized_merchant as string;
      const memos = (row.memos as string) || "";
      const totalSpend = parseFloat(row.total_spend);
      const transactionCount = row.transaction_count as number;

      const searchText = [category, merchant, memos].join(" ").toLowerCase();
      merchantFacets.push({
        kind: "merchant",
        category,
        merchant,
        searchText,
        totalSpend,
        transactionCount,
      });

      const cat = byCategory.get(category) ?? {
        totalSpend: 0,
        transactionCount: 0,
        searchParts: new Set<string>(),
      };
      cat.totalSpend += totalSpend;
      cat.transactionCount += transactionCount;
      cat.searchParts.add(category);
      cat.searchParts.add(merchant);
      for (const token of tokenize(memos)) {
        cat.searchParts.add(token);
      }
      byCategory.set(category, cat);
    }

    const categoryFacets: SpendingFacet[] = Array.from(byCategory.entries()).map(
      ([category, data]) => ({
        kind: "category" as const,
        category,
        merchant: null,
        searchText: Array.from(data.searchParts).join(" "),
        totalSpend: data.totalSpend,
        transactionCount: data.transactionCount,
      })
    );

    return [...categoryFacets, ...merchantFacets];
  });

  const categories = [
    ...new Set(facets.filter((f) => f.kind === "category").map((f) => f.category)),
  ];

  indexCache = { facets, categories };
  return indexCache;
}

export function clearSpendingIndexCache(): void {
  indexCache = null;
}

export interface TextMatchResult {
  categories: string[];
  merchantTerms: string[];
  method: "memo" | "text";
  score: number;
}

/** Match topic against memos and indexed merchant/category text (no API). */
export async function matchByTransactionText(
  userTerm: string,
  db: Queryable
): Promise<TextMatchResult | null> {
  const term = normalizeTerm(userTerm);
  if (!term) return null;

  const patterns = topicSearchPatterns(term);
  const memoConditions = patterns
    .map(
      (_, i) =>
        `(t.memo ILIKE $${i + 1} OR m.normalized_merchant ILIKE $${i + 1} OR t.merchant ILIKE $${i + 1})`
    )
    .join(" OR ");

  const memoHits = await withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT DISTINCT
        m.category,
        m.normalized_merchant
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE (${memoConditions})
      AND m.category !~* 'transfer'
      AND t.category !~* 'transfer'
      `,
      patterns
    );
    return res.rows as { category: string; normalized_merchant: string }[];
  });

  if (memoHits.length > 0) {
    const merchantTerms = [
      ...new Set(
        memoHits.flatMap((row) => {
          const name = row.normalized_merchant.toLowerCase();
          const tokens = tokenize(name);
          return tokens.length > 0 ? [tokens[0]!] : [name.slice(0, 12)];
        })
      ),
    ];

    return {
      categories: [],
      merchantTerms,
      method: "memo",
      score: 100,
    };
  }

  const index = await buildSpendingIndex(db);
  const termTokens = tokenize(term);
  const singular = term.endsWith("s") ? term.slice(0, -1) : term;

  const scored = index.facets
    .map((facet) => {
      const haystack = facet.searchText;
      let score = 0;

      if (haystack.includes(term)) score += 80;
      if (singular !== term && haystack.includes(singular)) score += 70;

      for (const token of termTokens) {
        if (haystack.includes(token)) score += 30;
      }

      return { facet, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const top = scored[0];
  const topScore = top.score;
  const winners = scored.filter((item) => item.score >= topScore * 0.85);

  const categories = [
    ...new Set(
      winners.filter((w) => w.facet.kind === "category").map((w) => w.facet.category)
    ),
  ];

  const merchantTerms = [
    ...new Set(
      winners
        .filter((w) => w.facet.kind === "merchant" && w.facet.merchant)
        .map((w) => w.facet.merchant!.toLowerCase())
        .map((name) => {
          const token = tokenize(name)[0];
          return token && token.length >= 3 ? token : name.slice(0, 12);
        })
    ),
  ];

  if (categories.length === 0 && merchantTerms.length === 0) return null;

  return {
    categories,
    merchantTerms,
    method: "text",
    score: topScore,
  };
}

/** Text used for embedding similarity — built from live transaction data. */
export function facetEmbeddingText(facet: SpendingFacet): string {
  if (facet.kind === "category") {
    return `Spending category ${facet.category}: ${facet.searchText}`;
  }
  return `Merchant ${facet.merchant} in ${facet.category}: ${facet.searchText}`;
}
