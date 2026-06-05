import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "../../db/connection";

export const transactionTool = createTool({
  id: "transaction-tool",
  description: "Queries financial transactions. Use this tool for total spending, category spending, merchant spending, largest expense, monthly comparisons, top merchants, or listing transactions.",
  inputSchema: z.object({
    action: z.enum([
      "total_spending",
      "category_spending",
      "merchant_spending",
      "largest_expense",
      "monthly_comparison",
      "top_merchants",
      "list_transactions",
    ]).describe("The action to perform"),
    filterCategory: z.string().optional().describe("Filter by category label from the dataset (use category_spending to discover values)"),
    filterMerchant: z.string().optional().describe("Filter by normalized merchant name (use top_merchants to discover values)"),
    limit: z.number().optional().describe("Limit the number of results returned (defaults to 10)"),
  }),
  execute: async ({ action, filterCategory, filterMerchant, limit = 10 }) => {
    const client = await pool.connect();
    try {
      const excludeTransfers = `
        AND t.category !~* 'transfer'
        AND m.category !~* 'transfer'
      `;

      if (action === "total_spending") {
        let query = `
          SELECT COALESCE(SUM(t.amount), 0)::numeric as total_spending
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE 1=1
          ${excludeTransfers}
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (filterCategory) {
          query += ` AND (t.category = $${paramIndex} OR m.category = $${paramIndex})`;
          params.push(filterCategory);
          paramIndex++;
        }

        if (filterMerchant) {
          query += ` AND m.normalized_merchant ILIKE $${paramIndex}`;
          params.push(`%${filterMerchant}%`);
          paramIndex++;
        }

        const res = await client.query(query, params);
        return {
          total_spending: parseFloat(res.rows[0].total_spending),
        };
      }

      if (action === "category_spending") {
        let query = `
          SELECT m.category, COALESCE(SUM(t.amount), 0)::numeric as total_spending
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE 1=1
          ${excludeTransfers}
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (filterCategory) {
          query += ` AND (t.category = $${paramIndex} OR m.category = $${paramIndex})`;
          params.push(filterCategory);
          paramIndex++;
        }

        query += `
          GROUP BY m.category
          ORDER BY total_spending DESC
        `;

        const res = await client.query(query, params);
        return {
          categories: res.rows.map((row) => ({
            category: row.category,
            total_spending: parseFloat(row.total_spending),
          })),
        };
      }

      if (action === "merchant_spending") {
        let query = `
          SELECT m.normalized_merchant, COALESCE(SUM(t.amount), 0)::numeric as total_spending
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE 1=1
          ${excludeTransfers}
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (filterMerchant) {
          query += ` AND m.normalized_merchant ILIKE $${paramIndex}`;
          params.push(`%${filterMerchant}%`);
          paramIndex++;
        }

        query += `
          GROUP BY m.normalized_merchant
          ORDER BY total_spending DESC
        `;

        const res = await client.query(query, params);
        return {
          merchants: res.rows.map((row) => ({
            merchant: row.normalized_merchant,
            total_spending: parseFloat(row.total_spending),
          })),
        };
      }

      if (action === "largest_expense") {
        const query = `
          SELECT t.id, t.date, t.merchant as raw_merchant, m.normalized_merchant as merchant, m.category, t.amount::numeric, t.currency, t.memo
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE t.category !~* 'transfer'
            AND m.category !~* 'transfer'
          ORDER BY t.amount DESC
          LIMIT 1
        `;
        const res = await client.query(query);
        if (res.rows.length === 0) {
          return { largest_expense: null };
        }
        const row = res.rows[0];
        return {
          largest_expense: {
            id: row.id,
            date: row.date,
            raw_merchant: row.raw_merchant,
            merchant: row.merchant,
            category: row.category,
            amount: parseFloat(row.amount),
            currency: row.currency,
            memo: row.memo,
          },
        };
      }

      if (action === "monthly_comparison") {
        const query = `
          SELECT TO_CHAR(t.date, 'YYYY-MM') as month, COALESCE(SUM(t.amount), 0)::numeric as total_spending
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE t.category !~* 'transfer'
            AND m.category !~* 'transfer'
          GROUP BY month
          ORDER BY month ASC
        `;
        const res = await client.query(query);
        return {
          monthly_spending: res.rows.map((row) => ({
            month: row.month,
            total_spending: parseFloat(row.total_spending),
          })),
        };
      }

      if (action === "top_merchants") {
        const query = `
          SELECT m.normalized_merchant as merchant, COALESCE(SUM(t.amount), 0)::numeric as total_spending
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE t.category !~* 'transfer'
            AND m.category !~* 'transfer'
          GROUP BY m.normalized_merchant
          ORDER BY total_spending DESC
          LIMIT $1
        `;
        const res = await client.query(query, [limit]);
        return {
          merchants: res.rows.map((row) => ({
            merchant: row.merchant,
            total_spending: parseFloat(row.total_spending),
          })),
        };
      }

      if (action === "list_transactions") {
        let query = `
          SELECT t.id, t.date, t.merchant as raw_merchant, m.normalized_merchant as merchant, m.category, t.amount::numeric, t.currency, t.memo
          FROM transactions t
          JOIN merchant_mappings m ON t.merchant = m.raw_merchant
          WHERE 1=1
        `;
        const params: any[] = [];
        let paramIndex = 1;

        if (filterCategory) {
          query += ` AND (t.category = $${paramIndex} OR m.category = $${paramIndex})`;
          params.push(filterCategory);
          paramIndex++;
        }

        if (filterMerchant) {
          query += ` AND m.normalized_merchant ILIKE $${paramIndex}`;
          params.push(`%${filterMerchant}%`);
          paramIndex++;
        }

        query += `
          ORDER BY t.date DESC, t.id DESC
          LIMIT $${paramIndex}
        `;
        params.push(limit);

        const res = await client.query(query, params);
        return {
          transactions: res.rows.map((row) => ({
            id: row.id,
            date: row.date,
            raw_merchant: row.raw_merchant,
            merchant: row.merchant,
            category: row.category,
            amount: parseFloat(row.amount),
            currency: row.currency,
            memo: row.memo,
          })),
        };
      }

      throw new Error(`Unsupported transaction action: ${action}`);
    } finally {
      client.release();
    }
  },
});
