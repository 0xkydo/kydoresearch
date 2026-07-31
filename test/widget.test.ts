import { describe, expect, it } from "vitest";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { StatusReport } from "../src/orchestrator.ts";
import {
  renderStatusDashboardLines,
  renderInitializationLines,
  renderStatusLines,
} from "../extensions/autoresearch/widget.ts";

describe("autoresearch initialization rendering", () => {
  it("keeps setup-agent and benchmark progress visible with logs and attempts", () => {
    const lines = renderInitializationLines("mlxfast-challenge", {
      stage: "baseline-review",
      status: "running",
      message: "Setup is reviewing the failed baseline command",
      command: "MLXFAST_SCORE_PATH=score.json ./benchmark.sh --local-iterate",
      attempt: 1,
      maxAttempts: 2,
      logPath: ".autoresearch/logs/benchmark.log",
      localEvaluation: {
        fidelity: "reduced",
        decision: "Use the documented local-iterate mode.",
        limitations: ["The official evaluator path is not exercised locally."],
        officialValidationRequired: true,
      },
      recentActivity: [
        "baseline attempt 1/2 failed: local teacher-forced token mismatch",
        "Setup identified the documented reduced local mode",
      ],
    });
    const rendered = lines.join("\n");

    expect(rendered).toContain("╭─ AUTORESEARCH · mlxfast-challenge");
    expect(rendered).toContain("● RUNNING · INITIALIZATION");
    expect(rendered).toContain("Baseline recovery decision");
    expect(rendered).toContain("Setup is reviewing the failed baseline");
    expect(rendered).toContain("attempt 1/2");
    expect(rendered).toContain("△ REDUCED LOCAL EVALUATION · official validation required");
    expect(rendered).toContain("command  MLXFAST_SCORE_PATH=score.json");
    expect(rendered).toContain("log      .autoresearch/logs/benchmark.log");
    expect(rendered).toContain("local teacher-forced token mismatch");
  });

  it("keeps an actionable initialization failure on screen", () => {
    const rendered = renderInitializationLines("mlxfast-challenge", {
      stage: "baseline",
      status: "failed",
      message: "Baseline benchmark failed after Setup review",
      failure:
        "The local benchmark cannot provide a reliable correctness result on this hardware.",
      logPath: ".autoresearch/logs/benchmark.log",
      recentActivity: [],
    }).join("\n");

    expect(rendered).toContain("! STOPPED · INITIALIZATION");
    expect(rendered).toContain("Needs attention");
    expect(rendered).toContain("cannot provide a reliable correctness result");
    expect(rendered).toContain("Retry /autoresearch");
  });

  it("renders the durable checklist and final readiness contract", () => {
    const report = {
      schemaVersion: 1 as const,
      challengeName: "mlxfast-challenge",
      status: "ready-with-limitations" as const,
      currentStep: "archive" as const,
      steps: [
        { id: "validate" as const, label: "Validate challenge", status: "passed" as const },
        { id: "setup" as const, label: "Install dependencies", status: "passed" as const },
        { id: "setup-agent" as const, label: "Map hardware", status: "passed" as const },
        { id: "baseline" as const, label: "Measure baseline", status: "passed" as const },
        { id: "archive" as const, label: "Archive baseline", status: "passed" as const },
      ],
      recentActivity: ["baseline 12 · ready with limitations"],
      updatedAt: "2026-07-26T12:00:00.000Z",
      summary: {
        readiness: "ready-with-limitations" as const,
        baselineScore: 12,
        direction: "-" as const,
        verifyCommand: "./verify.sh --local",
        benchCommand: "./benchmark.sh --local",
        localEvaluation: {
          fidelity: "reduced" as const,
          decision: "Use the documented local mode.",
          limitations: ["Official hardware is still required."],
          officialValidationRequired: true,
        },
        submissionReady: true,
        evidencePath: ".autoresearch/runs/baseline",
      },
    };
    const rendered = renderInitializationLines("mlxfast-challenge", {
      stage: "archive",
      status: "succeeded",
      message: "initialization complete",
      localEvaluation: report.summary.localEvaluation,
      recentActivity: report.recentActivity,
      report,
    }).join("\n");

    expect(rendered).toContain("Setup checklist");
    expect(rendered).toContain("✓ Validate challenge");
    expect(rendered).toContain("△ READY WITH LIMITATIONS · baseline 12");
    expect(rendered).toContain("verify  ./verify.sh --local");
    expect(rendered).toContain("bench   ./benchmark.sh --local");
  });
});

describe("autoresearch status rendering", () => {
  it("shows candidate intent, lineage, progress, scores, failures, and recent activity", () => {
    const report: StatusReport = {
      phase: "loop.ideas",
      loop: 4,
      scoreDirection: "-",
      bestScore: 10,
      bestSubmittedScore: 11,
      dryLoopStreak: 1,
      churchTriggerThreshold: 3,
      ideas: [
        {
          id: "L004-I1",
          title: "Fuse the lookup passes",
          parentCandidateId: "L002-I2",
          status: "verifying",
          verifyAttempts: 1,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
        },
        {
          id: "L004-I2",
          title: "Cache normalized inputs",
          parentCandidateId: "baseline",
          status: "failed",
          verifyAttempts: 3,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
          lastVerifyError: "TypeError: cache key was undefined\nstack omitted",
        },
        {
          id: "L004-I3",
          title: "Remove redundant allocation",
          parentCandidateId: "L002-I2",
          status: "benching",
          verifyAttempts: 1,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
          localScore: 8.5,
        },
      ],
      taskboardOpen: 2,
      lastAdvisorNotes: ["Keep the verifier fixed."],
      localEvaluation: {
        fidelity: "reduced",
        decision: "Use the documented local regression mode.",
        limitations: ["Official hardware correctness is not exercised."],
        officialValidationRequired: true,
      },
    };

    const lines = renderStatusLines("demo", report, {
      recentActivity: [
        "L004-I3 · benched: local score 8.5",
        "benchmark queue advanced",
      ],
      oncallSupervised: false,
    });
    const rendered = lines.join("\n");

    expect(rendered).toContain("RESEARCHING CANDIDATES");
    expect(rendered).toContain("score  10 local · 11 submitted · lower wins");
    expect(rendered).toContain("REDUCED LOCAL EVALUATION");
    expect(rendered).toContain("1 active · 1 queued/benching · 1 failed");
    expect(rendered).toContain("L004-I1 · VERIFYING 2/3 · parent L002-I2");
    expect(rendered).toContain("Fuse the lookup passes");
    expect(rendered).toContain("L004-I2 · FAILED · parent baseline");
    expect(rendered).toContain("TypeError: cache key was undefined");
    expect(rendered).toContain("L004-I3 · BENCHING · parent L002-I2 · score 8.5 (1.5 better)");
    expect(rendered).toContain("Recent activity");
    expect(rendered).toContain("L004-I3 · benched: local score 8.5");
    expect(rendered).toContain("on-call inactive · launch with pi-kydo");
    expect(rendered).toContain("/autoresearch inspect <candidate>");

    const supervised = renderStatusLines("demo", report, {
      oncallSupervised: true,
    }).join("\n");
    expect(supervised).toContain("on-call supervisor active");
  });

  it("renders an uncapped, colored control deck below the editor", () => {
    const report: StatusReport = {
      phase: "loop.ideas",
      loop: 4,
      scoreDirection: "-",
      bestScore: 10,
      bestSubmittedScore: 11,
      dryLoopStreak: 1,
      churchTriggerThreshold: 3,
      ideas: [
        {
          id: "L004-I1",
          title: "Fuse the lookup passes",
          parentCandidateId: "L002-I2",
          status: "verifying",
          verifyAttempts: 1,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
        },
        {
          id: "L004-I2",
          title: "Cache normalized inputs",
          parentCandidateId: "baseline",
          status: "failed",
          verifyAttempts: 3,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
          lastVerifyError: "cache key was undefined",
        },
        {
          id: "L004-I3",
          title: "Remove redundant allocation",
          parentCandidateId: "L002-I2",
          status: "benching",
          verifyAttempts: 1,
          maxVerifyAttempts: 3,
          comparisonScore: 10,
          localScore: 8.5,
        },
      ],
      taskboardOpen: 2,
      lastAdvisorNotes: ["[concern] Keep the verifier fixed."],
      runOverview: {
        experimentsRun: 17,
        remoteAccepted: 3,
        remotePending: 2,
        remoteRejected: 1,
        otherSubmissions: 48,
        loopTokens: 198_000,
        tokenUsageComplete: false,
      },
      localEvaluation: {
        fidelity: "reduced",
        decision: "Use the documented local regression mode.",
        limitations: ["Official hardware correctness is not exercised."],
        officialValidationRequired: true,
      },
    };

    const lines = renderStatusDashboardLines("demo", report, 120, testTheme(), {
      running: true,
      operatorSteering: {
        text: "Prioritize cache locality without weakening correctness.",
        updatedAt: "2026-07-26T10:00:00.000Z",
      },
      recentActivity: [
        "L004-I3 · benched: local score 8.5",
        "benchmark queue advanced",
        "L004-I1 · verifier attempt 2 started",
      ],
      navigator: {
        position: 1,
        total: 4,
        label: "phd L004-I1",
        state: "implement",
        monitorMode: "overview",
        inputMode: "nav",
      },
    });
    const rendered = stripAnsi(lines.join("\n"));

    expect(lines).toHaveLength(5);
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
    expect(lines.join("\n")).toContain("\u001b[1m");
    expect(rendered).toContain(
      "AUTORESEARCH demo · LIVE · LOOP 4 · RESEARCHING CANDIDATES",
    );
    expect(rendered).toContain("AGENT");
    expect(rendered).toContain("1/4  ▸ phd L004-I1 · implement · OVERVIEW · NAV");
    expect(rendered).toContain("RUN");
    expect(rendered).toContain("Experiments 17");
    expect(rendered).toContain("Remote 3 accepted / 2 pending / 1 rejected");
    expect(rendered).toContain("Others 48");
    expect(rendered).toContain("Loop tokens ≥198k");
    expect(rendered).toContain("KEYS");
    expect(rendered).toContain("Enter focus");
    expect(rendered).toContain("Tab composer");
    expect(rendered).not.toContain("├─ CANDIDATES");
    expect(rendered).not.toContain("LIVE ACTIVITY");
    expect(rendered).not.toContain("OBJECTIVE");
    expect(rendered).toContain("L004-I1");
    expect(rendered).not.toContain("widget truncated");
  });
});

function testTheme(): Theme {
  const codes: Record<ThemeColor, number> = {
    accent: 36,
    border: 37,
    borderAccent: 36,
    borderMuted: 90,
    success: 32,
    error: 31,
    warning: 33,
    muted: 90,
    dim: 90,
    text: 37,
    thinkingText: 37,
    userMessageText: 37,
    customMessageText: 37,
    customMessageLabel: 37,
    toolTitle: 37,
    toolOutput: 37,
    mdHeading: 37,
    mdLink: 37,
    mdLinkUrl: 37,
    mdCode: 37,
    mdCodeBlock: 37,
    mdCodeBlockBorder: 37,
    mdQuote: 37,
    mdQuoteBorder: 37,
    mdHr: 37,
    mdListBullet: 37,
    toolDiffAdded: 32,
    toolDiffRemoved: 31,
    toolDiffContext: 37,
    syntaxComment: 37,
    syntaxKeyword: 37,
    syntaxFunction: 37,
    syntaxVariable: 37,
    syntaxString: 37,
    syntaxNumber: 37,
    syntaxType: 37,
    syntaxOperator: 37,
    syntaxPunctuation: 37,
    thinkingOff: 37,
    thinkingMinimal: 37,
    thinkingLow: 37,
    thinkingMedium: 37,
    thinkingHigh: 37,
    thinkingXhigh: 37,
    thinkingMax: 37,
    bashMode: 37,
  };
  return {
    fg: (color: ThemeColor, text: string) => `\u001b[${codes[color]}m${text}\u001b[0m`,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  } as Theme;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
