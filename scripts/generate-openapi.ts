import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "AI Visibility Score Service",
    description:
      "Runs an N-prompt LLM audit per brand to measure brand visibility vs. competitors and persists time-series metrics.",
    version: "0.1.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:8080" }],
});

writeFileSync(join(projectRoot, "openapi.json"), JSON.stringify(document, null, 2));
console.log("[ai-visibility-score-service] openapi.json generated");
