import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateRunPaths,
  isCandidateRunSealed,
} from "../../../src/archive.ts";
import { loadState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  readJournalPhases,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";
import { stopAfterPhd } from "../support.ts";

describe("PhD phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("produces bounded candidate and integrity evidence without finalization", async () => {
    harness = await createPhaseHarness();
    await stopAfterPhd(harness);

    const state = loadState(harness.stateDir);
    expect(state?.phase).toBe("paused");
    expect(state?.resumePhase).toBe("loop.finalizing");
    expect(harness.effects.runnerCalls.every((call) => call.kind === "implement")).toBe(true);
    expect(harness.effects.runnerCalls.length).toBeGreaterThan(0);
    expect(harness.effects.events.some((event) => event.type === "submitted")).toBe(false);
    expect(readJournalPhases(harness.stateDir)).not.toContain("loop.end");

    for (const idea of state?.ideas ?? []) {
      const paths = candidateRunPaths(harness.stateDir, idea.id);
      expect(idea.status).toMatch(/benching|failed/);
      expect(fs.existsSync(paths.task)).toBe(true);
      expect(fs.existsSync(paths.integrity)).toBe(true);
      const integrity = JSON.parse(fs.readFileSync(paths.integrity, "utf8")) as {
        candidateId: string;
        passed: boolean;
      };
      expect(integrity).toMatchObject({
        candidateId: idea.id,
        passed: true,
      });
      expect(idea.verifyRecords?.length).toBeGreaterThan(0);
      if (idea.status === "benching") {
        expect(idea.benchmarkRecord).toBeDefined();
      }
      expect(fs.existsSync(paths.metrics)).toBe(false);
      expect(isCandidateRunSealed(harness.stateDir, idea.id)).toBe(false);
    }
  });
});
