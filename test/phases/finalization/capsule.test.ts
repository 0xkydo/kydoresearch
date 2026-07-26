import { afterEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../../../src/agents/mock.ts";
import { isIdeaTerminal } from "../../../src/phases.ts";
import { loadState, saveState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  readJournalPhases,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";
import { stopAfterPhd } from "../support.ts";

describe("Finalization phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("consumes benched candidates, submits at most one winner, and stops before Advisor", async () => {
    harness = await createPhaseHarness();
    const frozenInput = loadState(harness.stateDir)!;
    frozenInput.bestScore = 100;
    saveState(harness.stateDir, frozenInput);
    await stopAfterPhd(harness);
    harness.resetEffects();

    await harness.makeOrchestrator({
      stopBeforePhase: "loop.end",
      runner: new MockAgentRunner(),
    }).runLoop();

    const state = loadState(harness.stateDir);
    const calls = harness.effects.runnerCalls.map((call) => call.kind);
    expect(calls).not.toContain("propose");
    expect(calls).not.toContain("implement");
    expect(calls).not.toContain("advise");
    expect(
      harness.effects.events.filter((event) => event.type === "submitted"),
      JSON.stringify({
        ideas: state?.ideas,
        bestScore: state?.bestScore,
        calls,
        events: harness.effects.events,
      }),
    ).toHaveLength(1);
    expect(state?.ideas.every((idea) => isIdeaTerminal(idea.status))).toBe(true);
    expect(state?.bestScore).toBeLessThan(100);
    expect(state?.bestSubmittedScore).toBe(state?.bestScore);
    expect(readJournalPhases(harness.stateDir)).not.toContain("church");
    expect(state).toMatchObject({
      phase: "paused",
      resumePhase: "loop.end",
    });
  });
});
