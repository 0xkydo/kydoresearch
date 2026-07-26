import type { StatusReport } from "../../src/orchestrator.ts";

export interface StatusRenderOptions {
  recentActivity?: string[];
}

export type InitializationStage =
  | "setup"
  | "setup-agent"
  | "baseline"
  | "baseline-review"
  | "ready";

export interface InitializationRenderState {
  stage: InitializationStage;
  status: "running" | "retrying" | "succeeded" | "failed" | "resuming";
  message: string;
  command?: string;
  attempt?: number;
  maxAttempts?: number;
  logPath?: string;
  failure?: string;
  recentActivity: string[];
}

const PHASE_LABELS: Record<StatusReport["phase"], string> = {
  uninitialized: "waiting for initialization",
  "init.setup": "installing challenge dependencies",
  "init.knowledge": "mapping the challenge",
  ready: "ready to start",
  "loop.syncing": "syncing leaderboard evidence",
  "loop.proposing": "Professor is proposing experiments",
  "loop.ideas": "researching candidates",
  "loop.finalizing": "selecting and validating a winner",
  "loop.end": "archiving loop evidence",
  church: "Professor is reflecting in church",
  god: "Professor is reflecting in church",
  paused: "paused",
  done: "complete",
};

/** Persistent status shown while first-run setup and baseline work is active. */
export function renderInitializationLines(
  challengeName: string,
  state: InitializationRenderState,
): string[] {
  const attempt =
    state.attempt !== undefined
      ? ` · attempt ${state.attempt}${state.maxAttempts ? `/${state.maxAttempts}` : ""}`
      : "";
  const lines = [
    `autoresearch · ${challengeName} · initialization`,
    `stage: ${state.message}${attempt}`,
    `status: ${state.status}`,
  ];
  if (state.command) lines.push(`command: ${oneLine(state.command, 120)}`);
  if (state.logPath) lines.push(`log: ${state.logPath}`);
  if (state.failure) lines.push(`failure: ${oneLine(state.failure, 180)}`);
  const activity = state.recentActivity.filter(Boolean).slice(0, 3);
  if (activity.length > 0) {
    lines.push("recent:");
    lines.push(...activity.map((entry) => `  ${oneLine(entry, 140)}`));
  }
  if (state.status === "failed") {
    lines.push("retry: /autoresearch after resolving the reported issue");
  } else {
    lines.push("details: /autoresearch telemetry");
  }
  return lines;
}

/** Human-readable status lines for the live Pi widget and /autoresearch status. */
export function renderStatusLines(
  challengeName: string,
  report: StatusReport,
  options: StatusRenderOptions = {},
): string[] {
  const churchLine =
    report.churchTriggerThreshold > 0
      ? `dry streak ${report.dryLoopStreak}/${report.churchTriggerThreshold} (church in ${Math.max(
          0,
          report.churchTriggerThreshold - report.dryLoopStreak,
        )})`
      : "church trigger off";
  const lines = [
    `autoresearch · ${challengeName} · loop ${report.loop} · phase ${report.phase}`,
    `stage: ${PHASE_LABELS[report.phase]}${renderCandidateCounts(report)}`,
    `best local ${report.bestScore ?? "—"} · submitted ${report.bestSubmittedScore ?? "—"} · ${churchLine}`,
  ];
  if (report.ideas.length > 0) {
    lines.push("candidates:");
    for (const idea of report.ideas) {
      const maxAttempts = idea.maxVerifyAttempts;
      const attempt =
        idea.status === "implementing" || idea.status === "verifying"
          ? ` ${idea.verifyAttempts + 1}${maxAttempts ? `/${maxAttempts}` : ""}`
          : "";
      const parent = idea.parentCandidateId ? ` · parent ${idea.parentCandidateId}` : "";
      const score =
        idea.localScore !== undefined
          ? ` · score ${idea.localScore}${scoreDelta(idea.localScore, idea.comparisonScore, report.scoreDirection)}`
          : "";
      lines.push(`  ${idea.id} · ${idea.status}${attempt}${parent}${score}`);
      lines.push(`    ${oneLine(idea.title, 100)}`);
      if (idea.lastVerifyError) {
        lines.push(`    last failure: ${oneLine(idea.lastVerifyError, 110)}`);
      }
    }
  }
  if (report.recovery) {
    lines.push(
      `recovery: ${report.recovery.scope} failed ${report.recovery.consecutiveFailures}× · ` +
        `${report.recovery.message}${report.recovery.nextRetryAt ? ` · retry ${report.recovery.nextRetryAt}` : ""}`,
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
  const activity = (options.recentActivity ?? []).filter(Boolean).slice(0, 3);
  if (activity.length > 0) {
    lines.push("recent:");
    lines.push(...activity.map((entry) => `  ${oneLine(entry, 120)}`));
  }
  lines.push("details: /autoresearch inspect <candidate> · timing: /autoresearch telemetry");
  return lines;
}

function renderCandidateCounts(report: StatusReport): string {
  if (report.ideas.length === 0) return "";
  const active = report.ideas.filter(
    (idea) => idea.status === "implementing" || idea.status === "verifying",
  ).length;
  const queued = report.ideas.filter(
    (idea) => idea.status === "proposed" || idea.status === "benching",
  ).length;
  const failed = report.ideas.filter((idea) => idea.status === "failed").length;
  const completed = report.ideas.length - active - queued - failed;
  const parts = [
    active > 0 ? `${active} active` : "",
    queued > 0 ? `${queued} queued/benching` : "",
    completed > 0 ? `${completed} complete` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function scoreDelta(
  score: number,
  comparisonScore: number | null | undefined,
  direction: "+" | "-" = "-",
): string {
  if (comparisonScore === null || comparisonScore === undefined) return "";
  const improvement = direction === "+" ? score - comparisonScore : comparisonScore - score;
  if (improvement === 0) return " (same as parent)";
  return ` (${formatNumber(Math.abs(improvement))} ${improvement > 0 ? "better" : "worse"})`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}
