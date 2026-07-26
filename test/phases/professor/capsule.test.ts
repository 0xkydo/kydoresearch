import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PhdImplementationTaskV1 } from "../../../src/experiments.ts";
import { validateResearchTask } from "../../../src/experiments.ts";
import { loadState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  readJournalPhases,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";
import { stopAfterProfessor } from "../support.ts";

describe("Professor phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("persists canonical proposals, proves PhD did not run, and builds the next boundary", async () => {
    harness = await createPhaseHarness();
    harness.resetEffects();
    await stopAfterProfessor(harness);

    const state = loadState(harness.stateDir);
    expect(state?.phase).toBe("paused");
    expect(state?.resumePhase).toBe("loop.ideas");
    expect(state?.ideas.length).toBeGreaterThan(0);
    expect(harness.effects.runnerCalls.map((call) => call.kind)).toEqual(["propose"]);
    expect(harness.effects.commands.some((call) =>
      call.command === "/bin/bash" &&
      call.args.some((arg) => arg.includes("verify.sh") || arg.includes("benchmark.sh"))
    )).toBe(false);
    expect(readJournalPhases(harness.stateDir)).not.toContain("loop.finalizing");

    const idea = state?.ideas[0];
    expect(idea).toBeDefined();
    const proposalPath = path.join(harness.stateDir, idea?.proposalFile ?? "");
    const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as {
      schemaVersion: number;
      parentCandidateId: string;
      hypothesis: string;
      falsifiedWhen: string;
    };
    expect(proposal).toMatchObject({
      schemaVersion: 1,
      parentCandidateId: "baseline",
    });
    expect(proposal.hypothesis).not.toBe("");
    expect(proposal.falsifiedWhen).not.toBe("");

    const productionBoundary = harness.makeOrchestrator() as unknown as {
      materializePhdTask(
        candidate: NonNullable<typeof idea>,
        requestedAttempt?: number,
      ): PhdImplementationTaskV1;
    };
    const phdTask = productionBoundary.materializePhdTask(idea!);
    expect(validateResearchTask(phdTask)).toMatchObject({
      kind: "implement",
      input: {
        candidateId: idea?.id,
        parentCandidateId: "baseline",
        benchmarkProhibited: true,
      },
    });
    expect(harness.effects.runnerCalls.map((call) => call.kind)).toEqual(["propose"]);
  });
});
