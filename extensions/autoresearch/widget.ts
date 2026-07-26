import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusReport } from "../../src/orchestrator.ts";
import type { LocalEvaluationV1 } from "../../src/experiments.ts";
import type {
  InitializationDiagnosticV1,
  InitializationReportV1,
  InitializationStepStatus,
} from "../../src/initialization.ts";
import type { OperatorSteeringSnapshot } from "../../src/steering.ts";

export interface StatusRenderOptions {
  recentActivity?: string[];
  operatorSteering?: OperatorSteeringSnapshot | null;
  running?: boolean;
}

export type InitializationStage =
  | "validate"
  | "setup"
  | "setup-agent"
  | "baseline"
  | "baseline-review"
  | "archive"
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
  diagnostic?: InitializationDiagnosticV1;
  report?: InitializationReportV1;
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
  if (state.report) {
    lines.push("├─ Setup checklist");
    for (const step of state.report.steps) {
      lines.push(
        `│  ${initializationStepIcon(step.status)} ${step.label}${
          step.attempt !== undefined
            ? ` · attempt ${step.attempt}/${step.maxAttempts ?? "?"}`
            : ""
        }`,
      );
    }
  }
  if (state.localEvaluation) {
    lines.push("├─ Local evaluation");
    lines.push(...renderLocalEvaluation(state.localEvaluation));
  }
  if (state.command || state.logPath) {
    lines.push("├─ Runtime");
    if (state.command) lines.push(`│  command  ${oneLine(state.command, 102)}`);
    if (state.logPath) lines.push(`│  log      ${oneLine(state.logPath, 106)}`);
  }
  if (state.diagnostic) {
    lines.push("├─ Needs attention");
    lines.push(`│  ${state.diagnostic.title}`);
    lines.push(`│  why  ${oneLine(state.diagnostic.reason, 103)}`);
    lines.push(`│  fix  ${oneLine(state.diagnostic.action, 103)}`);
    if (state.diagnostic.evidencePath) {
      lines.push(`│  log  ${oneLine(state.diagnostic.evidencePath, 103)}`);
    }
  } else if (state.failure) {
    lines.push("├─ Needs attention");
    lines.push(`│  ${oneLine(state.failure, 108)}`);
  }
  if (state.report?.summary) {
    const summary = state.report.summary;
    lines.push("├─ Readiness");
    lines.push(
      `│  ${
        summary.readiness === "ready" ? "✓ READY" : "△ READY WITH LIMITATIONS"
      } · baseline ${summary.baselineScore} · ${
        summary.direction === "+" ? "higher" : "lower"
      } wins`,
    );
    lines.push(`│  verify  ${oneLine(summary.verifyCommand, 100)}`);
    lines.push(`│  bench   ${oneLine(summary.benchCommand, 100)}`);
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
  lines.push("├─ Operator direction");
  lines.push(
    options.operatorSteering
      ? `│  ${oneLine(options.operatorSteering.text, 106)}`
      : "│  no active steering · /autoresearch steer <direction>",
  );
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

/**
 * Persistent, theme-aware control deck. Pi caps plain string-array widgets at
 * ten lines; this renderer is used through the custom-component widget path.
 */
export function renderStatusDashboardLines(
  challengeName: string,
  report: StatusReport,
  width: number,
  theme: Theme,
  options: StatusRenderOptions = {},
): string[] {
  const viewport = Math.max(32, width);
  const lines: string[] = [
    dashboardRule(theme, `AUTORESEARCH  ${challengeName}`, viewport, true),
  ];
  const running = options.running === true;
  const runLabel =
    report.phase === "done"
      ? styled(theme, "success", true, "✓ COMPLETE")
      : report.phase === "paused"
        ? styled(theme, "warning", true, "! PAUSED")
        : running
          ? styled(theme, "accent", true, "● LIVE")
          : styled(theme, "warning", true, "○ IDLE");
  lines.push(
    dashboardLine(
      `${runLabel}  ${styled(theme, "text", true, `LOOP ${report.loop}`)}  ` +
        `${styled(theme, phaseColor(report.phase), true, PHASE_LABELS[report.phase].toUpperCase())}`,
      viewport,
    ),
  );
  lines.push(
    dashboardLine(
      `${dashboardLabel(theme, "OBJECTIVE")}  ` +
        `${styled(theme, "accent", true, String(report.bestScore ?? "—"))} local  ` +
        `${styled(theme, "success", true, String(report.bestSubmittedScore ?? "—"))} submitted  ` +
        `${styled(theme, "muted", false, scoreDirectionLabel(report.scoreDirection))}`,
      viewport,
    ),
  );

  const evaluation = report.localEvaluation
    ? report.localEvaluation.fidelity === "full"
      ? styled(theme, "success", true, "✓ FULL LOCAL")
      : styled(theme, "warning", true, "△ REDUCED LOCAL")
    : styled(theme, "muted", false, "evaluation unknown");
  const plateau =
    report.churchTriggerThreshold > 0
      ? `${report.dryLoopStreak}/${report.churchTriggerThreshold} plateau`
      : "church off";
  const recovery = report.recovery
    ? styled(
        theme,
        "error",
        true,
        `recovery ${report.recovery.consecutiveFailures}×`,
      )
    : styled(theme, "success", false, "recovery clear");
  lines.push(
    dashboardLine(
      `${dashboardLabel(theme, "HEALTH")}  ${evaluation}  ·  ` +
        `${styled(
          theme,
          report.dryLoopStreak > 0 ? "warning" : "muted",
          report.dryLoopStreak > 0,
          plateau,
        )}  ·  advisor ${report.lastAdvisorNotes.length}  ·  tasks ${report.taskboardOpen}  ·  ${recovery}`,
      viewport,
    ),
  );

  const steering = options.operatorSteering
    ? styled(
        theme,
        "accent",
        true,
        oneLine(options.operatorSteering.text, Math.max(24, viewport - 17)),
      )
    : styled(
        theme,
        "muted",
        false,
        "No operator direction · /autoresearch steer <direction>",
      );
  lines.push(
    dashboardLine(`${dashboardLabel(theme, "DIRECTION")}  ${steering}`, viewport),
  );

  lines.push(
    dashboardRule(
      theme,
      `CANDIDATES  ${renderCandidateCounts(report)}`,
      viewport,
    ),
  );
  if (report.ideas.length === 0) {
    lines.push(
      dashboardLine(
        styled(
          theme,
          "muted",
          false,
          report.phase === "loop.proposing"
            ? "Professor is forming the next portfolio."
            : "No candidate work is currently materialized.",
        ),
        viewport,
      ),
    );
  } else {
    for (const idea of report.ideas) {
      const attempt =
        idea.status === "implementing" || idea.status === "verifying"
          ? ` ${idea.verifyAttempts + 1}/${idea.maxVerifyAttempts ?? "?"}`
          : "";
      const score =
        idea.localScore !== undefined
          ? `  score ${idea.localScore}${scoreDelta(
              idea.localScore,
              idea.comparisonScore,
              report.scoreDirection,
            )}`
          : "";
      const lineage =
        viewport >= 96 && idea.parentCandidateId
          ? `  ← ${idea.parentCandidateId}`
          : "";
      const titleBudget = Math.max(
        18,
        viewport - visibleWidth(`${idea.id} ${idea.status}${attempt}${score}${lineage}`) - 10,
      );
      const status = `${candidateIcon(idea.status)} ${candidateStatusLabel(idea.status)}${attempt}`;
      lines.push(
        dashboardLine(
          `${styled(theme, candidateColor(idea.status), true, status)}  ` +
            `${styled(theme, "text", true, idea.id)}  ` +
            `${styled(
              theme,
              isActiveCandidate(idea.status) ? "text" : "muted",
              isActiveCandidate(idea.status),
              oneLine(idea.title, titleBudget),
            )}` +
            `${styled(
              theme,
              idea.localScore !== undefined ? scoreColor(
                idea.localScore,
                idea.comparisonScore,
                report.scoreDirection,
              ) : "muted",
              idea.status === "done-improved",
              score + lineage,
            )}`,
          viewport,
        ),
      );
      if (idea.lastVerifyError) {
        lines.push(
          dashboardLine(
            `  ${styled(
              theme,
              "error",
              true,
              `! ${oneLine(idea.lastVerifyError, Math.max(20, viewport - 7))}`,
            )}`,
            viewport,
          ),
        );
      }
    }
  }
  const liveIdea = report.ideas.find((idea) => isActiveCandidate(idea.status));
  if (liveIdea) {
    const evidencePath =
      liveIdea.status === "implementing"
        ? `.autoresearch/runs/${liveIdea.id}/agent/`
        : `.autoresearch/runs/${liveIdea.id}/logs/${
            liveIdea.status === "verifying" ? "verify.log" : "benchmark.log"
          }`;
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "EVIDENCE")}  ${styled(
          theme,
          "muted",
          false,
          evidencePath,
        )}`,
        viewport,
      ),
    );
  }

  if (report.recovery) {
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "RECOVERY")}  ` +
          `${styled(
            theme,
            "error",
            true,
            `${report.recovery.scope} · ${oneLine(
              report.recovery.message,
              Math.max(20, viewport - 30),
            )}`,
          )}`,
        viewport,
      ),
    );
  }
  const advisor = report.lastAdvisorNotes.at(-1);
  if (advisor) {
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "ADVISOR")}  ${styled(
          theme,
          advisor.toLowerCase().includes("[blocker]") ? "error" : "warning",
          true,
          oneLine(advisor, Math.max(20, viewport - 15)),
        )}`,
        viewport,
      ),
    );
  }
  if (report.metaHarness) {
    const activeCandidate = report.metaHarness.activeCandidateId
      ? ` · evaluating ${report.metaHarness.activeCandidateId}`
      : "";
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "META")}  ${styled(
          theme,
          "accent",
          true,
          `${report.metaHarness.phase} · gen ${report.metaHarness.generation} · champion ${report.metaHarness.championCandidateId}${activeCandidate}`,
        )}`,
        viewport,
      ),
    );
  }

  lines.push(dashboardRule(theme, "LIVE ACTIVITY", viewport));
  const activity = (options.recentActivity ?? []).filter(Boolean).slice(0, 3);
  if (activity.length === 0) {
    lines.push(
      dashboardLine(styled(theme, "muted", false, "· Waiting for the next durable event."), viewport),
    );
  } else {
    for (const entry of activity) {
      lines.push(
        dashboardLine(
          `${styled(theme, "accent", true, "·")} ${styled(
            theme,
            "muted",
            false,
            oneLine(entry, Math.max(20, viewport - 5)),
          )}`,
          viewport,
        ),
      );
    }
  }

  lines.push(dashboardRule(theme, "CONTROLS", viewport));
  if (viewport >= 92) {
    lines.push(
      dashboardLine(
        `${dashboardAction(theme, "STEER", "/autoresearch steer <direction>")}   ` +
          `${dashboardAction(theme, "INSPECT", "/autoresearch inspect [id]")}   ` +
          `${dashboardAction(
            theme,
            running ? "PAUSE" : "RESUME",
            running ? "/autoresearch stop" : "/autoresearch",
          )}`,
        viewport,
      ),
    );
  } else {
    lines.push(
      dashboardLine(
        dashboardAction(theme, "STEER", "/autoresearch steer <direction>"),
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        `${dashboardAction(theme, "INSPECT", "/autoresearch inspect [id]")}   ` +
          `${dashboardAction(
            theme,
            running ? "PAUSE" : "RESUME",
            running ? "/autoresearch stop" : "/autoresearch",
          )}`,
        viewport,
      ),
    );
  }
  lines.push(
    truncateToWidth(
      theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, viewport - 1))}`),
      viewport,
    ),
  );
  return lines;
}

/** Theme-aware first-run control deck using the same persistent hierarchy. */
export function renderInitializationDashboardLines(
  challengeName: string,
  state: InitializationRenderState,
  width: number,
  theme: Theme,
): string[] {
  const viewport = Math.max(32, width);
  const status = initializationStatus(state.status);
  const tone =
    state.status === "failed"
      ? "error"
      : state.status === "succeeded"
        ? "success"
        : state.status === "retrying" || state.status === "resuming"
          ? "warning"
          : "accent";
  const attempt =
    state.attempt !== undefined
      ? ` · attempt ${state.attempt}/${state.maxAttempts ?? "?"}`
      : "";
  const lines = [
    dashboardRule(theme, `AUTORESEARCH  ${challengeName}`, viewport, true),
    dashboardLine(
      `${styled(theme, tone, true, `${status.icon} ${status.label}`)}  ` +
        `${styled(theme, "text", true, "INITIALIZATION")}  ·  ` +
        `${styled(theme, "accent", true, initializationStageLabel(state.stage))}${attempt}`,
      viewport,
    ),
    dashboardLine(
      `${dashboardLabel(theme, "NOW")}  ${styled(
        theme,
        state.status === "failed" ? "error" : "text",
        true,
        oneLine(state.message, Math.max(20, viewport - 10)),
      )}`,
      viewport,
    ),
  ];
  if (state.report) {
    lines.push(dashboardRule(theme, "SETUP CHECKLIST", viewport));
    for (const step of state.report.steps) {
      const stepTone =
        step.status === "failed"
          ? "error"
          : step.status === "passed"
            ? "success"
            : step.status === "pending"
              ? "muted"
              : step.status === "retrying" || step.status === "resuming"
                ? "warning"
                : "accent";
      lines.push(
        dashboardLine(
          `${styled(
            theme,
            stepTone,
            true,
            initializationStepIcon(step.status),
          )} ${styled(
            theme,
            stepTone,
            step.id === state.report.currentStep,
            oneLine(step.label, Math.max(20, viewport - 12)),
          )}${
            step.attempt !== undefined
              ? styled(
                  theme,
                  "muted",
                  false,
                  ` · attempt ${step.attempt}/${step.maxAttempts ?? "?"}`,
                )
              : ""
          }`,
          viewport,
        ),
      );
    }
  }
  if (state.localEvaluation) {
    const reduced = state.localEvaluation.fidelity === "reduced";
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "EVALUATION")}  ${styled(
          theme,
          reduced ? "warning" : "success",
          true,
          `${reduced ? "△ REDUCED" : "✓ FULL"} LOCAL${
            state.localEvaluation.officialValidationRequired
              ? " · official validation required"
              : ""
          }`,
        )}`,
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        styled(
          theme,
          "muted",
          false,
          `  ${oneLine(state.localEvaluation.decision, Math.max(20, viewport - 5))}`,
        ),
        viewport,
      ),
    );
  }
  if (state.command || state.logPath) {
    lines.push(dashboardRule(theme, "RUNTIME EVIDENCE", viewport));
    if (state.command) {
      lines.push(
        dashboardLine(
          `${dashboardLabel(theme, "COMMAND")}  ${styled(
            theme,
            "text",
            true,
            oneLine(state.command, Math.max(20, viewport - 14)),
          )}`,
          viewport,
        ),
      );
    }
    if (state.logPath) {
      lines.push(
        dashboardLine(
          `${dashboardLabel(theme, "LOG")}  ${styled(
            theme,
            "muted",
            false,
            oneLine(state.logPath, Math.max(20, viewport - 10)),
          )}`,
          viewport,
        ),
      );
    }
  }
  if (state.diagnostic) {
    lines.push(dashboardRule(theme, "NEEDS ATTENTION", viewport));
    lines.push(
      dashboardLine(
        styled(
          theme,
          "error",
          true,
          `! ${oneLine(state.diagnostic.title, Math.max(20, viewport - 5))}`,
        ),
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "WHY")}  ${styled(
          theme,
          "text",
          false,
          oneLine(state.diagnostic.reason, Math.max(20, viewport - 10)),
        )}`,
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "FIX")}  ${styled(
          theme,
          "warning",
          true,
          oneLine(state.diagnostic.action, Math.max(20, viewport - 10)),
        )}`,
        viewport,
      ),
    );
    if (state.diagnostic.evidencePath) {
      lines.push(
        dashboardLine(
          `${dashboardLabel(theme, "EVIDENCE")}  ${styled(
            theme,
            "muted",
            false,
            oneLine(state.diagnostic.evidencePath, Math.max(20, viewport - 15)),
          )}`,
          viewport,
        ),
      );
    }
  } else if (state.failure) {
    lines.push(dashboardRule(theme, "NEEDS ATTENTION", viewport));
    lines.push(
      dashboardLine(
        styled(
          theme,
          "error",
          true,
          `! ${oneLine(state.failure, Math.max(20, viewport - 5))}`,
        ),
        viewport,
      ),
    );
  }
  if (state.report?.summary) {
    const summary = state.report.summary;
    lines.push(dashboardRule(theme, "READINESS", viewport));
    lines.push(
      dashboardLine(
        styled(
          theme,
          summary.readiness === "ready" ? "success" : "warning",
          true,
          summary.readiness === "ready"
            ? `✓ READY · baseline ${summary.baselineScore}`
            : `△ READY WITH LIMITATIONS · baseline ${summary.baselineScore}`,
        ),
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "VERIFY")}  ${styled(
          theme,
          "text",
          true,
          oneLine(summary.verifyCommand, Math.max(20, viewport - 13)),
        )}`,
        viewport,
      ),
    );
    lines.push(
      dashboardLine(
        `${dashboardLabel(theme, "BENCH")}  ${styled(
          theme,
          "text",
          true,
          oneLine(summary.benchCommand, Math.max(20, viewport - 12)),
        )}`,
        viewport,
      ),
    );
  }
  lines.push(dashboardRule(theme, "LIVE ACTIVITY", viewport));
  const activity = state.recentActivity.filter(Boolean).slice(0, 3);
  if (activity.length === 0) {
    lines.push(
      dashboardLine(styled(theme, "muted", false, "· Waiting for the next durable event."), viewport),
    );
  } else {
    for (const entry of activity) {
      lines.push(
        dashboardLine(
          `${styled(theme, "accent", true, "·")} ${styled(
            theme,
            "muted",
            false,
            oneLine(entry, Math.max(20, viewport - 5)),
          )}`,
          viewport,
        ),
      );
    }
  }
  lines.push(dashboardRule(theme, "CONTROLS", viewport));
  lines.push(
    dashboardLine(
      state.status === "failed"
        ? dashboardAction(theme, "RETRY", "/autoresearch after resolving the issue")
        : dashboardAction(theme, "DETAILS", "/autoresearch telemetry"),
      viewport,
    ),
  );
  lines.push(
    truncateToWidth(
      theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, viewport - 1))}`),
      viewport,
    ),
  );
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
    case "validate":
      return "Challenge validation";
    case "setup":
      return "Dependency setup";
    case "setup-agent":
      return "Repository and hardware decision";
    case "baseline":
      return "Local baseline";
    case "baseline-review":
      return "Baseline recovery decision";
    case "archive":
      return "Baseline archive";
    case "ready":
      return "Ready";
  }
}

function initializationStepIcon(status: InitializationStepStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "running":
      return "●";
    case "retrying":
    case "resuming":
      return "↻";
    case "passed":
      return "✓";
    case "failed":
      return "×";
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

function dashboardRule(
  theme: Theme,
  title: string,
  width: number,
  top = false,
): string {
  const start = theme.fg("borderMuted", top ? "╭─ " : "├─ ");
  const label = theme.fg(top ? "accent" : "muted", theme.bold(` ${title} `));
  const tailWidth = Math.max(0, width - visibleWidth(start + label));
  return truncateToWidth(
    start + label + theme.fg("borderMuted", "─".repeat(tailWidth)),
    width,
  );
}

function dashboardLine(content: string, width: number): string {
  return truncateToWidth(`│  ${content}`, width);
}

function dashboardLabel(theme: Theme, text: string): string {
  return theme.fg("muted", theme.bold(text));
}

function dashboardAction(theme: Theme, label: string, command: string): string {
  return `${theme.fg("accent", theme.bold(label))} ${theme.fg("text", theme.bold(command))}`;
}

function styled(
  theme: Theme,
  color: ThemeColor,
  bold: boolean,
  text: string,
): string {
  return theme.fg(color, bold ? theme.bold(text) : text);
}

function phaseColor(phase: StatusReport["phase"]): ThemeColor {
  if (phase === "done") return "success";
  if (phase === "paused") return "warning";
  if (phase === "uninitialized" || phase === "ready") return "muted";
  return "accent";
}

function candidateColor(status: string): ThemeColor {
  if (status === "failed") return "error";
  if (status === "done-improved") return "success";
  if (status.startsWith("done-")) return "muted";
  if (status === "verifying") return "warning";
  if (status === "implementing" || status === "benching") return "accent";
  return "dim";
}

function isActiveCandidate(status: string): boolean {
  return status === "implementing" || status === "verifying" || status === "benching";
}

function scoreColor(
  score: number,
  comparisonScore: number | null | undefined,
  direction: "+" | "-" = "-",
): ThemeColor {
  if (comparisonScore === null || comparisonScore === undefined) return "accent";
  const improvement = direction === "+" ? score - comparisonScore : comparisonScore - score;
  if (improvement > 0) return "success";
  if (improvement < 0) return "warning";
  return "muted";
}
