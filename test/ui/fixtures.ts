import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { StatusReport } from "../../src/orchestrator.ts";
import type { IdeaStatus, Phase } from "../../src/phases.ts";

export const ALL_PHASES: Phase[] = [
  "uninitialized",
  "init.setup",
  "init.knowledge",
  "ready",
  "loop.syncing",
  "loop.reviewing-submissions",
  "loop.proposing",
  "loop.ideas",
  "loop.finalizing",
  "loop.end",
  "church",
  "god",
  "paused",
  "done",
];

export const ALL_IDEA_STATUSES: IdeaStatus[] = [
  "proposed",
  "implementing",
  "verifying",
  "benching",
  "failed",
  "done-no-improvement",
  "done-superseded",
  "done-improved",
];

export function statusScenario(
  patch: Partial<StatusReport> = {},
): StatusReport {
  return {
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
    ],
    taskboardOpen: 2,
    lastAdvisorNotes: ["[concern] Keep the verifier fixed."],
    localEvaluation: {
      fidelity: "reduced",
      decision: "Use the documented local regression mode.",
      limitations: ["Official hardware correctness is not exercised."],
      officialValidationRequired: true,
    },
    ...patch,
  };
}

export function phaseScenarios(): StatusReport[] {
  return ALL_PHASES.map((phase, index) =>
    statusScenario({
      phase,
      loop: index,
      scoreDirection: index % 2 === 0 ? "+" : "-",
      localEvaluation: index % 3 === 0
        ? {
            fidelity: "full",
            decision: "Use the complete local evaluator.",
            limitations: [],
            officialValidationRequired: false,
          }
        : index % 3 === 1
          ? {
              fidelity: "reduced",
              decision: "Use the documented reduced evaluator.",
              limitations: ["Official hardware remains required."],
              officialValidationRequired: true,
            }
          : undefined,
      recovery: phase === "paused"
        ? {
            scope: "professor.propose",
            message: "provider unavailable",
            consecutiveFailures: 2,
            nextRetryAt: "2026-07-26T01:00:00.000Z",
          }
        : undefined,
      metaHarness: phase === "loop.proposing"
        ? {
            enabled: true,
            phase: "evaluating",
            generation: 2,
            championCandidateId: "H0001",
            activeCandidateId: "H0002",
            recoveryAttempts: 0,
            proposalCooldownRemaining: 0,
            frontierSize: 1,
          }
        : undefined,
    })
  );
}

export function candidateStatusScenario(): StatusReport {
  return statusScenario({
    ideas: ALL_IDEA_STATUSES.map((status, index) => ({
      id: `L004-I${index + 1}`,
      title: `Candidate ${status}`,
      parentCandidateId: index === 0 ? "baseline" : "L003-I1",
      status,
      verifyAttempts: Math.min(index, 3),
      maxVerifyAttempts: 3,
      comparisonScore: 10,
      ...(status === "benching" || status.startsWith("done-")
        ? { localScore: 9 - index / 10 }
        : {}),
      ...(status === "failed" ? { lastVerifyError: "seeded verifier failure" } : {}),
    })),
  });
}

export function testTheme(variant: "light" | "dark" = "dark"): Theme {
  const offset = variant === "light" ? 60 : 30;
  const colors = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
  ] satisfies ThemeColor[];
  const codes = Object.fromEntries(
    colors.map((color, index) => [color, offset + (index % 8)]),
  ) as Record<ThemeColor, number>;
  return {
    fg: (color: ThemeColor, text: string) =>
      `\u001b[${codes[color]}m${text}\u001b[0m`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
    inverse: (text: string) => text,
    dim: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getMarkdownTheme: () => ({}),
    getNestedMarkdownTheme: () => ({}),
  } as unknown as Theme;
}

export function stripTerminalStyles(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
}
