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
   citations) via `chat-service` using a strict-JSON model (default `google` / `pro`).
5. Aggregates the responses into a **visibility score (0–100)** plus a full metric bundle.
6. In parallel with the judges, pulls the brand domain's raw **Ahrefs Brand-Radar**
   AI-visibility stats from `ahref-service` (global mention count + per-AI-engine
   breakdown + top cited competitor brands). Fail-soft: a failed fetch is recorded as
   a snapshot row with `status="failed"` and never blocks the score.
7. Persists run + per-prompt + per-competitor rows + one Ahrefs snapshot row.
8. Returns the full bundle (run row + prompt rows + competitor rows + computed
   `top_competitors` and `citation_opportunities` + the `ahrefs` snapshot).

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

Request body MUST be empty (`{}`). The brand to audit comes from the `x-brand-id` header.

```jsonc
{}
```

All LLM provider/model choices, prompt count, and scoring weights are decided server-side
from `src/lib/config.ts` (`VISIBILITY_RUN_CONFIG`). They are NOT caller-configurable — to
change them, ship a new version of the service. This keeps callers oblivious to LLM-ops
concerns and prevents provider/model mismatch errors at the chat-service boundary.

Required headers:
- `x-api-key`
- `x-org-id` (UUID)
- `x-brand-id` (UUID — single brand, no comma-separated list; co-branding not supported)
- `x-run-id` (UUID — caller's parent run ID, captured as `parentRunId`)

### Curl example

```bash
curl -sS -X POST "$SERVICE_URL/orgs/visibility-score-runs" \
  -H "x-api-key: $AI_VISIBILITY_SCORE_SERVICE_API_KEY" \
  -H "x-org-id: 11111111-1111-4111-8111-111111111111" \
  -H "x-user-id: 22222222-2222-4222-8222-222222222222" \
  -H "x-run-id: 33333333-3333-4333-8333-333333333333" \
  -H "x-brand-id: 44444444-4444-4444-8444-444444444444" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
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

visibility_score (0–1, clamped) =
    weights.brandMentionRate * brand_mention_rate +
    weights.citationRate     * citation_rate +
    weights.positionScore    * position_score +
    weights.shareOfVoice     * share_of_voice +
    weights.sentiment        * (net_sentiment + 1) / 2 +
    weights.brandAndUrlRate  * brand_and_url_rate

# All rate metrics (visibility_score, brand_mention_rate, share_of_voice,
# citation_rate, net_sentiment, position_score, etc.) are decimal in [0, 1].
# Multiply by 100 for display as a percentage.
```

Default weights: `0.25 / 0.15 / 0.20 / 0.20 / 0.15 / 0.05` (sums to 1.0).

## Pipeline (per brand)

The service audits each brand against **multiple judge LLMs in parallel** and persists
an aggregate result on top of the per-judge results. The set of judges is decided
server-side in `src/lib/config.ts` (today: `google/flash` + `anthropic/haiku`).

```
brandId
  └─► brand-service POST /orgs/brands/extract-fields  (industry, audience, offerings, geography)
        │
        ▼
  prompt-gen → chat-service POST /complete (google/flash, JSON)  → N user-style queries
        │   (prompts are generated ONCE and shared across every judge)
        ▼
  for each judge in config.judges (parallel):
    for each query (concurrency 5):
      chat-service POST /complete (judge.provider/judge.model)   → response, tokens, latency
      chat-service POST /complete (google/pro, JSON)             → structured extraction
    metrics.ts :: aggregate(prompts, domain, weights)            → per-judge AggregateMetrics
        │
        ▼
  metrics.ts :: aggregateAcrossProviders(perJudge[])             → aggregate AggregateMetrics
        │
        ▼
  TX:
    INSERT visibility_score_runs        (1 aggregate parent row, aggregate_run_id=NULL)
    for each judge:
      INSERT visibility_score_runs      (1 per-provider child row, aggregate_run_id=parent.id)
      INSERT visibility_score_prompts   (N rows tied to the child run)
      INSERT visibility_score_competitors (M rows tied to the child run + prompt)
        │
        ▼
  return { run (parent), by_provider[], top_competitors, citation_opportunities }
```

Aggregation rules:

- Rate metrics (`visibility_score`, `share_of_voice`, `brand_mention_rate`, ...) on the
  parent row are the **arithmetic mean** of the per-judge values. Nullable rates skip
  null children and average the rest; if all children are null, the parent is null.
- Count metrics (`brand_mention_count`, `citation_count`, ...) are **summed** across judges.
- `top_competitors` and `citation_opportunities` are unioned across judges (by competitor
  name / domain) with mention counts summed.

Failure semantics (tolerate partial failure at both levels — never throw away already-spent grounding):

- **Prompt level** — a judge runs its N prompts with `Promise.allSettled`. If some prompts fail
  (transient chat-service 502s) the judge keeps its successful subset and computes metrics over it;
  the child `error` records `"partial: <k>/<n> prompts failed"`. A judge fails as a whole only when
  **every** prompt failed.
- **Judge level** — if a single judge fails entirely (e.g. one provider is out of API credit), the
  audit still succeeds from the surviving judges; the parent `error` records `"partial: <provider> failed: <msg>"`.
- If ALL judges fail, the audit fails: HTTP 500 + a failed aggregate parent row.

Run-level idempotence (24h cache):

- Before any LLM work, `runVisibilityScore` looks up the most recent **completed** aggregate run
  for `(orgId, brandId)` younger than `RUN_CACHE_TTL_HOURS` (24h). On a hit it rebuilds and returns
  that bundle (`loadRunBundle`) — **zero** brand-resolve / prompt-gen / grounded judge calls.
- A `failed` run never blocks a retry (only `completed` is cached). A partially-completed run still
  counts as a hit — we prefer saving the spend over a marginally fresher imperfect run.
- The cache key ignores `campaignId`: a second campaign auditing the same brand within 24h reuses the
  audit (the returned run keeps its original `campaignId`).

Adding a new judge (e.g. OpenAI) requires only appending to `VISIBILITY_RUN_CONFIG.judges`
— no schema or API change.

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

Four tables, all with `org_id` for tenant isolation:

- `visibility_score_runs` — one row per (brand × audit attempt × judge), plus one
  aggregate parent row per audit. The two row kinds are distinguished by
  `judge_kind`:
  - `judge_kind = 'aggregate'` (`aggregate_run_id IS NULL`): aggregate parent row.
    Metrics are the mean across all per-provider children. `llm_provider = 'aggregate'`,
    `llm_model` is the comma-separated list of judges (e.g. `google/pro,anthropic/opus`).
  - `judge_kind = 'per_provider'` (`aggregate_run_id = <parent id>`): one row per judge.
    `llm_provider` / `llm_model` hold the actual judge. Linked to its prompts /
    competitors via `visibility_score_prompts.run_id_fk = <this row's id>`.
  Successful runs have `status='completed'` with all metrics populated; failed runs
  have `status='failed'` with `error` set and metric columns null (`domain` and
  `brand_name` may also be null if the pipeline failed before brand-service resolved).
- `visibility_score_prompts` — `nPrompts` rows per run. Per-prompt response + extraction.
- `visibility_score_competitors` — one row per competitor mention per prompt.
- `visibility_ahrefs_snapshots` — one row per run holding the brand domain's raw
  **Ahrefs Brand-Radar** AI-visibility stats from `ahref-service`: `mentions_total`
  (global), `mentions_by_engine` (jsonb per-AI-engine), `top_competitors` (jsonb, by
  citation count), and the full upstream payload in `raw`. `aggregate_run_id` links it
  to the aggregate run. Raw counts only — no score. `status='failed'` + `error` when the
  fetch failed; the visibility run still succeeds. Kept flat + raw for time-series:
  a snapshot means little alone, the week-over-week deltas are the value.

See `src/db/schema.ts` for the full column list. Migrations are auto-applied at boot
(`drizzle-orm/postgres-js/migrator`).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL` | ✅ | Postgres connection string (Neon recommended) |
| `AI_VISIBILITY_SCORE_SERVICE_API_KEY` | ✅ | Inbound `x-api-key` value |
| `CHAT_SERVICE_URL` | ✅ | Base URL for chat-service `/complete` |
| `CHAT_SERVICE_API_KEY` | ✅ | Outbound key for chat-service |
| `BRAND_SERVICE_URL` | ✅ | Base URL for brand-service |
| `BRAND_SERVICE_API_KEY` | ✅ | Outbound key for brand-service |
| `RUNS_SERVICE_URL` | ✅ | Base URL for runs-service |
| `RUNS_SERVICE_API_KEY` | ✅ | Outbound key for runs-service |
| `AHREF_SERVICE_URL` | ✅ | Base URL for ahref-service (Ahrefs Brand-Radar AI-visibility) |
| `AHREF_SERVICE_API_KEY` | ✅ | Outbound key for ahref-service |
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
- **400 "x-brand-id header is required"** — POST without the `x-brand-id` header.
- **400 "x-brand-id header must be a valid UUID"** — header is present but malformed.
- **400 "x-brand-id header must contain exactly one brand id (co-branding not supported)"** —
  caller passed a comma-separated list. Issue one run per brand instead.
- **400 "Invalid request"** — request body is not strictly `{}`. The body schema is
  closed; any field is rejected. All run configuration is server-side and not
  caller-configurable.
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
