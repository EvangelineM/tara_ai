import type { Pool, PoolClient } from "pg";
import { formatINR, formatCategoryLabel } from "./format";
import { resolveSemanticSpending } from "./category-resolver";

type Queryable = Pool | PoolClient;

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

/** Build insight strings from full-database aggregates (same source as dashboard). */
export async function buildInsights(data: {
  overview?: { overall_return_pct?: number } | null;
  categories?: { category: string; total_spending: number }[];
  monthly?: { month: string; total_spending: number }[];
  best_fund?: { fund_name: string; return_pct: number } | null;
}, db?: Queryable): Promise<string[]> {
  const insights: string[] = [];
  const monthly = data.monthly || [];
  const categories = data.categories || [];
  const overview = data.overview || {};
  const bestFund = data.best_fund;

  if (db) {
    const foodMonths = await getCategoryMonthlySpending(/food/i, db);
    if (foodMonths.length >= 2) {
      const curr = foodMonths[foodMonths.length - 1];
      const prev = foodMonths[foodMonths.length - 2];
      if (prev.amount > 0) {
        const pct = ((curr.amount - prev.amount) / prev.amount) * 100;
        if (Math.abs(pct) >= 1) {
          const dir = pct >= 0 ? "more" : "less";
          insights.push(
            `You spent ${Math.abs(pct).toFixed(0)}% ${dir} on food in ${formatMonthLabel(curr.month)} compared to the previous month.`
          );
        }
      }
    }
  }

  if (insights.length === 0 && monthly.length >= 2) {
    const curr = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    if (prev.total_spending > 0) {
      const pct = ((curr.total_spending - prev.total_spending) / prev.total_spending) * 100;
      const dir = pct >= 0 ? "more" : "less";
      insights.push(
        `You spent ${Math.abs(pct).toFixed(0)}% ${dir} overall in ${formatMonthLabel(curr.month)} compared to the previous month.`
      );
    }
  }

  if (categories[0]) {
    insights.push(
      `${formatCategoryLabel(categories[0].category)} was your largest expense category at ${formatINR(categories[0].total_spending)}.`
    );
  }

  if (db) {
    const food = await resolveSemanticSpending("food", db);
    const travel = await getTravelSpending(db);
    if (food && travel.totalSpend > 0) {
      insights.push(
        `Food spending totalled ${formatINR(food.totalSpend)} while travel accounted for ${formatINR(travel.totalSpend)}.`
      );
    }
  }

  if (overview.overall_return_pct != null) {
    const sign = overview.overall_return_pct >= 0 ? "+" : "";
    insights.push(
      `Your portfolio gained ${sign}${overview.overall_return_pct.toFixed(1)}% on your total investment.`
    );
  }

  if (bestFund) {
    insights.push(
      `${bestFund.fund_name} is your best-performing investment at +${bestFund.return_pct.toFixed(1)}% return.`
    );
  }

  const totalSpend = categories.reduce((s, c) => s + c.total_spending, 0);
  if (totalSpend > 0 && categories[0]) {
    const share = ((categories[0].total_spending / totalSpend) * 100).toFixed(0);
    insights.push(
      `${formatCategoryLabel(categories[0].category)} represents ${share}% of your total tracked spending.`
    );
  }

  return insights.slice(0, 6);
}

function categoryFromPattern(pattern: RegExp): string {
  const src = pattern.source.replace(/^\^|\$$/g, "").replace(/\\/g, "");
  return src.toLowerCase();
}

async function getCategoryMonthlySpending(
  pattern: RegExp,
  db: Queryable
): Promise<{ month: string; amount: number }[]> {
  const client = "query" in db ? db : await db.connect();
  const ownsClient = !("query" in db);

  try {
    const res = await client.query(
      `
      SELECT
        TO_CHAR(t.date, 'YYYY-MM') AS month,
        COALESCE(SUM(t.amount), 0)::numeric AS amount
      FROM transactions t
      JOIN merchant_mappings m ON t.merchant = m.raw_merchant
      WHERE t.category !~* 'transfer'
        AND m.category !~* 'transfer'
        AND LOWER(m.category) = LOWER($1)
      GROUP BY month
      ORDER BY month ASC
      `,
      [categoryFromPattern(pattern)]
    );

    return res.rows.map((row) => ({
      month: row.month,
      amount: parseFloat(row.amount),
    }));
  } finally {
    if (ownsClient) (client as PoolClient).release();
  }
}

export async function getTravelSpending(db: Queryable) {
  const resolved = await resolveSemanticSpending("transport", db);
  return {
    totalSpend: resolved?.totalSpend ?? 0,
    transactionCount: resolved?.transactionCount ?? 0,
  };
}
