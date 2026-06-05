/** Generic merchant-name noise patterns (payment rails, not merchant-specific). */
const MERCHANT_NOISE_PATTERNS: RegExp[] = [
  /\*ORDER\b/gi,
  /\*BOOKING\b/gi,
  /\.COM\b/gi,
  /\bPVT\.?\b/gi,
  /\bLTD\.?\b/gi,
  /\bSYSTEMS\b/gi,
  /^(UPI|NEFT|IMPS|RTGS)\//gi,
];

/** Generic suffix tokens stripped when building clustering signatures. */
const SIGNATURE_SUFFIXES = /(?:order|booking|india|systems|pvt|ltd|corp|inc)$/i;

/** Generic text hints mapped to category labels present in the dataset. */
const CATEGORY_HINTS: Array<{ pattern: RegExp; labels: string[] }> = [
  { pattern: /\b(self[\s-]?transfer|account[\s-]?transfer|transfer)\b/i, labels: ["transfer"] },
  { pattern: /\brent\b/i, labels: ["rent"] },
  { pattern: /\brefund\b/i, labels: ["refund"] },
  { pattern: /\bsubscription\b/i, labels: ["subscription"] },
];

export type MerchantInput = {
  raw_merchant: string;
  categories: string[];
  memos: string[];
};

export type MerchantMapping = {
  raw_merchant: string;
  normalized_merchant: string;
  category: string;
};

/** Strip payment-rail noise and normalize casing without merchant-specific rules. */
export function cleanMerchantName(raw: string): string {
  let cleaned = raw.trim();
  for (const pattern of MERCHANT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return raw.trim();
  }

  if (cleaned === cleaned.toUpperCase() && cleaned.length > 2) {
    cleaned = cleaned
      .split(/[\s*]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  return cleaned;
}

/** Build a fuzzy grouping key from the primary token in a merchant name. */
export function merchantSignature(raw: string): string {
  const cleaned = cleanMerchantName(raw).toLowerCase();
  const tokens = cleaned.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);

  if (tokens.length === 0) {
    return cleaned.replace(/[^a-z0-9]/g, "");
  }

  return tokens[0].replace(SIGNATURE_SUFFIXES, "");
}

/** Collect non-empty category labels already present in the dataset. */
export function collectCategoryVocabulary(
  transactions: Array<{ category?: string }>
): string[] {
  const categories = new Set<string>();
  for (const tx of transactions) {
    if (tx.category && tx.category !== "uncategorized") {
      categories.add(tx.category);
    }
  }
  return Array.from(categories).sort();
}

function pickCanonicalName(variants: string[]): string {
  const counts = new Map<string, number>();
  for (const variant of variants) {
    const cleaned = cleanMerchantName(variant);
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }

  let best = variants[0];
  let bestCount = -1;
  for (const [name, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && name.length < best.length)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function modeCategory(categories: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const category of categories) {
    if (category && category !== "uncategorized") {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [category, count] of counts.entries()) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

function inferCategoryFromHints(
  merchant: string,
  memos: string[],
  vocabulary: string[]
): string | undefined {
  const haystack = [merchant, ...memos].join(" ").toLowerCase();
  const vocab = new Set(vocabulary.map((c) => c.toLowerCase()));

  for (const hint of CATEGORY_HINTS) {
    if (!hint.pattern.test(haystack)) {
      continue;
    }
    for (const label of hint.labels) {
      if (vocab.has(label.toLowerCase())) {
        return vocabulary.find((c) => c.toLowerCase() === label.toLowerCase());
      }
    }
  }

  return undefined;
}

function resolveCategory(
  item: MerchantInput,
  vocabulary: string[]
): string {
  const fromData = modeCategory(item.categories);
  if (fromData) {
    return fromData;
  }

  const fromHints = inferCategoryFromHints(item.raw_merchant, item.memos, vocabulary);
  if (fromHints) {
    return fromHints;
  }

  if (vocabulary.includes("uncategorized")) {
    return "uncategorized";
  }

  return "uncategorized";
}

/** Cluster aliases by signature and assign categories from dataset vocabulary. */
export function normalizeMerchantsFallback(
  merchants: MerchantInput[],
  categoryVocabulary: string[]
): MerchantMapping[] {
  const vocabulary =
    categoryVocabulary.length > 0
      ? categoryVocabulary
      : ["uncategorized"];

  const clusters = new Map<string, string[]>();
  for (const item of merchants) {
    const signature = merchantSignature(item.raw_merchant) || item.raw_merchant.toLowerCase();
    const group = clusters.get(signature) ?? [];
    group.push(item.raw_merchant);
    clusters.set(signature, group);
  }

  const canonicalByRaw = new Map<string, string>();
  for (const variants of clusters.values()) {
    const canonical = pickCanonicalName(variants);
    for (const raw of variants) {
      canonicalByRaw.set(raw, canonical);
    }
  }

  return merchants.map((item) => ({
    raw_merchant: item.raw_merchant,
    normalized_merchant: canonicalByRaw.get(item.raw_merchant) ?? cleanMerchantName(item.raw_merchant),
    category: resolveCategory(item, vocabulary),
  }));
}

/** Build a dataset-driven LLM prompt with no hardcoded merchant or category examples. */
export function buildNormalizationPrompt(
  merchants: MerchantInput[],
  categoryVocabulary: string[]
): string {
  const categories =
    categoryVocabulary.length > 0
      ? categoryVocabulary.join(", ")
      : "uncategorized";

  return `You are cleaning financial transaction data imported from an unknown dataset.

Tasks:
1. Normalize each raw merchant name into a single canonical display name.
2. Merge obvious aliases that refer to the same merchant.
3. Assign each merchant exactly one category using ONLY labels from this dataset vocabulary: ${categories}
4. Prefer category labels already associated with the merchant in the raw data when they fit.
5. Treat internal account movements as a transfer-type category only if that label exists in the vocabulary.

Return one mapping per raw merchant in the input list.

Raw merchants:
${JSON.stringify(merchants, null, 2)}`;
}

/** Categories that represent non-spending movements (pattern-based, not dataset-specific). */
export function isTransferCategory(category: string | null | undefined): boolean {
  return !!category && /\btransfer\b/i.test(category);
}
