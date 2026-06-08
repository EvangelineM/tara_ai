import type { LargestTransaction, LargestCategorySpend } from "./finance-queries";
import { formatINR, formatCategoryLabel, formatDisplayDate } from "./format";
import type { QuestionIntent } from "./question-classifier";

export interface StructuredAnswer {
  question: string;
  answer: string;
  details: string;
  dataUsed: string;
  calculation: string;
  source: "tool";
  metadata: {
    intent: QuestionIntent;
    amount?: number;
    merchant?: string;
    category?: string;
    date?: string;
  };
}

export function buildLargestTransactionAnswer(
  question: string,
  txn: LargestTransaction
): StructuredAnswer {
  const categoryLabel = formatCategoryLabel(txn.category);
  const amount = txn.amount;

  return {
    question,
    answer: `Your largest single transaction was ${formatINR(amount)} for ${categoryLabel}.`,
    details: `This transaction occurred on ${formatDisplayDate(txn.date)} at ${txn.merchant} and was categorized as ${categoryLabel}.`,
    dataUsed: "Transactions",
    calculation: `Largest transaction identified by sorting all positive transactions by amount descending and selecting the highest value (${formatINR(amount)} at ${txn.merchant} on ${formatDisplayDate(txn.date)}).`,
    source: "tool",
    metadata: {
      intent: "largest_transaction",
      amount,
      merchant: txn.merchant,
      category: txn.category,
      date: txn.date,
    },
  };
}

export function buildLargestCategoryAnswer(
  question: string,
  cat: LargestCategorySpend
): StructuredAnswer {
  const categoryLabel = formatCategoryLabel(cat.category);
  const amount = cat.totalSpend;

  return {
    question,
    answer: `Your largest spending category was ${categoryLabel} with total spending of ${formatINR(amount)}.`,
    details: `Across all transactions, ${categoryLabel} accounts for the highest cumulative spend at ${formatINR(amount)}.`,
    dataUsed: "Transactions",
    calculation: `Categories ranked by SUM(amount) for all positive transactions, excluding transfers. ${categoryLabel} ranked first at ${formatINR(amount)}.`,
    source: "tool",
    metadata: {
      intent: "largest_category",
      amount,
      category: cat.category,
    },
  };
}

export function buildEmptyAnswer(
  question: string,
  intent: QuestionIntent,
  message: string
): StructuredAnswer {
  return {
    question,
    answer: message,
    details: "No matching records were found in your transaction history.",
    dataUsed: "Transactions",
    calculation: "Query returned no matching records.",
    source: "tool",
    metadata: { intent },
  };
}
