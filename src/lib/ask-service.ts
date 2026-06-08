import type { Pool, PoolClient } from "pg";
import { pool } from "../db/connection";
import { noopObserve } from "@mastra/core/tools";
import { fundTool } from "../mastra/tools/fund-tool";
import { portfolioTool } from "../mastra/tools/portfolio-tool";
import {
  getLargestTransaction,
  getLargestCategorySpend,
} from "./finance-queries";
import {
  extractSpendingTopic,
  resolveSemanticSpending,
} from "./category-resolver";
import { getTravelSpending } from "./insights-builder";
import { formatINR, formatCategoryLabel, formatDisplayDate } from "./format";
import {
  classifyQuestion,
  type QuestionIntent,
} from "./question-classifier";
import { validateStructuredAnswer } from "./response-validator";
import {
  buildLargestTransactionAnswer,
  buildLargestCategoryAnswer,
  buildEmptyAnswer,
  type StructuredAnswer,
} from "./ask-response-builders";

export type { StructuredAnswer } from "./ask-response-builders";
export {
  buildLargestTransactionAnswer,
  buildLargestCategoryAnswer,
  buildEmptyAnswer,
} from "./ask-response-builders";

const toolCtx = { observe: noopObserve } as any;

async function handleCategorySpending(
  question: string,
  db: Pool | PoolClient
): Promise<StructuredAnswer> {
  const topic = extractSpendingTopic(question);
  if (!topic) {
    return buildEmptyAnswer(
      question,
      "category_spending",
      "I couldn't identify which spending category you meant. Try asking, for example, \"How much did I spend on food?\""
    );
  }

  const resolved = await resolveSemanticSpending(topic, db);

  if (!resolved || resolved.totalSpend === 0) {
    return buildEmptyAnswer(
      question,
      "category_spending",
      `I couldn't find any spending related to "${formatCategoryLabel(topic)}" in your account.`
    );
  }

  const amount = resolved.totalSpend;
  const categoryLabel =
    resolved.matchedCategories.length > 0
      ? resolved.matchedCategories.map((c) => formatCategoryLabel(c)).join(" and ")
      : resolved.displayLabel;

  const exactCategoryMatch = resolved.matchedCategories.some(
    (c) => c.toLowerCase() === topic
  );

  let answer: string;
  const merchantOnly =
    resolved.matchedMerchants.length > 0 && resolved.matchedCategories.length === 0;

  if (merchantOnly && resolved.matchedMerchants.length > 1) {
    answer = `You spent ${formatINR(amount)} on ${resolved.displayLabel} across ${resolved.transactionCount} transactions.`;
  } else if (merchantOnly) {
    answer = `You spent ${formatINR(amount)} on ${resolved.displayLabel}.`;
  } else if (resolved.mappingNote && !exactCategoryMatch) {
    answer = `I found ${resolved.displayLabel}-related spending under the ${categoryLabel} categor${resolved.matchedCategories.length > 1 ? "ies" : "y"}. You spent ${formatINR(amount)}.`;
  } else {
    answer = `You spent ${formatINR(amount)} on ${resolved.displayLabel}.`;
  }

  const details =
    resolved.matchedMerchants.length > 1
      ? `Matched merchants: ${resolved.matchedMerchants.join(", ")}. Based on ${resolved.transactionCount} related transactions.`
      : resolved.mappingNote
        ? `${resolved.mappingNote} Based on ${resolved.transactionCount} related transactions.`
        : `Based on ${resolved.transactionCount} ${resolved.displayLabel} transactions in your account.`;

  return {
    question,
    answer,
    details,
    dataUsed: "Transactions",
    calculation: `Sum of ${resolved.transactionCount} related transactions totalling ${formatINR(amount)} across matched categories and merchants.`,
    source: "tool",
    metadata: {
      intent: "category_spending",
      amount,
      category: resolved.matchedCategories[0] ?? topic,
    },
  };
}

async function handleCategoryCompare(
  question: string,
  db: Pool | PoolClient
): Promise<StructuredAnswer> {
  const foodResolved = await resolveSemanticSpending("food", db);
  const travel = await getTravelSpending(db);

  const foodAmt = foodResolved?.totalSpend ?? 0;
  const travelAmt = travel.totalSpend;

  return {
    question,
    answer: `You spent ${formatINR(foodAmt)} on food and ${formatINR(travelAmt)} on travel.`,
    details: `Food had ${foodResolved?.transactionCount ?? 0} transactions; travel had ${travel.transactionCount} transactions.`,
    dataUsed: "Transactions",
    calculation: `Food total: ${formatINR(foodAmt)}. Travel total (including transport): ${formatINR(travelAmt)}. Difference: ${formatINR(Math.abs(foodAmt - travelAmt))}.`,
    source: "tool",
    metadata: {
      intent: "category_compare",
      amount: foodAmt,
      category: foodResolved?.matchedCategories[0],
    },
  };
}

async function handlePortfolioWorth(question: string): Promise<StructuredAnswer> {
  const res = (await portfolioTool.execute!({ action: "portfolio_overview" }, toolCtx)) as any;
  const overview = res?.overview;
  const amount = overview?.total_current_value ?? 0;
  const invested = overview?.total_investment ?? 0;

  return {
    question,
    answer: `Your portfolio is worth ${formatINR(amount)} today.`,
    details: `Total invested: ${formatINR(invested)}. Unrealized gains: ${formatINR(overview?.total_gains ?? 0)}.`,
    dataUsed: "Portfolio holdings",
    calculation: `Sum of current value across all fund holdings = ${formatINR(amount)}.`,
    source: "tool",
    metadata: { intent: "portfolio_worth", amount },
  };
}

async function handleBestFund(question: string): Promise<StructuredAnswer> {
  const res = (await fundTool.execute!({ action: "best_performing_fund" }, toolCtx)) as any;
  const best = res?.best_performing_fund;

  if (!best) {
    return buildEmptyAnswer(question, "best_fund", "No fund performance data is available.");
  }

  return {
    question,
    answer: `${best.fund_name} is your best-performing fund at +${best.return_pct.toFixed(2)}%.`,
    details: `NAV grew from ${formatINR(best.start_nav)} (${formatDisplayDate(best.start_date)}) to ${formatINR(best.end_nav)} (${formatDisplayDate(best.end_date)}).`,
    dataUsed: "Fund NAV history",
    calculation: `Return = ((${best.end_nav} − ${best.start_nav}) / ${best.start_nav}) × 100 = +${best.return_pct.toFixed(2)}%.`,
    source: "tool",
    metadata: { intent: "best_fund", amount: best.return_pct },
  };
}

/**
 * Answer a question using tool output as the single source of truth.
 * All response sections are derived from the same query result.
 */
export async function answerQuestion(
  question: string,
  db?: Pool | PoolClient
): Promise<StructuredAnswer> {
  const intent = classifyQuestion(question);
  const database = db ?? pool;

  let response: StructuredAnswer;

  switch (intent) {
    case "largest_transaction": {
      const txn = await getLargestTransaction(database);
      response = txn
        ? buildLargestTransactionAnswer(question, txn)
        : buildEmptyAnswer(question, intent, "No expense transactions were found in your account.");
      break;
    }
    case "largest_category": {
      const cat = await getLargestCategorySpend(database);
      response = cat
        ? buildLargestCategoryAnswer(question, cat)
        : buildEmptyAnswer(question, intent, "No spending categories were found in your account.");
      break;
    }
    case "category_spending":
      response = await handleCategorySpending(question, database);
      break;
    case "category_compare":
      response = await handleCategoryCompare(question, database);
      break;
    case "portfolio_worth":
      response = await handlePortfolioWorth(question);
      break;
    case "best_fund":
      response = await handleBestFund(question);
      break;
    default:
      throw new Error("GENERAL_QUESTION");
  }

  const validation = validateStructuredAnswer(response);
  if (!validation.valid) {
    console.error("[Ask] Response validation failed:", validation.errors, response);
    throw new Error(`INCONSISTENT_RESPONSE: ${validation.errors.join("; ")}`);
  }

  return response;
}
