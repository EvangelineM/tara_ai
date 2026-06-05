import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "../../db/connection";

export const fundTool = createTool({
  id: "fund-tool",
  description: "Queries mutual funds and calculates their returns (NAV growth over time). Use this for fund performance lists, calculating returns, identifying the best performing fund, or looking up NAV history.",
  inputSchema: z.object({
    action: z.enum([
      "fund_performance",
      "fund_return",
      "best_performing_fund",
      "nav_history",
    ]).describe("The action to perform"),
    fundId: z.string().optional().describe("Fund identifier from the database (use fund_performance to list available funds)"),
    fundName: z.string().optional().describe("Fund name from the database (supports partial search)"),
    startDate: z.string().optional().describe("Start date for return calculation (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("End date for return calculation (YYYY-MM-DD)"),
  }),
  execute: async ({ action, fundId, fundName, startDate, endDate }) => {
    const client = await pool.connect();
    try {
      // Helper function to resolve fund ID from ID or name
      const resolveFundId = async (): Promise<{ id: string; name: string } | null> => {
        if (fundId) {
          const res = await client.query("SELECT id, name FROM funds WHERE id = $1", [fundId]);
          return res.rows[0] || null;
        }
        if (fundName) {
          const res = await client.query("SELECT id, name FROM funds WHERE name ILIKE $1 OR id ILIKE $1 LIMIT 1", [`%${fundName}%`]);
          return res.rows[0] || null;
        }
        return null;
      };

      // Helper function to compute performance for one or all funds
      const getPerformance = async (targetId?: string) => {
        let fundsQuery = "SELECT id, name, category FROM funds";
        const fundsParams: any[] = [];
        if (targetId) {
          fundsQuery += " WHERE id = $1";
          fundsParams.push(targetId);
        }
        const fundsRes = await client.query(fundsQuery, fundsParams);

        const results: Array<{
          fund_id: string;
          fund_name: string;
          category: string;
          start_date: string;
          start_nav: number;
          end_date: string;
          end_nav: number;
          return_pct: number;
        }> = [];
        for (const fund of fundsRes.rows) {
          // Get starting NAV
          let startQuery = `SELECT nav, nav_date FROM fund_nav WHERE fund_id = $1`;
          const startParams: any[] = [fund.id];
          if (startDate) {
            startQuery += ` AND nav_date >= $2 ORDER BY nav_date ASC LIMIT 1`;
            startParams.push(startDate);
          } else {
            startQuery += ` ORDER BY nav_date ASC LIMIT 1`;
          }
          const startRes = await client.query(startQuery, startParams);

          // Get ending NAV
          let endQuery = `SELECT nav, nav_date FROM fund_nav WHERE fund_id = $1`;
          const endParams: any[] = [fund.id];
          if (endDate) {
            endQuery += ` AND nav_date <= $2 ORDER BY nav_date DESC LIMIT 1`;
            endParams.push(endDate);
          } else {
            endQuery += ` ORDER BY nav_date DESC LIMIT 1`;
          }
          const endRes = await client.query(endQuery, endParams);

          if (startRes.rows[0] && endRes.rows[0]) {
            const startNav = parseFloat(startRes.rows[0].nav);
            const endNav = parseFloat(endRes.rows[0].nav);
            const returnPct = ((endNav - startNav) / startNav) * 100;
            results.push({
              fund_id: fund.id,
              fund_name: fund.name,
              category: fund.category,
              start_date: startRes.rows[0].nav_date,
              start_nav: startNav,
              end_date: endRes.rows[0].nav_date,
              end_nav: endNav,
              return_pct: parseFloat(returnPct.toFixed(4)),
            });
          }
        }
        return results;
      };

      if (action === "fund_performance") {
        const perf = await getPerformance();
        return { performance: perf };
      }

      if (action === "fund_return") {
        const resolved = await resolveFundId();
        if (!resolved) {
          throw new Error("Could not resolve fund by ID or name");
        }
        const perf = await getPerformance(resolved.id);
        return { fund_return: perf[0] || null };
      }

      if (action === "best_performing_fund") {
        const perf = await getPerformance();
        if (perf.length === 0) {
          return { best_performing_fund: null };
        }
        perf.sort((a, b) => b.return_pct - a.return_pct);
        return { best_performing_fund: perf[0] };
      }

      if (action === "nav_history") {
        const resolved = await resolveFundId();
        if (!resolved) {
          throw new Error("Could not resolve fund by ID or name");
        }
        let query = `SELECT nav_date, nav::numeric FROM fund_nav WHERE fund_id = $1`;
        const params: any[] = [resolved.id];
        let paramIndex = 2;

        if (startDate) {
          query += ` AND nav_date >= $${paramIndex}`;
          params.push(startDate);
          paramIndex++;
        }
        if (endDate) {
          query += ` AND nav_date <= $${paramIndex}`;
          params.push(endDate);
          paramIndex++;
        }
        query += ` ORDER BY nav_date ASC`;

        const res = await client.query(query, params);
        return {
          fund_id: resolved.id,
          fund_name: resolved.name,
          nav_history: res.rows.map((row) => ({
            date: row.nav_date,
            nav: parseFloat(row.nav),
          })),
        };
      }

      throw new Error(`Unsupported fund action: ${action}`);
    } finally {
      client.release();
    }
  },
});
