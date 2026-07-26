import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../../../src/agents/mock.ts";
import type { AgentRunner } from "../../../src/agents/types.ts";
import { loadState, saveState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";

describe("Church phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("resumes a frozen dry streak, writes reflection, and creates no candidate work", async () => {
    harness = await createPhaseHarness();
    const state = loadState(harness.stateDir)!;
    state.loop = 3;
    state.phase = "paused";
    state.resumePhase = "church";
    state.dryLoopStreak = 3;
    state.ideas = [];
    state.pendingSummary = {
      loop: 3,
      improved: false,
      bestScoreAfter: state.bestScore,
      ideas: [],
      advisorNotes: [],
    };
    saveState(harness.stateDir, state);
    harness.config.churchTriggerThreshold = 3;
    harness.resetEffects();

    const controller = new AbortController();
    const mock = new MockAgentRunner();
    const churchOnly: AgentRunner = {
      async run(task) {
        const result = await mock.run(task);
        expect(task.kind).toBe("church");
        controller.abort();
        return result;
      },
    };
    await harness.makeOrchestrator({
      signal: controller.signal,
      runner: churchOnly,
    }).runLoop();

    expect(harness.effects.commands).toEqual([]);
    expect(harness.effects.events.some((event) => event.type === "submitted")).toBe(false);
    expect(fs.readFileSync(
      path.join(harness.stateDir, "notes/church-003.md"),
      "utf8",
    )).toMatch(/Professor|God/);
    expect(loadState(harness.stateDir)?.ideas).toEqual([]);
  });
});
