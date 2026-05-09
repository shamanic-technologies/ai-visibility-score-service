# ai-visibility-score-service

Run an N-prompt LLM brand audit per request, measure how often and where a brand
appears vs. competitors in the LLM's responses, persist everything for time-series
tracking.

A caller (dashboard, n8n workflow, etc.) sends a list of brand IDs, the service:

1. Pulls brand context (industry, audience, offerings, geography) from `brand-service`.
2. Generates `nPrompts` (default 25) plausible user-style search queries via `chat-service`
   using a small/fast model (`flash`).
3. Runs each query against the audit model (default `google` / `pro`) in parallel.
4. Extracts structured per-response data (brand found, position, sentiment, competitors,
   citations) via `chat-service` using a strict-JSON model (default `anthropic` / `haiku`).
5. Aggregates the responses into a **visibility score (0–100)** plus a full metric bundle.
6. Persists run + per-prompt + per-competitor rows.
7. Returns the full bundle (run row + prompt rows + competitor rows + computed
   `top_competitors` and `citation_opportunities`).

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | public | Liveness check |
| `GET` | `/openapi.json` | public | OpenAPI 3.0 spec |
| `POST` | `/orgs/visibility-score-runs` | x-api-key + x-org-id + x-brand-id | Trigger N parallel runs |
| `GET` | `/orgs/visibility-score-runs` | x-api-key + x-org-id | List runs with delta block |
| `GET` | `/orgs/visibility-score-runs/{id}` | x-api-key + x-org-id | Single run + full details |

`/orgs/*` routes ALL apply `apiKeyAuth` + `requireOrgId` + `withRunTracking`. Every
DB query on those routes filters by `org_id`.

### POST /orgs/visibility-score-runs

```jsonc
{
  "brandIds": ["<uuid>", "<uuid>"],          // required, 1–10
  "provider": "google",                       // optional, default "google"
  "promptModel": "pro",                       // optional, default "pro" (audit model)
  "promptGenModel": "flash",                  // optional, default "flash" (prompt generator)
  "extractionProvider": "anthropic",          // optional, default "anthropic"
  "extractionModel": "haiku",                 // optional, default "haiku"
  "nPrompts": 25,                             // optional, default 25, range 5–50
  "weights": {                                // optional, default below
    "brandMentionRate": 0.25,
    "citationRate": 0.15,
    "positionScore": 0.20,
    "shareOfVoice": 0.20,
    "sentiment": 0.15,
    "brandAndUrlRate": 0.05
  }
}
```

`x-brand-id` header MUST contain the same set of UUIDs (comma-separated) as `brandIds`
in the body. Mismatch → `400`.

### Curl example

```bash
curl -sS -X POST "$SERVICE_URL/orgs/visibility-score-runs" \
  -H "x-api-key: $INTERNAL_API_KEY" \
  -H "x-org-id: 11111111-1111-4111-8111-111111111111" \
  -H "x-user-id: 22222222-2222-4222-8222-222222222222" \
  -H "x-run-id: 33333333-3333-4333-8333-333333333333" \
  -H "x-brand-id: 44444444-4444-4444-8444-444444444444" \
  -H "Content-Type: application/json" \
  -d '{"brandIds":["44444444-4444-4444-8444-444444444444"], "nPrompts": 25}' | jq .
```

## Metric formulas

For one run with `N` prompts and target brand `T` with domain `D`:

```
brand_mention_count          = #prompts where T was mentioned
brand_mention_rate           = brand_mention_count / N
url_mention_count            = #prompts where D appeared
url_mention_rate             = url_mention_count / N
brand_and_url_count          = #prompts where T and D co-occurred
brand_and_url_rate           = brand_and_url_count / N
avg_position                 = mean(brandPosition) over found prompts; null if never found
position_score               = mean over found prompts of
                                 (maxBrandsInResponse - brandPosition + 1) / maxBrandsInResponse
                               (0–1). null if never found.
share_of_voice               = brand_mention_count / total_mentions
                               where total_mentions = brand + Σ competitor mentions across all prompts.
                               Returns 0 (not NaN) when total_mentions = 0.
weighted_share_of_voice      = Σ position_weighted_brand_mentions / Σ position_weighted_all_mentions
                               using 1/position as the weight.
citation_count               = #citations across all responses pointing at D (or *.D)
citation_rate                = citation_count / N
citation_share_of_voice      = brand_citations / total_citations
citation_opportunities       = [{domain, count}] of non-target domains cited, descending
positive_count               = #found prompts where sentiment = "positive"
neutral_count                = same for "neutral"
negative_count               = same for "negative"
net_sentiment                = (positive_count - negative_count) / brand_mention_count   ([-1, +1])
avg_sentiment_score          = mean(sentimentScore) over found prompts
avg_response_length          = mean response length (chars)
response_length_when_brand_found     = mean response length over found prompts
response_length_when_brand_not_found = mean response length over not-found prompts
distinct_competitors_count   = #distinct competitor names across all responses
top_competitors              = top 10 by mention count: { name, url, mention_count, avg_position,
                                                         share_of_voice, net_sentiment }

visibility_score (0–100, clamped) =
  100 * (
    weights.brandMentionRate * brand_mention_rate +
    weights.citationRate     * citation_rate +
    weights.positionScore    * position_score +
    weights.shareOfVoice     * share_of_voice +
    weights.sentiment        * (net_sentiment + 1) / 2 +
    weights.brandAndUrlRate  * brand_and_url_rate
  )
```

Default weights: `0.25 / 0.15 / 0.20 / 0.20 / 0.15 / 0.05` (sums to 1.0).

## Pipeline (per brand)

```
brandId
  └─► brand-service POST /orgs/brands/extract-fields  (industry, audience, offerings, geography)
        │
        ▼
  prompt-gen → chat-service POST /complete (google/flash, JSON)  → N user-style queries
        │
        ▼
  for each query (concurrency 5):
    chat-service POST /complete (google/pro)         → response, tokens, latency
    chat-service POST /complete (anthropic/haiku, JSON) → structured extraction
        │
        ▼
  metrics.ts :: aggregate(prompts, domain, weights)
        │
        ▼
  TX:
    INSERT visibility_score_runs        (1 row)
    INSERT visibility_score_prompts     (N rows)
    INSERT visibility_score_competitors (M rows)
        │
        ▼
  return { run, prompts, competitors, top_competitors, citation_opportunities }
```

Multiple brands → N runs in parallel via `Promise.allSettled`. Partial failure returns
the successful results plus a 200; total failure returns 500.

## Run tracking

- Inbound `x-run-id` (the caller's run) is captured as `req.parentRunId`.
- `withRunTracking` middleware creates **this service's own run** in `runs-service`
  → `req.runId`. If `runs-service` is unreachable, the request fails with **502**.
- All downstream calls (chat-service, brand-service) include `x-run-id = req.runId`,
  not the caller's parent. All other tracking headers are forwarded verbatim.
- `res.on("finish" | "close")` closes the run with `completed` (status < 400) or `failed`
  (status >= 400).
- Every persisted row stores both `parent_run_id` and `run_id`.

## Schema

Three tables, all with `org_id` for tenant isolation:

- `visibility_score_runs` — one row per (brand × audit). Holds all aggregate metrics
  plus status / timing.
- `visibility_score_prompts` — `nPrompts` rows per run. Per-prompt response + extraction.
- `visibility_score_competitors` — one row per competitor mention per prompt.

See `src/db/schema.ts` for the full column list. Migrations are auto-applied at boot
(`drizzle-orm/postgres-js/migrator`).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | ✅ | Postgres connection string (Neon recommended) |
| `INTERNAL_API_KEY` | ✅ | Inbound `x-api-key` value |
| `CHAT_SERVICE_URL` | ✅ | Base URL for chat-service `/complete` |
| `CHAT_SERVICE_API_KEY` | ✅ | Outbound key for chat-service |
| `BRAND_SERVICE_URL` | ✅ | Base URL for brand-service |
| `BRAND_SERVICE_API_KEY` | ✅ | Outbound key for brand-service |
| `RUNS_SERVICE_URL` | ✅ | Base URL for runs-service |
| `RUNS_SERVICE_API_KEY` | ✅ | Outbound key for runs-service |
| `PORT` | optional | default `8080` |

The service crashes loudly at startup if any required variable is missing.

## Development

```bash
npm install
cp .env.example .env  # then fill in
npm run dev           # tsx watch on PORT (default 8080)
```

### Commands

| Command | Effect |
|---------|--------|
| `npm run dev` | Hot-reload dev server |
| `npm run build` | `tsc` + regenerate `openapi.json` |
| `npm test` | All tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests (mock chat/brand/runs) |
| `npm run db:generate` | Generate a new Drizzle migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:push` | Push schema directly (dev-only) |
| `npm run generate:openapi` | Regenerate `openapi.json` from Zod schemas |

## Troubleshooting

- **502 from POST /orgs/visibility-score-runs** — `runs-service` is unreachable. Verify
  `RUNS_SERVICE_URL` + `RUNS_SERVICE_API_KEY`. The service intentionally fails loud
  rather than silently dropping run tracking.
- **400 "x-brand-id header must match brandIds"** — caller passed brand IDs in the body
  that don't match the comma-separated `x-brand-id` header. Both must contain the same
  set of UUIDs.
- **404 on GET /orgs/visibility-score-runs/{id}** — the run does not exist OR belongs
  to a different `x-org-id`. The service returns 404 for both to avoid leaking tenant
  metadata.
- **`relation "visibility_score_runs" does not exist`** — migrations did not run. Confirm
  the boot path completed: look for `[ai-visibility-score-service] migrations complete`.
- **Empty / partial prompts from chat-service** — `prompt-gen.ts` rejects when the model
  returns fewer prompts than requested. Re-run; the prompt-gen step has no retry.

## Out of scope (intentional)

- ❌ Cron / scheduler / queue
- ❌ Async job + polling — every request is sync (may take 30–90s)
- ❌ SRO / page-level / crawlability scoring
- ❌ Search-volume estimates
- ❌ Hallucination/accuracy rate
- ❌ Webhook / event publishing
- ❌ Caching (each call = fresh run)
