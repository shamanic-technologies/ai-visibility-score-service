process.env.NODE_ENV = "test";
process.env.AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL =
  process.env.AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL ?? "postgresql://localhost/test";
process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY = process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY ?? "test-internal-key";
process.env.CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL ?? "https://chat.test.local";
process.env.CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY ?? "test-chat-key";
process.env.BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL ?? "https://brand.test.local";
process.env.BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY ?? "test-brand-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL ?? "https://runs.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY ?? "test-runs-key";
