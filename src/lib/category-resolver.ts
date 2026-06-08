import type { Pool, PoolClient } from "pg";
import { formatCategoryLabel } from "./format";
import { listMerchantVocabulary, matchSpendingTopic } from "./semantic-matcher";
import { topicSearchPatterns } from "./spending-index";
import {
  loadMerchantRegistry,
  resolveMerchantSpending,
} from "./merchant-service";
import { cleanMerchantKey, matchMerchantTerm } from "./merchant-resolver";

type Queryable = Pool | PoolClient;

export interface CategorySpendRow {
  category: string;
  totalSpend: number;
  transactionCount: number;
}

export interface ResolvedSpending {
  userTerm: string;
  displayLabel: string;
  matchedCategories: string[];
  matchedMerchants: string[];
  totalSpend: number;
  transactionCount: number;
  resolutionMethod: "direct" | "semantic" | "merchant";
  mappingNote: string | null;
}

const EXCLUDE_TRANSFERS = `
  AND t.category !~* 'transfer'
  AND m.category !~* 'transfer'
`;

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

/** All category totals in the dataset. */
export async function listCategorySpending(db?: Queryable): Promise<CategorySpendRow[]> {
  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  return withClient(db, async (client) => {
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
      ORDER BY total_spend DESC
      `
    );

    return res.rows.map((row) => ({
      category: row.category,
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    }));
  });
}

/** Spending for explicit category names (summed). */
export async function getSpendingForCategories(
  categories: string[],
  db?: Queryable
): Promise<CategorySpendRow | null> {
  if (!categories.length) return null;

  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE m.category = ANY($1::text[])
      ${EXCLUDE_TRANSFERS}
      `,
      [categories]
    );

    const row = res.rows[0];
    if (!row || parseFloat(row.total_spend) === 0) return null;

    return {
      category: categories.length === 1 ? categories[0] : categories.join(" + "),
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    };
  });
}

/** Spending matched by merchant name patterns. */
export async function getSpendingByMerchants(
  merchantPatterns: RegExp[],
  db?: Queryable
): Promise<CategorySpendRow | null> {
  if (!merchantPatterns.length) return null;

  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  const conditions = merchantPatterns
    .map((_, i) => `m.normalized_merchant ~* $${i + 1}`)
    .join(" OR ");

  const patterns = merchantPatterns.map((p) => p.source.replace(/^\^|\$$/g, ""));

  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE (${conditions})
      ${EXCLUDE_TRANSFERS}
      `,
      patterns
    );

    const row = res.rows[0];
    if (!row || parseFloat(row.total_spend) === 0) return null;

    return {
      category: "merchant_match",
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    };
  });
}

/**
 * Sum spending where merchants/categories match AND transaction text
 * (memo or merchant name) contains evidence of the user topic.
 */
export async function getSpendingWithTopicEvidence(
  userTerm: string,
  categories: string[],
  merchantTerms: string[],
  db?: Queryable
): Promise<CategorySpendRow | null> {
  const patterns = topicSearchPatterns(userTerm);
  if (!patterns.length) return null;
  if (!categories.length && !merchantTerms.length) return null;

  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  const params: (string | string[])[] = [...patterns];
  let paramIndex = patterns.length + 1;

  const targetClauses: string[] = [];
  if (categories.length > 0) {
    targetClauses.push(`m.category = ANY($${paramIndex}::text[])`);
    params.push(categories);
    paramIndex++;
  }
  for (const term of merchantTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    targetClauses.push(
      `(m.normalized_merchant ~* $${paramIndex} OR t.merchant ~* $${paramIndex})`
    );
    params.push(escaped);
    paramIndex++;
  }

  const topicClauses = patterns.map(
    (_, i) =>
      `(t.memo ILIKE $${i + 1} OR m.normalized_merchant ILIKE $${i + 1} OR t.merchant ILIKE $${i + 1})`
  );

  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE (${targetClauses.join(" OR ")})
      AND (${topicClauses.join(" OR ")})
      ${EXCLUDE_TRANSFERS}
      `,
      params
    );

    const row = res.rows[0];
    if (!row || parseFloat(row.total_spend) === 0) return null;

    return {
      category: "topic_match",
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    };
  });
}

/** Combined spending for semantic matches (no double-counting across OR branches). */
export async function getSpendingForSemanticMatch(
  categories: string[],
  merchantTerms: string[],
  db?: Queryable
): Promise<CategorySpendRow | null> {
  if (!categories.length && !merchantTerms.length) return null;

  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  const clauses: string[] = [];
  const params: (string | string[])[] = [];
  let paramIndex = 1;

  if (categories.length > 0) {
    clauses.push(`m.category = ANY($${paramIndex}::text[])`);
    params.push(categories);
    paramIndex++;
  }

  for (const term of merchantTerms) {
    const registry = await loadMerchantRegistry(db!);
    const match = matchMerchantTerm(term, registry);

    if (match) {
      clauses.push(`t.merchant = ANY($${paramIndex}::text[])`);
      params.push(match.group.rawMerchants);
      paramIndex++;
      continue;
    }

    const escaped = cleanMerchantKey(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clauses.push(
      `(m.normalized_merchant ~* $${paramIndex} OR t.merchant ~* $${paramIndex})`
    );
    params.push(escaped);
    paramIndex++;
  }

  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE (${clauses.join(" OR ")})
      ${EXCLUDE_TRANSFERS}
      `,
      params
    );

    const row = res.rows[0];
    if (!row || parseFloat(row.total_spend) === 0) return null;

    return {
      category: "semantic_match",
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    };
  });
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[?.!]+$/, "");
}

/** Extract spending topic from a natural-language question. */
export function extractSpendingTopic(question: string): string | null {
  const patterns = [
    /how much did i spend on (.+)/i,
    /how much have i spent on (.+)/i,
    /how much do i spend on (.+)/i,
    /what did i spend on (.+)/i,
    /spending on (.+)/i,
    /spent on (.+)/i,
    /spend on (.+)/i,
  ];

  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match?.[1]) {
      return normalizeTerm(match[1]);
    }
  }

  return null;
}

function pickCategoriesDirect(rows: CategorySpendRow[], userTerm: string): string[] {
  const direct = rows.filter(
    (row) =>
      row.category.toLowerCase() === userTerm ||
      row.category.toLowerCase().includes(userTerm) ||
      userTerm.includes(row.category.toLowerCase())
  );
  return direct.map((row) => row.category);
}

function buildMappingNote(
  userTerm: string,
  matchedCategories: string[],
  matchedMerchants: string[],
  method: ResolvedSpending["resolutionMethod"]
): string | null {
  const userLabel = formatCategoryLabel(userTerm);

  if (method === "direct") {
    const exact = matchedCategories.some((c) => c.toLowerCase() === normalizeTerm(userTerm));
    if (exact && matchedCategories.length === 1) return null;
  }

  if (method === "merchant" || matchedMerchants.length > 0) {
    const names = matchedMerchants.map((m) => formatCategoryLabel(m)).join(", ");
    if (matchedCategories.length === 0) {
      return `Matched "${userLabel}" to merchants including ${names}.`;
    }
    const categoryLabels = matchedCategories.map((c) => formatCategoryLabel(c)).join(" and ");
    return `Mapped "${userLabel}" to ${categoryLabels} and merchants including ${names}.`;
  }

  if (matchedCategories.length === 1) {
    return `Mapped "${userLabel}" to the ${formatCategoryLabel(matchedCategories[0])} category in your records.`;
  }

  if (matchedCategories.length > 1) {
    const categoryLabels = matchedCategories.map((c) => formatCategoryLabel(c)).join(" and ");
    return `Mapped "${userLabel}" to ${categoryLabels} categories in your records.`;
  }

  return null;
}

/**
 * Resolve spending for a user term using direct label match, then Gemini semantic
 * matching against categories and merchants in the user's actual data.
 */
export async function resolveSemanticSpending(
  userTerm: string,
  db?: Queryable
): Promise<ResolvedSpending | null> {
  if (!db) {
    const { pool } = await import("../db/connection");
    db = pool;
  }

  const term = normalizeTerm(userTerm);

  const merchantSpend = await resolveMerchantSpending(term, db);
  if (merchantSpend) {
    return {
      userTerm: term,
      displayLabel: merchantSpend.canonicalName,
      matchedCategories: [],
      matchedMerchants: merchantSpend.matchedAliases,
      totalSpend: merchantSpend.totalSpend,
      transactionCount: merchantSpend.transactionCount,
      resolutionMethod: "merchant",
      mappingNote:
        merchantSpend.matchedAliases.length > 1
          ? `Aggregated spending across aliases: ${merchantSpend.matchedAliases.join(", ")}.`
          : null,
    };
  }

  const allCategories = await listCategorySpending(db);
  const categoryLabels = allCategories.map((row) => row.category);

  const directCategories = pickCategoriesDirect(allCategories, term);
  if (directCategories.length > 0) {
    const result = await getSpendingForCategories(directCategories, db);
    if (result && result.totalSpend !== 0) {
      return {
        userTerm: term,
        displayLabel: formatCategoryLabel(term).toLowerCase(),
        matchedCategories: directCategories,
        matchedMerchants: [],
        totalSpend: result.totalSpend,
        transactionCount: result.transactionCount,
        resolutionMethod: "direct",
        mappingNote: buildMappingNote(term, directCategories, [], "direct"),
      };
    }
  }

  const merchants = await listMerchantVocabulary(db);
  const semantic = await matchSpendingTopic(term, categoryLabels, merchants, db);

  if (!semantic) {
    const registry = await loadMerchantRegistry(db);
    const fuzzy = matchMerchantTerm(term, registry);
    if (fuzzy) {
      const merchantSpend = await resolveMerchantSpending(term, db);
      if (merchantSpend) {
        return {
          userTerm: term,
          displayLabel: merchantSpend.canonicalName,
          matchedCategories: [],
          matchedMerchants: merchantSpend.matchedAliases,
          totalSpend: merchantSpend.totalSpend,
          transactionCount: merchantSpend.transactionCount,
          resolutionMethod: "merchant",
          mappingNote:
            merchantSpend.matchedAliases.length > 1
              ? `Aggregated spending across aliases: ${merchantSpend.matchedAliases.join(", ")}.`
              : null,
        };
      }
    }

    const literalMerchant = await getSpendingByMerchants(
      [new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")],
      db
    );
    if (!literalMerchant) return null;

    return {
      userTerm: term,
      displayLabel: formatCategoryLabel(term).toLowerCase(),
      matchedCategories: [],
      matchedMerchants: [term],
      totalSpend: literalMerchant.totalSpend,
      transactionCount: literalMerchant.transactionCount,
      resolutionMethod: "merchant",
      mappingNote: buildMappingNote(term, [], [term], "merchant"),
    };
  }

  const termMatchesCategory = semantic.categories.some(
    (c) =>
      c.toLowerCase() === term ||
      c.toLowerCase().includes(term) ||
      term.includes(c.toLowerCase())
  );

  const useTopicEvidence =
    semantic.source === "memo" || semantic.source === "text";

  let result: CategorySpendRow | null = null;
  let usedCategories = semantic.categories;
  let usedMerchants = semantic.merchantTerms;
  let method: ResolvedSpending["resolutionMethod"] = "semantic";

  if (useTopicEvidence) {
    if (semantic.merchantTerms.length > 0 && !termMatchesCategory) {
      result = await getSpendingWithTopicEvidence(
        term,
        [],
        semantic.merchantTerms,
        db
      );
      usedCategories = [];
      method = "merchant";
    } else if (semantic.categories.length > 0) {
      result = await getSpendingWithTopicEvidence(
        term,
        semantic.categories,
        [],
        db
      );
      usedMerchants = [];
      method = "semantic";
    } else if (semantic.merchantTerms.length > 0) {
      result = await getSpendingWithTopicEvidence(
        term,
        [],
        semantic.merchantTerms,
        db
      );
      usedCategories = [];
      method = "merchant";
    }
  } else {
    const merchantResult =
      semantic.merchantTerms.length > 0
        ? await getSpendingForSemanticMatch([], semantic.merchantTerms, db)
        : null;

    const categoryResult =
      semantic.categories.length > 0
        ? await getSpendingForSemanticMatch(semantic.categories, [], db)
        : null;

    if (merchantResult && categoryResult) {
      if (termMatchesCategory) {
        result = categoryResult;
        usedMerchants = [];
        method = "semantic";
      } else {
        result = merchantResult;
        usedCategories = [];
        method = "merchant";
      }
    } else if (merchantResult) {
      result = merchantResult;
      usedCategories = [];
      method = "merchant";
    } else if (categoryResult) {
      result = categoryResult;
      usedMerchants = [];
      method = "semantic";
    }
  }

  if (!result || result.totalSpend === 0) return null;

  return {
    userTerm: term,
    displayLabel: formatCategoryLabel(term).toLowerCase(),
    matchedCategories: usedCategories,
    matchedMerchants: usedMerchants,
    totalSpend: result.totalSpend,
    transactionCount: result.transactionCount,
    resolutionMethod: method,
    mappingNote: buildMappingNote(term, usedCategories, usedMerchants, method),
  };
}
