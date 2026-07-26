import type { StatusReport } from "../../src/orchestrator.ts";

/** Compact status lines for the pi widget and /autoresearch status. */
export function renderStatusLines(challengeName: string, report: StatusReport): string[] {
  const churchLine =
    report.churchTriggerThreshold > 0
      ? `dry streak ${report.dryLoopStreak}/${report.churchTriggerThreshold} (church in ${Math.max(
          0,
          report.churchTriggerThreshold - report.dryLoopStreak,
        )})`
      : "church trigger off";
  const lines = [
    `autoresearch · ${challengeName} · loop ${report.loop} · phase ${report.phase}`,
    `best local ${report.bestScore ?? "—"} · submitted ${report.bestSubmittedScore ?? "—"} · ${churchLine}`,
  ];
  if (report.ideas.length > 0) {
    lines.push(
      "ideas: " +
        report.ideas
          .map((i) => `${i.id} ${i.status}${i.status === "verifying" || i.status === "implementing" ? ` (attempt ${i.verifyAttempts + 1})` : ""}${i.localScore !== undefined ? ` [${i.localScore}]` : ""}`)
          .join(" · "),
    );
  }
  if (report.recovery) {
    lines.push(
      `recovery: ${report.recovery.scope} failed ${report.recovery.consecutiveFailures}× · ` +
        `${report.recovery.message}${report.recovery.nextRetryAt ? ` · retry ${report.recovery.nextRetryAt}` : ""}`,
    );
  }
  lines.push(`advisor: ${report.lastAdvisorNotes.length} note(s) last loop · taskboard: ${report.taskboardOpen} open`);
  return lines;
}
