import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentActivityRecorder } from "../src/agent-activity.ts";
import { loadRunOverviewStatus } from "../src/orchestrator.ts";
import { statePaths } from "../src/state.ts";

describe("durable Run Overview counters", () => {
  it("counts sealed experiments, accepted submissions, others, and current-loop tokens", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "autoresearch-run-overview-"),
    );
    try {
      const paths = statePaths(stateDir);
      fs.writeFileSync(
        paths.ledger,
        [
          ledger("L001-I1", "done-improved"),
          ledger("L002-I1", "done-no-improvement"),
          ledger("L003-I1", "done-improved"),
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      fs.writeFileSync(
        paths.leaderboard,
        JSON.stringify({
          fetchedAt: "2026-07-26T12:00:00.000Z",
          entries: Array.from({ length: 5 }, (_, index) => ({
            id: `submission-${index}`,
            score: index,
            author: `author-${index}`,
            promoted: index === 0,
          })),
        }),
      );

      terminalUsage(stateDir, "professor-loop-4", "professor", 4, 120);
      terminalUsage(stateDir, "phd-loop-4", "phd", 4, 80);
      terminalUsage(stateDir, "setup-loop-4", "setup", 4, 1_000);
      terminalUsage(stateDir, "phd-loop-3", "phd", 3, 2_000);

      expect(loadRunOverviewStatus(stateDir, 4)).toEqual({
        experimentsRun: 3,
        remoteAccepted: 2,
        otherSubmissions: 3,
        loopTokens: 200,
        tokenUsageComplete: true,
        leaderboardUpdatedAt: "2026-07-26T12:00:00.000Z",
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

function terminalUsage(
  stateDir: string,
  invocationId: string,
  role: "professor" | "phd" | "setup",
  loop: number,
  tokens: number,
): void {
  const recorder = createAgentActivityRecorder(stateDir, {
    invocationId,
    role,
    kind:
      role === "professor"
        ? "propose"
        : role === "phd"
          ? "implement"
          : "init.explore",
    loop,
  });
  recorder.start();
  recorder.terminal("complete", {
    cost: 0,
    turns: 1,
    tokens: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens,
      complete: true,
    },
  });
}

function ledger(
  candidateId: string,
  terminalStatus:
    | "done-improved"
    | "done-no-improvement",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    candidateId,
    parentCandidateId: "baseline",
    title: candidateId,
    terminalStatus,
    searchMode: "exploit",
    editFamily: "test",
    comparisonScore: 1,
    improved: terminalStatus === "done-improved",
    runPath: `runs/${candidateId}`,
    recordedAt: "2026-07-26T12:00:00.000Z",
  };
}
