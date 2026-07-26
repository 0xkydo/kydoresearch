import type { StatusReport } from "../../src/orchestrator.ts";

/** Compact status lines for the pi widget and /autoresearch status. */
export function renderStatusLines(challengeName: string, report: StatusReport): string[] {
  const godLine =
    report.godTriggerThreshold > 0
      ? `dry streak ${report.dryLoopStreak}/${report.godTriggerThreshold} (god in ${Math.max(
          0,
          report.godTriggerThreshold - report.dryLoopStreak,
        )})`
      : "god trigger off";
  const lines = [
    `autoresearch · ${challengeName} · loop ${report.loop} · phase ${report.phase}`,
    `best local ${report.bestScore ?? "—"} · submitted ${report.bestSubmittedScore ?? "—"} · ${godLine}`,
  ];
  if (report.ideas.length > 0) {
    lines.push(
      "ideas: " +
        report.ideas
          .map((i) => `${i.id} ${i.status}${i.status === "verifying" || i.status === "implementing" ? ` (attempt ${i.verifyAttempts + 1})` : ""}${i.localScore !== undefined ? ` [${i.localScore}]` : ""}`)
          .join(" · "),
    );
  }
  if (report.metaHarness) {
    lines.push(
      `metaharness: ${report.metaHarness.phase} · generation ${report.metaHarness.generation} · ` +
        `champion ${report.metaHarness.championCandidateId}` +
        (report.metaHarness.activeCandidateId
          ? ` · evaluating ${report.metaHarness.activeCandidateId}`
          : "") +
        (report.metaHarness.recoveryAttempts > 0
          ? ` · recovery ${report.metaHarness.recoveryAttempts}`
          : ""),
    );
  }
  lines.push(`advisor: ${report.lastAdvisorNotes.length} note(s) last loop · taskboard: ${report.taskboardOpen} open`);
  return lines;
}
