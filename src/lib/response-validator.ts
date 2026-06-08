import type { StructuredAnswer } from "./ask-response-builders";

const AMOUNT_PATTERN = /₹[\d,]+(?:\.\d+)?/g;

function extractAmounts(text: string): number[] {
  const matches = text.match(AMOUNT_PATTERN) ?? [];
  return matches.map((m) => {
    const num = parseFloat(m.replace(/₹|,/g, ""));
    return isNaN(num) ? -1 : num;
  });
}

function amountsMatch(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance;
}

function textContains(haystack: string, needle: string | undefined): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Validate that Answer, Details, and Calculation reference the same underlying entity.
 * Rejects responses with conflicting amounts or mismatched entities.
 */
export function validateStructuredAnswer(response: StructuredAnswer): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const { answer, details, calculation, metadata } = response;

  if (!answer?.trim()) {
    errors.push("Answer is empty");
  }

  const skipAmountCheck = metadata.intent === "category_compare" || metadata.intent === "best_fund";

  if (metadata.amount != null && !skipAmountCheck) {
    const answerAmounts = extractAmounts(answer);
    const detailsAmounts = extractAmounts(details);
    const calcAmounts = extractAmounts(calculation);

    const primaryAmount = metadata.amount;

    if (answerAmounts.length === 0) {
      errors.push("Answer does not contain a currency amount");
    } else if (!answerAmounts.some((a) => amountsMatch(a, primaryAmount))) {
      errors.push(
        `Answer amount (${answerAmounts.join(", ")}) does not match metadata amount (${primaryAmount})`
      );
    }

    if (
      metadata.intent === "largest_transaction" &&
      calcAmounts.length > 0 &&
      !calcAmounts.some((a) => amountsMatch(a, primaryAmount))
    ) {
      errors.push(
        `Calculation amount (${calcAmounts.join(", ")}) does not match metadata amount (${primaryAmount})`
      );
    }
  }

  if (metadata.merchant) {
    const combined = `${answer} ${details} ${calculation}`;
    if (!textContains(combined, metadata.merchant)) {
      if (metadata.intent === "largest_transaction") {
        errors.push(`Merchant "${metadata.merchant}" not referenced consistently across sections`);
      }
    }
  }

  if (metadata.category) {
    const categoryLabel = metadata.category.replace(/_/g, " ");
    const combined = `${answer} ${details} ${calculation}`.toLowerCase();
    if (!combined.includes(categoryLabel.toLowerCase())) {
      errors.push(`Category "${metadata.category}" not referenced consistently across sections`);
    }
  }

  if (metadata.intent === "largest_transaction" && metadata.merchant && metadata.amount != null) {
    const calcLower = calculation.toLowerCase();
    if (calcLower.includes("category") && !calcLower.includes("transaction")) {
      errors.push("Calculation references category logic for a largest-transaction question");
    }
  }

  if (metadata.intent === "largest_category" && metadata.amount != null) {
    const answerAmounts = extractAmounts(answer);
    if (answerAmounts.length > 0 && !answerAmounts.some((a) => amountsMatch(a, metadata.amount!))) {
      errors.push("Largest category answer amount does not match category total");
    }
  }

  return { valid: errors.length === 0, errors };
}
