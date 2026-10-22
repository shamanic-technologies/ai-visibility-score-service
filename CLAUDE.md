# ai-visibility-score-service

## Release flow — NO `release.sh` in this repo

Unlike most shamanic-technologies services, this repo has **no `release.sh`** and **no `.github/workflows`**. Do not look for `release.sh hotfix` — it does not exist here. Ship via plain `gh` + Railway auto-deploy on branch push.

- **Branches:** `main` = prod, `staging` = pre-prod. Both are checked out in sibling Conductor worktrees (cannot `git checkout main` locally — branch off `origin/main` / `origin/staging` directly).
- **Normal feature/bugfix:** branch from `origin/staging` → PR base `staging` → `gh pr merge --squash`. Promote to prod later via a `staging → main` promote PR (see merged PRs #44/#45 titled `promote: ...` / `chore: promote staging to vX`).
- **Hotfix (prod-direct):** branch from `origin/main` → PR base `main` → `gh pr merge --squash`. Established pattern (PR #36 `hotfix/prompt-gen-v2`).
- **Hotfix back-sync (MANDATORY):** because there is no `release.sh` to auto-sync, a hotfix merged to `main` leaves `staging` behind on the old code. **Cherry-pick the hotfix commit onto a branch off `origin/staging` and merge a sync PR to `staging`** — otherwise the next `staging → main` promote PR reverts the hotfix. (Done for the Sonnet→Haiku judge swap: prod #46 + staging-sync #47.)
- Merge method: `gh pr merge <N> --squash` (omit `--delete-branch` — `main`/`staging` worktree clash). No `--auto` needed (no required CI checks).

## Visibility run config

All LLM provider/model choices live server-side in `src/lib/config.ts` (`VISIBILITY_RUN_CONFIG`) — NOT caller-configurable. Changing a model = ship a new version.

- **Measured panel (judges / "panelists"):** answer-engines that answer each prompt **with native web grounding**. Today: `google/flash` + `anthropic/haiku`. The integration test `tests/integration/runs.test.ts` ("calls runVisibilityScore with server-side config values") asserts the exact judge list — update it whenever the config changes, or it fails.
- **Prompt-gen + extraction:** `google/flash` (the extractor is the ungrounded scorer; "judge" ≠ final scorer — see DIS-208 rename proposal).
- Model aliases (`flash`/`pro`/`sonnet`/`haiku`/`opus`) are resolved to real model IDs by chat-service; the schema in `src/schemas.ts` + `src/lib/chat-client.ts` gates the accepted set.
