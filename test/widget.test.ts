import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/orchestrator.ts";
import {
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
      recentActivity: [
        "baseline attempt 1/2 failed: local teacher-forced token mismatch",
        "Setup identified the documented reduced local mode",
      ],
    });
    const rendered = lines.join("\n");

    expect(rendered).toContain("autoresearch · mlxfast-challenge · initialization");
    expect(rendered).toContain("stage: Setup is reviewing the failed baseline");
    expect(rendered).toContain("attempt 1/2");
    expect(rendered).toContain("command: MLXFAST_SCORE_PATH=score.json");
    expect(rendered).toContain("log: .autoresearch/logs/benchmark.log");
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

    expect(rendered).toContain("status: failed");
    expect(rendered).toContain("cannot provide a reliable correctness result");
    expect(rendered).toContain("retry: /autoresearch");
  });
});

describe("autoresearch status rendering", () => {
  it("shows candidate intent, lineage, progress, scores, failures, and recent activity", () => {
    const report: StatusReport = {
      phase: "loop.ideas",
      loop: 4,
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
    };

    const lines = renderStatusLines("demo", report, {
      recentActivity: [
        "L004-I3 · benched: local score 8.5",
        "benchmark queue advanced",
      ],
    });
    const rendered = lines.join("\n");

    expect(rendered).toContain("researching candidates");
    expect(rendered).toContain("1 active · 1 queued/benching · 1 failed");
    expect(rendered).toContain("L004-I1 · verifying 2/3 · parent L002-I2");
    expect(rendered).toContain("Fuse the lookup passes");
    expect(rendered).toContain("L004-I2 · failed · parent baseline");
    expect(rendered).toContain("TypeError: cache key was undefined");
    expect(rendered).toContain("L004-I3 · benching · parent L002-I2 · score 8.5 (1.5 better)");
    expect(rendered).toContain("recent:");
    expect(rendered).toContain("L004-I3 · benched: local score 8.5");
    expect(rendered).toContain("/autoresearch inspect <candidate>");
  });
});
