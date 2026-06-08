import { Agent } from "@mastra/core/agent";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { formatCategoryLabel } from "./format";
import { matchByEmbeddings, clearEmbeddingCache } from "./embedding-matcher";
import {
  buildSpendingIndex,
  clearSpendingIndexCache,
  matchByTransactionText,
} from "./spending-index";
import { clearMerchantRegistryCache } from "./merchant-service";

type Queryable = Pool | PoolClient;

export interface MerchantVocabularyRow {
  normalizedMerchant: string;
  category: string;
  totalSpend: number;
  transactionCount: number;
}

export interface SemanticMatch {
  categories: string[];
  merchantTerms: string[];
  confidence: "high" | "medium" | "low";
  reasoning: string | null;
  source: "memo" | "text" | "embedding" | "llm";
}

const MatchSchema = z.object({
  matched_categories: z.array(z.string()),
  merchant_search_terms: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string().optional(),
});

const matchCache = new Map<string, SemanticMatch>();

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[?.!]+$/, "");
}

function hasGoogleApiKey(): boolean {
  return !!(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY);
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

/** Top merchants by spend — used as LLM context for semantic matching. */
export async function listMerchantVocabulary(
  db: Queryable,
  limit = 80
): Promise<MerchantVocabularyRow[]> {
  return withClient(db, async (client) => {
    const res = await client.query(
      `
      SELECT
        m.normalized_merchant,
        m.category,
        COALESCE(SUM(t.amount), 0)::numeric AS total_spend,
        COUNT(*)::int AS transaction_count
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE m.category !~* 'transfer'
        AND t.category !~* 'transfer'
      GROUP BY m.normalized_merchant, m.category
      ORDER BY total_spend DESC
      LIMIT $1
      `,
      [limit]
    );

    return res.rows.map((row) => ({
      normalizedMerchant: row.normalized_merchant,
      category: row.category,
      totalSpend: parseFloat(row.total_spend),
      transactionCount: row.transaction_count,
    }));
  });
}

function buildCacheKey(userTerm: string, categories: string[]): string {
  return `${normalizeTerm(userTerm)}::${categories.sort().join(",")}`;
}

function filterToVocabulary(
  match: z.infer<typeof MatchSchema>,
  categories: string[]
): SemanticMatch {
  const categorySet = new Set(categories.map((c) => c.toLowerCase()));
  const validCategories = match.matched_categories.filter((c) =>
    categorySet.has(c.toLowerCase())
  );

  const validTerms = match.merchant_search_terms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  return {
    categories: validCategories,
    merchantTerms: validTerms,
    confidence: match.confidence,
    reasoning: match.reasoning ?? null,
    source: "llm",
  };
}

async function matchWithLlm(
  term: string,
  categories: string[],
  merchants: MerchantVocabularyRow[]
): Promise<SemanticMatch | null> {
  if (!hasGoogleApiKey()) return null;

  const merchantLines = merchants
    .slice(0, 60)
    .map(
      (m) =>
        `- ${m.normalizedMerchant} (${m.category}, ${m.transactionCount} txns)`
    )
    .join("\n");

  const agent = new Agent({
    id: "semantic-matcher",
    name: "Semantic Spending Matcher",
    model: "google/gemini-2.5-flash-lite",
    instructions:
      "You map natural-language spending topics to categories and merchants in a user's financial data. Only return labels and merchant substrings that exist in the lists provided.",
  });

  const prompt = `A user asked how much they spent on: "${formatCategoryLabel(term)}"

Categories in their account (use only these exact labels):
${categories.join(", ")}

Merchants in their account (name, category, transaction count):
${merchantLines || "(none)"}

Identify which categories and merchant name substrings from the lists above relate to "${term}".

Rules:
- matched_categories must be exact labels from the category list
- Prefer merchant_search_terms for specific sub-topics
- merchant_search_terms must be substrings that appear in merchant names above
- Return empty arrays if nothing relates`;

  try {
    const res = await agent.generate(prompt, {
      structuredOutput: { schema: MatchSchema },
    });

    const parsed = res.object;
    if (!parsed) return null;

    const filtered = filterToVocabulary(parsed, categories);
    if (filtered.categories.length === 0 && filtered.merchantTerms.length === 0) {
      return null;
    }

    return filtered;
  } catch (err) {
    console.warn("[SemanticMatcher] LLM match failed:", (err as Error).message);
    return null;
  }
}

/**
 * Map a natural-language spending topic to categories and merchants using
 * memo search, data-driven text index, embeddings, then LLM as fallback.
 */
export async function matchSpendingTopic(
  userTerm: string,
  categories: string[],
  merchants: MerchantVocabularyRow[],
  db: Queryable
): Promise<SemanticMatch | null> {
  const term = normalizeTerm(userTerm);
  if (!term) return null;

  const cacheKey = buildCacheKey(term, categories);
  const cached = matchCache.get(cacheKey);
  if (cached) return cached;

  const textMatch = await matchByTransactionText(term, db);
  if (textMatch) {
    const match: SemanticMatch = {
      categories: textMatch.categories,
      merchantTerms: textMatch.merchantTerms,
      confidence: "high",
      reasoning: `Matched from transaction ${textMatch.method} search`,
      source: textMatch.method,
    };
    matchCache.set(cacheKey, match);
    return match;
  }

  const embeddingMatch = await matchByEmbeddings(term, db);
  if (embeddingMatch) {
    const match: SemanticMatch = {
      categories: embeddingMatch.categories,
      merchantTerms: embeddingMatch.merchantTerms,
      confidence: embeddingMatch.score >= 0.55 ? "high" : "medium",
      reasoning: `Matched via semantic similarity (${embeddingMatch.score.toFixed(2)})`,
      source: "embedding",
    };
    matchCache.set(cacheKey, match);
    return match;
  }

  const llmMatch = await matchWithLlm(term, categories, merchants);
  if (llmMatch) {
    matchCache.set(cacheKey, llmMatch);
    return llmMatch;
  }

  return null;
}

/** Clear cached matches (e.g. after dataset reload). */
export function clearSemanticMatchCache(): void {
  matchCache.clear();
  clearSpendingIndexCache();
  clearEmbeddingCache();
  clearMerchantRegistryCache();
}
