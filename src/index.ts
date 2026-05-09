import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { apiKeyAuth, requireOrgId } from "./middleware/auth.js";
import { withRunTracking } from "./middleware/run-tracking.js";
import { postRuns, listRuns, getRun } from "./handlers/runs.js";

const REQUIRED_ENV = [
  "AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL",
  "AI_VISIBILITY_SCORE_SERVICE_API_KEY",
  "CHAT_SERVICE_URL",
  "CHAT_SERVICE_API_KEY",
  "BRAND_SERVICE_URL",
  "BRAND_SERVICE_API_KEY",
  "RUNS_SERVICE_URL",
  "RUNS_SERVICE_API_KEY",
] as const;

export function assertEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[ai-visibility-score-service] missing required env vars: ${missing.join(", ")}`,
    );
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ai-visibility-score-service" });
  });

  app.get("/openapi.json", (_req, res) => {
    if (!existsSync(openapiPath)) {
      return res.status(404).json({
        error: "OpenAPI spec not generated. Run: npm run generate:openapi",
      });
    }
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  });

  app.post(
    "/orgs/visibility-score-runs",
    apiKeyAuth,
    requireOrgId,
    withRunTracking("visibility-score-run"),
    postRuns,
  );

  app.get(
    "/orgs/visibility-score-runs",
    apiKeyAuth,
    requireOrgId,
    withRunTracking("visibility-score-list"),
    listRuns,
  );

  app.get(
    "/orgs/visibility-score-runs/:id",
    apiKeyAuth,
    requireOrgId,
    withRunTracking("visibility-score-get"),
    getRun,
  );

  return app;
}

const PORT = parseInt(process.env.PORT || "8080", 10);

if (process.env.NODE_ENV !== "test") {
  assertEnv();
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[ai-visibility-score-service] migrations complete");
      const app = createApp();
      app.listen(PORT, "::", () => {
        console.log(`[ai-visibility-score-service] listening on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("[ai-visibility-score-service] startup failed:", err);
      process.exit(1);
    });
}
