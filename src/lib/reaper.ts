import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { visibilityScoreRuns } from "../db/schema.js";

// A run inserts its parent row as `running` and flips it to a terminal state when it
// finishes. If the process is killed mid-run (redeploy, crash, proxy timeout) the row
// is left stuck in `running` forever. The reaper is the backstop: any run still
// `running` past this threshold is flipped to `failed` so the dashboard never shows a
// phantom in-flight run, and the (already-spent) per-judge child rows it persisted stay
// queryable. Threshold is generous — a real run is minutes, not half an hour.
export const STUCK_RUN_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
export const REAPER_TICK_MS = 5 * 60 * 1000; // 5 min

/**
 * Flip every run stuck in `running` past STUCK_RUN_THRESHOLD_MS to `failed`. Returns the
 * number of rows reaped. Rows with a null `startedAt` are never matched (NULL comparison),
 * so only genuinely-stuck rows are touched.
 */
export async function reapStuckRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_RUN_THRESHOLD_MS);
  const reaped = await db
    .update(visibilityScoreRuns)
    .set({
      status: "failed",
      error:
        "[ai-visibility-score-service] reaper: run stuck in 'running' beyond threshold (process likely killed mid-run)",
      completedAt: now,
    })
    .where(and(eq(visibilityScoreRuns.status, "running"), lt(visibilityScoreRuns.startedAt, cutoff)))
    .returning({ id: visibilityScoreRuns.id });

  if (reaped.length > 0) {
    console.warn(
      `[ai-visibility-score-service] reaper flipped ${reaped.length} stuck run(s) to 'failed'`,
    );
  }
  return reaped.length;
}

/**
 * Start the periodic stuck-run reaper. Fire-and-forget: a tick failure is logged loud and
 * never propagates. Returned timer is unref'd so it never keeps the process alive on its
 * own. Call AFTER app.listen() — never on the boot path before the port binds.
 */
export function startStuckRunReaper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    reapStuckRuns().catch((err) =>
      console.error("[ai-visibility-score-service] reaper tick failed:", err),
    );
  }, REAPER_TICK_MS);
  timer.unref?.();
  return timer;
}
