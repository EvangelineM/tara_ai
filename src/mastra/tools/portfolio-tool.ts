import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "../../db/connection";

export const portfolioTool = createTool({
  id: "portfolio-tool",
  description: "Queries portfolio holdings and calculates their current values and investment returns. Use this for portfolio total value, individual holding returns, and portfolio asset allocation.",
  inputSchema: z.object({
    action: z.enum([
      "portfolio_overview",
      "holding_returns",
      "portfolio_allocation",
    ]).describe("The action to perform"),
  }),
  execute: async ({ action }) => {
    const client = await pool.connect();
    try {
      // 1. Fetch holdings with their latest NAVs
      const query = `
        WITH latest_nav AS (
          SELECT DISTINCT ON (fund_id) fund_id, nav_date, nav
          FROM fund_nav
          ORDER BY fund_id, nav_date DESC
        )
        SELECT 
          h.fund_id,
          h.fund_name,
          COALESCE(f.category, 'unknown') as category,
          h.units::numeric as units,
          h.purchase_date,
          h.purchase_nav::numeric as purchase_nav,
          (h.units * h.purchase_nav)::numeric as investment_amount,
          COALESCE(ln.nav, h.purchase_nav)::numeric as current_nav,
          ln.nav_date as current_nav_date,
          (h.units * COALESCE(ln.nav, h.purchase_nav))::numeric as current_value
        FROM holdings h
        LEFT JOIN latest_nav ln ON h.fund_id = ln.fund_id
        LEFT JOIN funds f ON h.fund_id = f.id
      `;
      const res = await client.query(query);
      const holdings = res.rows.map((row) => {
        const units = parseFloat(row.units);
        const purchase_nav = parseFloat(row.purchase_nav);
        const investment_amount = parseFloat(row.investment_amount);
        const current_nav = parseFloat(row.current_nav);
        const current_value = parseFloat(row.current_value);
        const gains = current_value - investment_amount;
        const return_pct = investment_amount > 0 ? (gains / investment_amount) * 100 : 0;

        return {
          fund_id: row.fund_id,
          fund_name: row.fund_name,
          category: row.category,
          units,
          purchase_date: row.purchase_date,
          purchase_nav,
          investment_amount: parseFloat(investment_amount.toFixed(2)),
          current_nav,
          current_nav_date: row.current_nav_date,
          current_value: parseFloat(current_value.toFixed(2)),
          gains: parseFloat(gains.toFixed(2)),
          return_pct: parseFloat(return_pct.toFixed(4)),
        };
      });

      const total_investment = holdings.reduce((sum, h) => sum + h.investment_amount, 0);
      const total_current_value = holdings.reduce((sum, h) => sum + h.current_value, 0);
      const total_gains = total_current_value - total_investment;
      const overall_return_pct = total_investment > 0 ? (total_gains / total_investment) * 100 : 0;

      if (action === "portfolio_overview") {
        return {
          overview: {
            total_investment: parseFloat(total_investment.toFixed(2)),
            total_current_value: parseFloat(total_current_value.toFixed(2)),
            total_gains: parseFloat(total_gains.toFixed(2)),
            overall_return_pct: parseFloat(overall_return_pct.toFixed(4)),
          },
        };
      }

      if (action === "holding_returns") {
        return { holdings };
      }

      if (action === "portfolio_allocation") {
        // Compute allocation by fund
        const allocation_by_fund = holdings.map((h) => ({
          fund_id: h.fund_id,
          fund_name: h.fund_name,
          current_value: h.current_value,
          allocation_pct: total_current_value > 0 ? parseFloat(((h.current_value / total_current_value) * 100).toFixed(2)) : 0,
        }));

        // Compute allocation by category
        const categoryMap = new Map<string, number>();
        for (const h of holdings) {
          const cat = h.category;
          categoryMap.set(cat, (categoryMap.get(cat) || 0) + h.current_value);
        }
        const allocation_by_category = Array.from(categoryMap.entries()).map(([category, value]) => ({
          category,
          current_value: parseFloat(value.toFixed(2)),
          allocation_pct: total_current_value > 0 ? parseFloat(((value / total_current_value) * 100).toFixed(2)) : 0,
        }));

        return {
          allocation_by_fund,
          allocation_by_category,
        };
      }

      throw new Error(`Unsupported portfolio action: ${action}`);
    } finally {
      client.release();
    }
  },
});
