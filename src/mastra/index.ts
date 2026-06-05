import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from "@mastra/core/storage";
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import { registerApiRoute } from "@mastra/core/server";

import fs from "fs";
import path from "path";
import { noopObserve } from "@mastra/core/tools";
import { getProjectRoot, resolveDataDir, listAvailableDatasets, isValidDataset } from "../lib/paths";

const PROJECT_ROOT = getProjectRoot();

// Weather components
import { weatherWorkflow } from "./workflows/weather-workflow";
import { weatherAgent } from "./agents/weather-agent";
import { weatherTool } from "./tools/weather-tool";
import {
  toolCallAppropriatenessScorer,
  completenessScorer,
  translationScorer,
} from "./scorers/weather-scorer";

// Tara Financial components
import { taraAgent } from "./agents/tara-agent";
import { transactionTool } from "./tools/transaction-tool";
import { fundTool } from "./tools/fund-tool";
import { portfolioTool } from "./tools/portfolio-tool";

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, taraAgent },
  tools: { weatherTool, transactionTool, fundTool, portfolioTool },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new MastraCompositeStore({
    id: "composite-storage",
    default: new LibSQLStore({
      id: "mastra-storage",
      url: "file:./mastra.db",
    }),
    domains: {
      observability: await new DuckDBStore().getStore("observability"),
    },
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 4111,
    host: "0.0.0.0",
    apiRoutes: [
      // 1. Serve frontend dashboard HTML
      registerApiRoute("/", {
        method: "GET",
        requiresAuth: false,
        handler: async (c) => {
          const htmlPath = path.join(PROJECT_ROOT, "public/index.html");
          if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, "utf-8");
            return c.html(html);
          }
          return c.text("Dashboard HTML not found", 404);
        },
      }),

      // 2. List available datasets
      registerApiRoute("/datasets", {
        method: "GET",
        requiresAuth: false,
        handler: async (c) => {
          const datasets = listAvailableDatasets();
          const active = path.basename(resolveDataDir());
          return c.json({ datasets, active });
        },
      }),

      // 3. Fetch combined metrics for dashboard
      registerApiRoute("/dashboard-data", {
        method: "GET",
        requiresAuth: false,
        handler: async (c) => {
          try {
            const datasetDir = resolveDataDir();
            const datasetName = path.basename(datasetDir);

            // Execute portfolio metrics
            const toolCtx = { observe: noopObserve } as any;

            const overviewRes = (await portfolioTool.execute!({
              action: "portfolio_overview",
            }, toolCtx)) as any;

            const holdingsRes = (await portfolioTool.execute!({
              action: "holding_returns",
            }, toolCtx)) as any;

            const allocationRes = (await portfolioTool.execute!({
              action: "portfolio_allocation",
            }, toolCtx)) as any;

            // Execute fund returns
            const performanceRes = (await fundTool.execute!({
              action: "fund_performance",
            }, toolCtx)) as any;

            // Execute transactions metrics
            const txnsRes = (await transactionTool.execute!({
              action: "list_transactions",
              limit: 100,
            }, toolCtx)) as any;

            const categoriesRes = (await transactionTool.execute!({
              action: "category_spending",
            }, toolCtx)) as any;

            const monthlyRes = (await transactionTool.execute!({
              action: "monthly_comparison",
            }, toolCtx)) as any;

            return c.json({
              dataset: datasetName,
              overview: overviewRes?.overview || null,
              holdings: holdingsRes?.holdings || [],
              allocation: allocationRes || null,
              performance: performanceRes?.performance || [],
              transactions: txnsRes?.transactions || [],
              categories: categoriesRes?.categories || [],
              monthly: monthlyRes?.monthly_spending || [],
            });
          } catch (err) {
            console.error("Dashboard data API error:", err);
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),

      // 3. Ask assistant endpoint (with retry-backoff for rate limits)
      registerApiRoute("/ask", {
        method: "POST",
        requiresAuth: false,
        handler: async (c) => {
          try {
            const { question } = (await c.req.json()) as { question: string };
            if (!question) {
              return c.json({ error: "Missing question parameter" }, 400);
            }

            const mastraInstance = c.get("mastra");
            const agent = mastraInstance.getAgent("taraAgent");

            // Retry with backoff for 429 rate-limit errors (up to 3 attempts)
            const MAX_RETRIES = 3;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                const response = await agent.generate(question);
                return c.json({ answer: response.text });
              } catch (err: any) {
                lastError = err;
                const msg: string = err?.message ?? "";
                const isRateLimit =
                  err?.statusCode === 429 ||
                  (typeof msg === "string" && msg.includes("429")) ||
                  (typeof msg === "string" && msg.includes("RESOURCE_EXHAUSTED")) ||
                  (typeof msg === "string" && msg.toLowerCase().includes("quota"));

                if (isRateLimit && attempt < MAX_RETRIES) {
                  // Parse retryDelay from the error message, e.g. "Please retry in 46.6s"
                  const match = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
                  const delaySec = match ? Math.min(parseFloat(match[1]) + 2, 65) : 15 * attempt;
                  console.warn(
                    `[Ask] Rate limited (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${delaySec}s…`
                  );
                  await new Promise((r) => setTimeout(r, delaySec * 1000));
                  continue;
                }
                // Non-rate-limit error or final attempt — break out
                break;
              }
            }

            // If we got here all attempts failed
            const msg: string = lastError?.message ?? "";
            const isRateLimit =
              (typeof msg === "string" && msg.includes("429")) ||
              (typeof msg === "string" && msg.includes("RESOURCE_EXHAUSTED")) ||
              (typeof msg === "string" && msg.toLowerCase().includes("quota"));

            if (isRateLimit) {
              return c.json(
                {
                  error:
                    "The AI model is temporarily rate-limited. Please wait a moment and try again.",
                  retryable: true,
                },
                429
              );
            }

            console.error("Ask API error:", lastError);
            return c.json({ error: (lastError as Error).message }, 500);
          } catch (err) {
            console.error("Ask API error:", err);
            return c.json({ error: (err as Error).message }, 500);
          }
        },
      }),


      // 4. Switch dataset and trigger re-ingestion
      registerApiRoute("/load-dataset", {
        method: "POST",
        requiresAuth: false,
        handler: async (c) => {
          try {
            const { dataset } = (await c.req.json()) as { dataset: string };
            if (!isValidDataset(dataset)) {
              const available = listAvailableDatasets();
              return c.json(
                {
                  success: false,
                  message: `Invalid dataset. Available: ${available.join(", ") || "none"}`,
                },
                400
              );
            }

            const targetDir = path.join("data", dataset);
            process.env.DATA_DIR = targetDir;

            const { ingestData } = await import("../../scripts/ingest");
            await ingestData(targetDir);

            return c.json({
              success: true,
              message: `Successfully loaded and ingested ${dataset}`,
            });
          } catch (err) {
            console.error("Load-dataset API error:", err);
            return c.json({ success: false, message: (err as Error).message }, 500);
          }
        },
      }),
    ],
  },
});

// Auto-seed database if empty at startup
async function autoSeedIfEmpty() {
  try {
    const { pool } = await import("../db/connection");
    const { ingestData } = await import("../../scripts/ingest");

    const client = await pool.connect();
    try {
      const res = await client.query("SELECT COUNT(*) FROM transactions");
      const count = parseInt(res.rows[0].count, 10);
      if (count === 0) {
        const defaultDataset = path.basename(resolveDataDir());
        console.log(`Database is empty. Running auto-ingestion with ${defaultDataset}...`);
        await ingestData();
      } else {
        console.log(`Database already has ${count} transactions.`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Failed to check database or auto-seed:", err);
  }
}

autoSeedIfEmpty();
