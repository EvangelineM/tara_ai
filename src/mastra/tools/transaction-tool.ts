import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "../../db/connection";
import { getLargestTransaction, getLargestCategorySpend } from "../../lib/finance-queries";
import { resolveMerchantFilter } from "../../lib/merchant-service";

export const transactionTool = createTool({
  id: "transaction-tool",
  description: "Queries financial transactions. Use this tool for total spending, category spending, merchant spending, largest expense, monthly comparisons, top merchants, or listing transactions.",
  inputSchema: z.object({
    action: z.enum([
      "total_spending",
      "category_spending",
      "merchant_spending",
      "largest_expense",
      "largest_category_spend",
      "monthly_comparison",
      "top_merchants",
      "list_transactions",
    ]).describe("The action to perform"),
    filterCategory: z.string().optional().describe("Filter by category label from the dataset (use category_spending to discover values)"),
    filterMerchant: z.string().optional().describe("Filter by normalized merchant name (use top_merchants to discover values)"),
    filterSearch: z.string().optional().describe("Search merchant names and memos"),
    dateFrom: z.string().optional().describe("Inclusive start date (YYYY-MM-DD)"),
    dateTo: z.string().optional().describe("Inclusive end date (YYYY-MM-DD)"),
    limit: z.number().optional().describe("Limit results (defaults to 10 for list_transactions when omitted)"),
  }),
  execute: async ({ action, filterCategory, filterMerchant, filterSearch, dateFrom, dateTo, limit }) => {
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
          const rawMerchants = await resolveMerchantFilter(filterMerchant, client);
          if (rawMerchants?.length) {
            query += ` AND t.merchant = ANY($${paramIndex}::text[])`;
            params.push(rawMerchants);
            paramIndex++;
          } else {
            query += ` AND m.normalized_merchant ILIKE $${paramIndex}`;
            params.push(`%${filterMerchant}%`);
            paramIndex++;
          }
        }

        query += `
          GROUP BY m.normalized_merchant
          ORDER BY total_spending DESC
        `;

        const res = await client.query(query, params);
        const rows = res.rows;
        const total = rows.reduce(
          (sum, row) => sum + parseFloat(row.total_spending),
          0
        );

        return {
          merchants: rows.map((row) => ({
            merchant: row.normalized_merchant,
            total_spending: parseFloat(row.total_spending),
          })),
          total_spending: total,
        };
      }

      if (action === "largest_expense") {
        const txn = await getLargestTransaction(client);
        if (!txn) {
          return { largest_expense: null };
        }
        return {
          largest_expense: {
            date: txn.date,
            merchant: txn.merchant,
            category: txn.category,
            amount: txn.amount,
            memo: txn.memo,
          },
        };
      }

      if (action === "largest_category_spend") {
        const cat = await getLargestCategorySpend(client);
        return { largest_category_spend: cat };
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
          WHERE t.category !~* 'transfer|rent'
            AND m.category !~* 'transfer|rent'
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
          const rawMerchants = await resolveMerchantFilter(filterMerchant, client);
          if (rawMerchants?.length) {
            query += ` AND t.merchant = ANY($${paramIndex}::text[])`;
            params.push(rawMerchants);
            paramIndex++;
          } else {
            query += ` AND m.normalized_merchant ILIKE $${paramIndex}`;
            params.push(`%${filterMerchant}%`);
            paramIndex++;
          }
        }

        if (filterSearch) {
          const rawMerchants = await resolveMerchantFilter(filterSearch, client);
          if (rawMerchants?.length) {
            query += ` AND t.merchant = ANY($${paramIndex}::text[])`;
            params.push(rawMerchants);
            paramIndex++;
          } else {
            query += ` AND (
              m.normalized_merchant ILIKE $${paramIndex}
              OR t.merchant ILIKE $${paramIndex}
              OR t.category ILIKE $${paramIndex}
              OR m.category ILIKE $${paramIndex}
              OR COALESCE(t.memo, '') ILIKE $${paramIndex}
            )`;
            params.push(`%${filterSearch}%`);
            paramIndex++;
          }
        }

        if (dateFrom) {
          query += ` AND t.date >= $${paramIndex}::date`;
          params.push(dateFrom);
          paramIndex++;
        }

        if (dateTo) {
          query += ` AND t.date <= $${paramIndex}::date`;
          params.push(dateTo);
          paramIndex++;
        }

        query += ` ORDER BY t.date DESC, t.id DESC`;

        const rowLimit = limit ?? 10;
        if (rowLimit > 0) {
          query += ` LIMIT $${paramIndex}`;
          params.push(rowLimit);
        }

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
