import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { visibilityScoreRuns } from "../db/schema.js";

// A run inserts its parent row as `running` and flips it to a terminal state when it
// finishes. If the process is killed mid-run (redeploy, crash, proxy timeout) the row
// is left stuck in `running` forever. We clean these up LAZILY, on read: the list
// endpoint flips any run still `running` past this threshold to `failed` before it
// returns, so the dashboard never shows a phantom in-flight run.
//
// On-read (instead of a background timer) is deliberate: a setInterval cron pinged the
// DB every 5 min, which kept Neon's compute awake 24/7 (defeating scale-to-zero) AND
// raced the suspend window (`write CONNECTION_CLOSED` on a just-closed socket). Reaping
// inside an existing request means zero periodic DB calls when idle — the compute can
// suspend — and the cleanup always runs on a live, already-open connection.
//
// Threshold is generous — a real run is minutes, not half an hour.
export const STUCK_RUN_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

/**
 * Flip every run stuck in `running` past STUCK_RUN_THRESHOLD_MS to `failed`. Returns the
 * number of rows reaped. Rows with a null `startedAt` are never matched (NULL comparison),
 * so only genuinely-stuck rows are touched. Call from a read path (e.g. list) so stale
 * phantoms are cleaned just before they would be shown; no background timer needed.
 */
export async function reapStaleRuns(now: Date = new Date()): Promise<number> {
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
      `[ai-visibility-score-service] reaped ${reaped.length} stale run(s) (stuck 'running') to 'failed'`,
    );
  }
  return reaped.length;
}
