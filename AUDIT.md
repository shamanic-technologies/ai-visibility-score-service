# Repository Audit — ai-visibility-score-service

**Date:** 2026-05-10
**Commit:** 44f9442 (main)
**Auditor:** Claude Opus 4.6

---

## Summary

Compact, well-structured service. Main risk is a **high-severity SQL injection advisory** in drizzle-orm. Code quality is solid; most findings are P1/P2 polish items.

| Priority | Count |
|----------|-------|
| P0 (fix now) | 2 |
| P1 (fix soon) | 6 |
| P2 (nice to have) | 6 |

---

## P0 — Fix Now

### 1. drizzle-orm SQL injection (GHSA-gpj5-g38j-94v9)

- **Severity:** HIGH (CVSS 7.5)
- **Details:** `drizzle-orm@^0.38.0` is vulnerable to SQL injection via improperly escaped identifiers. Advisory affects all versions `<0.45.2`.
- **Impact:** Any query path that interpolates user-controlled column/table names could allow data exfiltration. This codebase uses static schema definitions so exploitation surface is limited, but the advisory applies broadly.
- **Fix:** Bump `drizzle-orm` to `>=0.45.2` and `drizzle-kit` to `>=0.31.10`.

### 2. Weights not validated to sum to 1.0

- **File:** `src/schemas.ts:56-65`
- **Details:** `VisibilityWeightsSchema` validates each weight is in `[0, 1]` but does not enforce that they sum to 1.0. A caller can pass weights summing to e.g. 5.0, producing a `visibility_score` that clips at 100 and loses resolution. Or weights summing to 0.1, artificially deflating scores.
- **Impact:** Data integrity — scores across runs become incomparable when weights aren't normalized.
- **Fix:** Add `.refine(w => Math.abs(Object.values(w).reduce((a,b) => a+b, 0) - 1.0) < 0.01, "weights must sum to ~1.0")` or normalize server-side before computing.

---

## P1 — Fix Soon

### 3. Timing-safe API key comparison missing

- **File:** `src/middleware/auth.ts:14`
- **Details:** `apiKey !== expected` uses JavaScript string equality, which short-circuits on first differing byte. This enables timing attacks to brute-force the API key character by character.
- **Fix:** Use `crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))` with a length check guard.

### 4. No request timeout on POST /orgs/visibility-score-runs

- **File:** `src/handlers/runs.ts:51`
- **Details:** A single POST runs N prompts x 2 LLM calls sequentially-ish (concurrency 5). With 50 prompts, this can take several minutes. No server-side timeout exists — Express default is infinite. A slow upstream (chat-service) can hold connections open indefinitely.
- **Impact:** Resource exhaustion, connection pool starvation.
- **Fix:** Add `express-timeout-handler` or `req.setTimeout()` with a reasonable ceiling (e.g. 120s). Consider also adding `AbortController` signals to upstream fetch calls.

### 5. CORS wide open

- **File:** `src/index.ts:38`
- **Details:** `app.use(cors())` with no origin restriction. Any browser on any domain can call this API.
- **Impact:** Since auth is API-key-based (not cookie), the practical risk is lower, but it still violates defense-in-depth. If the key ever leaks into a frontend bundle, CORS won't help.
- **Fix:** Restrict origins to known callers or remove CORS entirely if this is purely service-to-service.

### 6. `promptIdByIndex` computed but never used

- **File:** `src/handlers/runs.ts:218`
- **Details:** `const promptIdByIndex = new Map(...)` is assigned but never referenced. Dead code.
- **Fix:** Remove the line.

### 7. `getBrand()` exported but never called

- **File:** `src/lib/brand-client.ts:74-100`
- **Details:** `getBrand()` is exported but no file imports or calls it. Likely leftover from an earlier iteration.
- **Fix:** Remove or mark as intentional API surface for future use.

### 8. `addRunCosts()` and `finalizeProvisionedCosts()` never called in production code

- **File:** `src/lib/runs-client.ts:103-127`
- **Details:** Both functions are exported and tested but never called from any handler or middleware. They are dead code in the current runtime.
- **Fix:** Remove if not planned for near-term use, or add a tracking comment.

---

## P2 — Nice to Have

### 9. Duplicate `safeParseJson()` implementation

- **Files:** `src/lib/extractor.ts:96-103`, `src/lib/prompt-gen.ts:63-70`
- **Details:** Identical function copy-pasted in two files.
- **Fix:** Extract to a shared `src/lib/json-utils.ts`.

### 10. No retry on LLM calls

- **File:** `src/lib/run.ts:121-139`
- **Details:** Both the audit prompt and extraction calls have zero retry. Transient 5xx from chat-service causes the entire prompt to fail. With `Promise.allSettled` at brand level but not at prompt level, a single flaky response loses that prompt's data.
- **Fix:** Add exponential backoff (1-2 retries) on transient errors for `chatComplete`.

### 11. `openapi.json` read synchronously on every request

- **File:** `src/index.ts:46-52`
- **Details:** `readFileSync` on every `GET /openapi.json`. Not a hot path, but unnecessary I/O.
- **Fix:** Read once at startup or on first request and cache in memory.

### 12. Dockerfile copies entire directory including test files

- **File:** `Dockerfile:8`
- **Details:** `COPY . .` brings in `tests/`, `.env.example`, `scripts/`, etc. Unnecessary image bloat.
- **Fix:** Add a `.dockerignore` excluding `tests/`, `scripts/`, `*.md`, `.env*`.

### 13. No rate limiting

- **Details:** No rate-limiting middleware. A single caller can saturate the service with expensive LLM audit requests.
- **Fix:** Add per-org rate limiting, even if simple (e.g. `express-rate-limit` keyed on `x-org-id`).

### 14. `x-org-id` not validated as UUID in middleware

- **File:** `src/middleware/auth.ts:21`
- **Details:** `requireOrgId` checks presence but not format. A non-UUID org ID would be inserted into queries and DB rows. The Zod schema for the OpenAPI spec marks it as `.uuid()` but the middleware doesn't enforce this at runtime.
- **Fix:** Add UUID format validation in `requireOrgId` to match the declared schema.

---

## Test Coverage Assessment

| Area | Status | Notes |
|------|--------|-------|
| `metrics.ts` (aggregate) | Good | Thorough handcrafted fixture + edge cases |
| `auth.ts` middleware | Good | 401/403/happy path covered |
| `extractor.ts` | Good | Valid JSON, wrapped JSON, schema rejection |
| `prompt-gen.ts` | Good | Happy path, short-count, wrapped JSON |
| `runs-client.ts` | Good | CRUD + error path |
| `env-startup.ts` | Good | Missing vars tested |
| `handlers/runs.ts` (POST) | Good | Auth, validation, happy path, partial failure |
| `handlers/runs.ts` (GET list) | Not covered | `listRuns` handler has zero test coverage |
| `handlers/runs.ts` (GET :id) | Partial | Only org-isolation 404 tested, no happy-path |
| `run.ts` (orchestrator) | Not covered | Only tested indirectly via integration mock |
| `brand-client.ts` | Not covered | No unit tests for `extractBrandFields` |
| `chat-client.ts` | Not covered | No unit tests for `chatComplete` |
| `run-tracking.ts` middleware | Partial | Tested via integration but no unit tests for close-run logic |

**Key gaps:** `listRuns` handler (0 coverage), `getRun` happy path, `brand-client`, `chat-client`.

---

## Documentation Completeness

- **README.md:** Excellent. Covers endpoints, auth, metrics formulas, pipeline, schema, env vars, troubleshooting, and intentional omissions.
- **OpenAPI spec:** Generated from Zod schemas, registered paths match actual routes. Solid.
- **.env.example:** Present and complete.
- **Missing:** No `CONTRIBUTING.md` or `CHANGELOG.md` — acceptable for internal service.

---

## Dependency Summary

| Package | Version | Issue |
|---------|---------|-------|
| `drizzle-orm` | `^0.38.0` | **HIGH** — SQL injection (GHSA-gpj5-g38j-94v9). Bump to `>=0.45.2`. |
| `drizzle-kit` | `^0.30.0` | **MODERATE** — transitive esbuild vulnerability. Bump to `>=0.31.10`. |
| `vitest` | `^2.0.0` | **MODERATE** — transitive vite path traversal (dev-only). Bump to `>=4.x`. |
| `express` | `^4.21.0` | Clean. Consider `^5.x` when stable for async error handling. |
| `zod` | `^4.3.6` | Clean. |
| `cors` | `^2.8.5` | Clean. |
| `p-limit` | `^6.2.0` | Clean. |
| `postgres` | `^3.4.0` | Clean. |

---

## Architecture Notes (no action needed)

- Clean separation: middleware → handlers → orchestrator → clients.
- Tenant isolation via `org_id` filter on all queries — correct.
- Run-tracking pattern consistent with other Distribute services.
- `Promise.allSettled` for multi-brand with partial-failure semantics — good.
- DB schema has appropriate indexes for query patterns.
