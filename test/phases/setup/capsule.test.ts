import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateResearchTask } from "../../../src/experiments.ts";
import { loadState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  readJournalPhases,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";

describe("Setup phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("persists readiness that initialization can consume and stops before Professor", async () => {
    harness = await createPhaseHarness();
    const state = loadState(harness.stateDir);
    const taskPath = path.join(harness.stateDir, "loops/init/setup-task.json");
    const task = validateResearchTask(JSON.parse(fs.readFileSync(taskPath, "utf8")));

    expect(task.kind).toBe("init.explore");
    expect(state).toMatchObject({
      phase: "ready",
      bestCandidateId: "baseline",
      challenge: {
        verifyCommand: "./verify.sh",
        benchCommand: "./benchmark.sh",
      },
    });
    expect(fs.existsSync(
      path.join(harness.stateDir, "runs/baseline/source/src/solution/params.json"),
    )).toBe(true);
    expect(harness.effects.runnerCalls.map((call) => call.kind)).toEqual(["init.explore"]);
    expect(readJournalPhases(harness.stateDir)).not.toContain("loop.proposing");
    expect(fs.existsSync(path.join(harness.stateDir, "loops/loop-001"))).toBe(false);
  });
});
