import { extractSpendingTopic } from "./category-resolver";

export type QuestionIntent =
  | "largest_transaction"
  | "largest_category"
  | "category_spending"
  | "category_compare"
  | "portfolio_worth"
  | "best_fund"
  | "general";

const LARGEST_CATEGORY_PATTERNS = [
  /which category.*spend.*most/i,
  /largest spending category/i,
  /biggest spending category/i,
  /most spent on.*category/i,
  /top spending category/i,
  /category.*highest.*spend/i,
];

const LARGEST_TRANSACTION_PATTERNS = [
  /biggest expense/i,
  /largest expense/i,
  /biggest transaction/i,
  /largest transaction/i,
  /highest expense/i,
  /highest transaction/i,
  /largest single/i,
  /biggest single/i,
  /max(imum)? expense/i,
  /what was my (biggest|largest)/i,
];

/**
 * Classify a user question into a deterministic intent.
 * "Biggest expense" → largest single transaction unless category is explicit.
 */
export function classifyQuestion(question: string): QuestionIntent {
  const q = question.trim();

  if (LARGEST_CATEGORY_PATTERNS.some((p) => p.test(q))) {
    return "largest_category";
  }

  if (LARGEST_TRANSACTION_PATTERNS.some((p) => p.test(q))) {
    return "largest_transaction";
  }

  if (/compare/i.test(q) && (/food|travel|transport/i.test(q))) {
    return "category_compare";
  }

  if (
    /how much.*(spend|spent)/i.test(q) ||
    /what did i spend on/i.test(q) ||
    /spending on/i.test(q)
  ) {
    if (extractSpendingTopic(q)) {
      return "category_spending";
    }
  }

  if (/portfolio.*worth|worth.*portfolio|portfolio.*value|what is my portfolio/i.test(q)) {
    return "portfolio_worth";
  }

  if (/best.*fund|fund.*best|top.*fund|which fund performed/i.test(q)) {
    return "best_fund";
  }

  return "general";
}

/** @deprecated Use extractSpendingTopic + resolveSemanticSpending instead. */
export function extractSpendingCategory(question: string): RegExp | null {
  const topic = extractSpendingTopic(question);
  if (!topic) return null;
  return new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}
