/**
 * Generic merchant cleaning, alias discovery, fuzzy matching, and query resolution.
 * No merchant-specific hardcoded mappings.
 */

/** Strip noise and normalize for comparison keys. */
export function cleanMerchantKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^(upi|neft|imps|rtgs)[\s/]+/gi, "");
  s = s.replace(/\*order\b/gi, " order");
  s = s.replace(/\*booking\b/gi, " booking");
  s = s.replace(/[*]/g, " ");
  s = s.replace(/[.,#]+/g, " ");
  s = s.replace(/\b(pvt|ltd|inc|corp|systems|india|online|subscription|payment|pay)\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Split merchant names into comparable tokens (camelCase, spaces, punctuation). */
export function tokenizeMerchantName(raw: string): string[] {
  const expanded = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  return cleanMerchantKey(expanded)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Build acronym from tokens, e.g. Book My Show → bms. */
export function merchantAcronym(tokens: string[]): string {
  return tokens.map((t) => t[0]!).join("");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

/** Similarity ratio 0–1 (1 = identical). */
export function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  return (longer.length - levenshtein(longer, shorter)) / longer.length;
}

export interface MerchantRecord {
  rawMerchant: string;
  normalizedMerchant: string;
  category: string;
  sampleMemos: string[];
}

export interface MerchantAliasGroup {
  canonicalName: string;
  canonicalKey: string;
  category: string;
  rawMerchants: string[];
  aliasKeys: string[];
  displayNames: string[];
}

export interface MerchantMatchResult {
  group: MerchantAliasGroup;
  confidence: "exact" | "alias" | "fuzzy" | "acronym";
  matchedKey: string;
}

const FUZZY_THRESHOLD = 0.80;
const PREFIX_MIN_LENGTH = 4;
const TOKEN_PREFIX_MIN = 3;
const ACRONYM_MIN = 2;
const ACRONYM_MAX = 6;

/** Noise markers that should disqualify a candidate canonical name. */
const CANONICAL_NOISE = /[*]|\.(COM|IN|ORG|NET)$/i;

function pickCanonicalDisplayName(names: string[]): string {
  if (names.length === 0) return "Unknown";

  // Score each candidate: penalise ALL_CAPS, noise markers, and excessive length.
  function score(name: string): number {
    let s = 0;
    if (CANONICAL_NOISE.test(name)) s -= 100;          // heavy penalty for noisy names
    if (name === name.toUpperCase()) s -= 50;           // penalty for ALL_CAPS
    if (/\//.test(name)) s -= 40;                       // penalty for NEFT/RENT/HDFC style
    s -= name.length;                                   // prefer shorter names
    return s;
  }

  const sorted = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    .sort((a, b) => score(b) - score(a));

  return sorted[0] ?? names[0] ?? "Unknown";
}

function buildRecordKeys(record: MerchantRecord): {
  cleanKeys: Set<string>;
  tokens: string[];
  acronym: string;
} {
  const names = [record.rawMerchant, record.normalizedMerchant];
  const cleanKeys = new Set<string>();
  const allTokens: string[] = [];

  for (const name of names) {
    const key = cleanMerchantKey(name);
    if (key) cleanKeys.add(key);
    allTokens.push(...tokenizeMerchantName(name));
  }

  const tokens = [...new Set(allTokens)];
  return { cleanKeys, tokens, acronym: merchantAcronym(tokens) };
}


/** True when two merchant records likely refer to the same business. */
export function merchantsLikelySame(a: MerchantRecord, b: MerchantRecord): boolean {
  const keysA = buildRecordKeys(a);
  const keysB = buildRecordKeys(b);

  const NOISE_WORDS = /\b(booking|order|transfer|pvt|ltd|inc|corp|systems|payment|pay|express|airlines|coffee|roasters)\b/gi;
  function stripNoise(s: string): string {
    return s.replace(NOISE_WORDS, " ").replace(/\s+/g, " ").trim();
  }

  for (const ka of keysA.cleanKeys) {
    for (const kb of keysB.cleanKeys) {
      if (ka.length >= 3 && ka === kb) return true;

      const short = ka.length <= kb.length ? ka : kb;
      const long = ka.length <= kb.length ? kb : ka;
      if (short.length >= PREFIX_MIN_LENGTH && long.startsWith(short)) return true;

      const kaClean = stripNoise(ka);
      const kbClean = stripNoise(kb);

      if (kaClean.length >= 3 && kbClean.length >= 3) {
        if (kaClean === kbClean) return true;
        if (
          ka.length >= PREFIX_MIN_LENGTH &&
          kb.length >= PREFIX_MIN_LENGTH &&
          similarityRatio(kaClean, kbClean) >= FUZZY_THRESHOLD
        ) {
          return true;
        }
      }
    }
  }

  const acA = keysA.acronym;
  const acB = keysB.acronym;

  if (acA.length >= ACRONYM_MIN && acA.length <= ACRONYM_MAX) {
    for (const kb of keysB.cleanKeys) {
      if (kb === acA) return true;
    }
  }
  if (acB.length >= ACRONYM_MIN && acB.length <= ACRONYM_MAX) {
    for (const ka of keysA.cleanKeys) {
      if (ka === acB) return true;
    }
  }

  const firstA = keysA.tokens[0];
  const firstB = keysB.tokens[0];
  if (firstA && firstB && firstA.length >= TOKEN_PREFIX_MIN && firstB.length >= TOKEN_PREFIX_MIN) {
    const short = firstA.length <= firstB.length ? firstA : firstB;
    const long = firstA.length <= firstB.length ? firstB : firstA;
    if (long.startsWith(short)) return true;
  }

  return false;
}

/** Cluster merchant records into alias groups (union-find). */
export function discoverMerchantGroups(records: MerchantRecord[]): MerchantAliasGroup[] {
  const parent = records.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }

  function union(i: number, j: number): void {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  }

  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (merchantsLikelySame(records[i]!, records[j]!)) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, MerchantRecord[]>();
  for (let i = 0; i < records.length; i++) {
    const root = find(i);
    const list = clusters.get(root) ?? [];
    list.push(records[i]!);
    clusters.set(root, list);
  }

  return Array.from(clusters.values()).map((members) => {
    const rawMerchants = [...new Set(members.map((m) => m.rawMerchant))];
    const displayNames = [
      ...new Set(members.flatMap((m) => [m.normalizedMerchant, m.rawMerchant])),
    ];
    const aliasKeys = [
      ...new Set(
        members.flatMap((m) => {
          const keys = buildRecordKeys(m);
          return [...keys.cleanKeys, ...keys.tokens, keys.acronym];
        })
      ),
    ].filter(Boolean);

    const category =
      members.map((m) => m.category).find((c) => c && c !== "uncategorized") ??
      members[0]!.category;

    const canonicalName = pickCanonicalDisplayName(displayNames);
    const canonicalKey = cleanMerchantKey(canonicalName);

    return {
      canonicalName,
      canonicalKey,
      category,
      rawMerchants,
      aliasKeys,
      displayNames,
    };
  });
}

export interface MerchantRegistry {
  groups: MerchantAliasGroup[];
  keyToGroup: Map<string, MerchantAliasGroup>;
}

/** Build a query-time registry from merchant records. */
export function buildMerchantRegistry(records: MerchantRecord[]): MerchantRegistry {
  const groups = discoverMerchantGroups(records);
  const keyToGroup = new Map<string, MerchantAliasGroup>();

  for (const group of groups) {
    keyToGroup.set(group.canonicalKey, group);
    for (const key of group.aliasKeys) {
      keyToGroup.set(key, group);
    }
    for (const name of group.displayNames) {
      keyToGroup.set(cleanMerchantKey(name), group);
    }
  }

  return { groups, keyToGroup };
}

/** Resolve a user-provided merchant term to an alias group. */
export function matchMerchantTerm(
  userTerm: string,
  registry: MerchantRegistry
): MerchantMatchResult | null {
  const term = cleanMerchantKey(userTerm.replace(/[?.!]+$/, ""));
  if (!term) return null;

  const exact = registry.keyToGroup.get(term);
  if (exact) {
    return { group: exact, confidence: "exact", matchedKey: term };
  }

  const termTokens = tokenizeMerchantName(userTerm);
  const termAcronym = merchantAcronym(termTokens);

  let best: MerchantMatchResult | null = null;
  let bestScore = 0;

  for (const group of registry.groups) {
    if (
      termAcronym.length >= ACRONYM_MIN &&
      termAcronym.length <= ACRONYM_MAX &&
      group.aliasKeys.includes(termAcronym)
    ) {
      return { group, confidence: "acronym", matchedKey: termAcronym };
    }

    for (const key of group.aliasKeys) {
      if (key === term) {
        return { group, confidence: "alias", matchedKey: key };
      }

      if (
        termAcronym.length >= ACRONYM_MIN &&
        termAcronym.length <= ACRONYM_MAX &&
        (key === termAcronym || group.aliasKeys.includes(termAcronym))
      ) {
        return { group, confidence: "acronym", matchedKey: termAcronym };
      }

      const score = similarityRatio(term, key);
      if (score >= FUZZY_THRESHOLD && score > bestScore) {
        bestScore = score;
        best = { group, confidence: "fuzzy", matchedKey: key };
      }

      if (term.length >= 3 && key.length >= 3 && (key.includes(term) || term.includes(key))) {
        const containScore = Math.min(term.length, key.length) / Math.max(term.length, key.length);
        if (containScore >= 0.75 && containScore > bestScore) {
          bestScore = containScore;
          best = { group, confidence: "fuzzy", matchedKey: key };
        }
      }
    }
  }

  return best;
}

/** Apply discovered canonical names to ingest mappings. */
export function unifyMerchantMappings(
  mappings: Array<{ raw_merchant: string; normalized_merchant: string; category: string }>,
  sampleMemos: Map<string, string[]>
): Array<{ raw_merchant: string; normalized_merchant: string; category: string }> {
  const records: MerchantRecord[] = mappings.map((m) => ({
    rawMerchant: m.raw_merchant,
    normalizedMerchant: m.normalized_merchant,
    category: m.category,
    sampleMemos: sampleMemos.get(m.raw_merchant) ?? [],
  }));

  const groups = discoverMerchantGroups(records);
  const rawToCanonical = new Map<string, string>();

  for (const group of groups) {
    for (const raw of group.rawMerchants) {
      rawToCanonical.set(raw, group.canonicalName);
    }
  }

  return mappings.map((m) => ({
    ...m,
    normalized_merchant: rawToCanonical.get(m.raw_merchant) ?? m.normalized_merchant,
  }));
}
