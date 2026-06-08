import type { SpendingFacet, SpendingIndex } from "./spending-index";
import { buildSpendingIndex, facetEmbeddingText } from "./spending-index";

export interface EmbeddingMatchResult {
  categories: string[];
  merchantTerms: string[];
  score: number;
}

const embeddingCache = new Map<string, number[]>();
let facetEmbeddingCache: Map<string, number[]> | null = null;

function getApiKey(): string | null {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const EMBEDDING_MODEL = "gemini-embedding-001";

async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = getApiKey();
  if (!apiKey || texts.length === 0) return [];

  const uncached: { text: string; index: number }[] = [];
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const cached = embeddingCache.get(text);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ text, index: i });
    }
  }

  if (uncached.length === 0) return results;

  const batchSize = 20;
  for (let i = 0; i < uncached.length; i += batchSize) {
    const batch = uncached.slice(i, i + batchSize);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: batch.map((item) => ({
              model: `models/${EMBEDDING_MODEL}`,
              content: { parts: [{ text: item.text }] },
              taskType: "SEMANTIC_SIMILARITY",
            })),
          }),
        }
      );

      if (!response.ok) {
        const body = await response.text();
        console.warn(
          `[EmbeddingMatcher] API error ${response.status}: ${body.slice(0, 200)}`
        );
        return results.filter(Boolean).length > 0 ? results : [];
      }

      const data = (await response.json()) as {
        embeddings?: { values: number[] }[];
      };

      for (let j = 0; j < batch.length; j++) {
        const values = data.embeddings?.[j]?.values;
        if (!values) continue;
        const { text, index } = batch[j]!;
        embeddingCache.set(text, values);
        results[index] = values;
      }
    } catch (err) {
      console.warn("[EmbeddingMatcher] Request failed:", (err as Error).message);
      return results.filter(Boolean).length > 0 ? results : [];
    }
  }

  return results;
}

async function embedText(text: string): Promise<number[] | null> {
  const [vector] = await embedTexts([text]);
  return vector ?? null;
}

async function ensureFacetEmbeddings(index: SpendingIndex): Promise<Map<string, number[]>> {
  if (facetEmbeddingCache) return facetEmbeddingCache;

  const facets = index.facets.filter((f) => f.totalSpend > 0);
  const texts = facets.map(facetEmbeddingText);
  const vectors = await embedTexts(texts);

  const map = new Map<string, number[]>();
  for (let i = 0; i < facets.length; i++) {
    const vector = vectors[i];
    if (vector) {
      map.set(`${facets[i]!.kind}:${facets[i]!.category}:${facets[i]!.merchant ?? ""}`, vector);
    }
  }

  facetEmbeddingCache = map;
  return map;
}

function merchantSearchTerm(facet: SpendingFacet): string | null {
  if (!facet.merchant) return null;
  const name = facet.merchant.toLowerCase();
  const token = name.split(/[^a-z0-9]+/).find((t) => t.length >= 3);
  return token ?? name.slice(0, 12);
}

/**
 * Match a spending topic to categories/merchants via embedding similarity.
 * Uses separate embedding quota from generateContent.
 */
export async function matchByEmbeddings(
  userTerm: string,
  db: Parameters<typeof buildSpendingIndex>[0]
): Promise<EmbeddingMatchResult | null> {
  const term = userTerm.trim().toLowerCase().replace(/[?.!]+$/, "");
  if (!term || !getApiKey()) return null;

  try {
  const index = await buildSpendingIndex(db);
  const queryVector = await embedText(`How much did I spend on ${term}?`);
  if (!queryVector) return null;

  let facetVectors: Map<string, number[]>;
  try {
    facetVectors = await ensureFacetEmbeddings(index);
  } catch (err) {
    console.warn("[EmbeddingMatcher] Failed to build facet embeddings:", (err as Error).message);
    return null;
  }

  const scored = index.facets
    .filter((f) => f.totalSpend > 0)
    .map((facet) => {
      const key = `${facet.kind}:${facet.category}:${facet.merchant ?? ""}`;
      const vector = facetVectors.get(key);
      if (!vector) return { facet, score: 0 };
      return { facet, score: cosineSimilarity(queryVector, vector) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const topScore = scored[0]!.score;
  if (topScore < 0.42) return null;

  const winners = scored.filter((item) => item.score >= topScore - 0.04);

  const categories = [
    ...new Set(
      winners.filter((w) => w.facet.kind === "category").map((w) => w.facet.category)
    ),
  ];

  const merchantTerms = [
    ...new Set(
      winners
        .filter((w) => w.facet.kind === "merchant")
        .map((w) => merchantSearchTerm(w.facet))
        .filter((t): t is string => !!t)
    ),
  ];

  if (categories.length === 0 && merchantTerms.length === 0) return null;

  return { categories, merchantTerms, score: topScore };
  } catch (err) {
    console.warn("[EmbeddingMatcher] Match failed:", (err as Error).message);
    return null;
  }
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
  facetEmbeddingCache = null;
}
