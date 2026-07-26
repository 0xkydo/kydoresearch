import type { StatusReport } from "../../src/orchestrator.ts";
import type { LocalEvaluationV1 } from "../../src/experiments.ts";

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
  localEvaluation?: LocalEvaluationV1;
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
  const status = initializationStatus(state.status);
  const lines = [
    `╭─ AUTORESEARCH · ${challengeName}`,
    `│  ${status.icon} ${status.label} · INITIALIZATION`,
    `├─ ${initializationStageLabel(state.stage)}`,
    `│  ${oneLine(state.message, 108)}${attempt}`,
  ];
  if (state.localEvaluation) {
    lines.push("├─ Local evaluation");
    lines.push(...renderLocalEvaluation(state.localEvaluation));
  }
  if (state.command || state.logPath) {
    lines.push("├─ Runtime");
    if (state.command) lines.push(`│  command  ${oneLine(state.command, 102)}`);
    if (state.logPath) lines.push(`│  log      ${oneLine(state.logPath, 106)}`);
  }
  if (state.failure) {
    lines.push("├─ Needs attention");
    lines.push(`│  ${oneLine(state.failure, 108)}`);
  }
  const activity = state.recentActivity.filter(Boolean).slice(0, 3);
  if (activity.length > 0) {
    lines.push("├─ Recent activity");
    lines.push(...activity.map((entry) => `│  · ${oneLine(entry, 104)}`));
  }
  if (state.status === "failed") {
    lines.push("╰─ Retry /autoresearch after resolving the reported issue");
  } else {
    lines.push("╰─ Live evidence · /autoresearch telemetry");
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
      ? `plateau ${report.dryLoopStreak}/${report.churchTriggerThreshold} · church in ${Math.max(
          0,
          report.churchTriggerThreshold - report.dryLoopStreak,
        )}`
      : "church trigger off";
  const lines = [
    `╭─ AUTORESEARCH · ${challengeName}`,
    `│  ${phaseIcon(report.phase)} LOOP ${report.loop} · ${PHASE_LABELS[report.phase].toUpperCase()}`,
    `│  score  ${report.bestScore ?? "—"} local · ${report.bestSubmittedScore ?? "—"} submitted · ${scoreDirectionLabel(report.scoreDirection)}`,
    `│  ${churchLine}`,
  ];
  if (report.localEvaluation) {
    lines.push("├─ Local evaluation");
    lines.push(...renderLocalEvaluation(report.localEvaluation));
  }
  if (report.ideas.length > 0) {
    lines.push(`├─ Candidates · ${renderCandidateCounts(report)}`);
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
      lines.push(
        `│  ${candidateIcon(idea.status)} ${idea.id} · ${candidateStatusLabel(idea.status)}${attempt}${parent}${score}`,
      );
      lines.push(`│     ${oneLine(idea.title, 100)}`);
      if (idea.lastVerifyError) {
        lines.push(`│     ! ${oneLine(idea.lastVerifyError, 100)}`);
      }
    }
  }
  if (report.recovery) {
    lines.push("├─ Recovery");
    lines.push(
      `│  ↻ ${report.recovery.scope} · ${report.recovery.consecutiveFailures} failure(s) · ` +
        `${oneLine(report.recovery.message, 76)}${report.recovery.nextRetryAt ? ` · retry ${report.recovery.nextRetryAt}` : ""}`,
    );
  }
  if (report.metaHarness) {
    lines.push("├─ Meta-harness");
    lines.push(
      `│  ${report.metaHarness.phase} · generation ${report.metaHarness.generation} · ` +
        `champion ${report.metaHarness.championCandidateId}` +
        (report.metaHarness.activeCandidateId
          ? ` · evaluating ${report.metaHarness.activeCandidateId}`
          : "") +
        (report.metaHarness.recoveryAttempts > 0
          ? ` · recovery ${report.metaHarness.recoveryAttempts}`
          : ""),
    );
  }
  lines.push("├─ Research controls");
  lines.push(
    `│  advisor ${report.lastAdvisorNotes.length} note(s) · taskboard ${report.taskboardOpen} open`,
  );
  const activity = (options.recentActivity ?? []).filter(Boolean).slice(0, 3);
  if (activity.length > 0) {
    lines.push("├─ Recent activity");
    lines.push(...activity.map((entry) => `│  · ${oneLine(entry, 104)}`));
  }
  lines.push("╰─ Inspect /autoresearch inspect <candidate> · Timing /autoresearch telemetry");
  return lines;
}

function renderCandidateCounts(report: StatusReport): string {
  if (report.ideas.length === 0) return "none";
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
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function initializationStatus(
  status: InitializationRenderState["status"],
): { icon: string; label: string } {
  switch (status) {
    case "running":
      return { icon: "●", label: "RUNNING" };
    case "retrying":
      return { icon: "↻", label: "RETRYING" };
    case "succeeded":
      return { icon: "✓", label: "COMPLETE" };
    case "failed":
      return { icon: "!", label: "STOPPED" };
    case "resuming":
      return { icon: "↻", label: "RESUMING" };
  }
}

function initializationStageLabel(stage: InitializationStage): string {
  switch (stage) {
    case "setup":
      return "Dependency setup";
    case "setup-agent":
      return "Repository and hardware decision";
    case "baseline":
      return "Local baseline";
    case "baseline-review":
      return "Baseline recovery decision";
    case "ready":
      return "Ready";
  }
}

function renderLocalEvaluation(evaluation: LocalEvaluationV1): string[] {
  const reduced = evaluation.fidelity === "reduced";
  const lines = [
    `│  ${reduced ? "△" : "✓"} ${evaluation.fidelity.toUpperCase()} LOCAL EVALUATION${
      evaluation.officialValidationRequired ? " · official validation required" : ""
    }`,
    `│  ${oneLine(evaluation.decision, 106)}`,
  ];
  for (const limitation of evaluation.limitations.slice(0, 2)) {
    lines.push(`│  · ${oneLine(limitation, 104)}`);
  }
  return lines;
}

function phaseIcon(phase: StatusReport["phase"]): string {
  if (phase === "done") return "✓";
  if (phase === "paused") return "!";
  if (phase === "ready" || phase === "uninitialized") return "○";
  return "●";
}

function scoreDirectionLabel(direction: "+" | "-" | undefined): string {
  if (direction === "+") return "higher wins";
  if (direction === "-") return "lower wins";
  return "direction unknown";
}

function candidateIcon(status: string): string {
  if (status === "failed") return "×";
  if (status === "done-improved") return "◆";
  if (status.startsWith("done-")) return "✓";
  if (status === "implementing" || status === "verifying" || status === "benching") {
    return "◐";
  }
  return "○";
}

function candidateStatusLabel(status: string): string {
  return status.replaceAll("-", " ").toUpperCase();
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
