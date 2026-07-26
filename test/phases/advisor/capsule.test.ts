import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../../../src/agents/mock.ts";
import type { AgentRunner } from "../../../src/agents/types.ts";
import { DEFAULT_CONFIG } from "../../../src/config.ts";
import { loadState, saveState } from "../../../src/state.ts";
import {
  createPhaseHarness,
  type PhaseHarness,
} from "../../support/phase-testkit/index.ts";

describe("Advisor phase capsule", () => {
  let harness: PhaseHarness | undefined;
  afterEach(() => harness?.cleanup());

  it("reads frozen loop evidence and stops without implementation, benchmark, or submission", async () => {
    harness = await createPhaseHarness({
      config: {
        advisor: {
          ...DEFAULT_CONFIG.advisor,
          enabled: true,
        },
      },
    });
    const state = loadState(harness.stateDir)!;
    state.loop = 1;
    state.phase = "paused";
    state.resumePhase = "loop.end";
    state.ideas = [{
      id: "L001-I1",
      loop: 1,
      title: "Frozen candidate evidence",
      parentCandidateId: "baseline",
      specFile: "ideas/loop-001/idea-1.md",
      status: "benching",
      verifyAttempts: 1,
      localScore: 12,
    }];
    state.history = [];
    state.pendingSummary = undefined;
    saveState(harness.stateDir, state);
    fs.mkdirSync(path.join(harness.stateDir, "loops/loop-001"), {
      recursive: true,
    });
    const candidateRoot = path.join(harness.stateDir, "runs/L001-I1");
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, "metrics.json"),
      '{"schemaVersion":1,"candidateId":"L001-I1","score":12}\n',
    );
    harness.resetEffects();

    const controller = new AbortController();
    const mock = new MockAgentRunner();
    const advisorOnly: AgentRunner = {
      async run(task) {
        const result = await mock.run(task);
        expect(task.kind).toBe("advise");
        expect(result.filesWritten).toEqual([]);
        controller.abort();
        return result;
      },
    };
    expect(harness.config.advisor.enabled).toBe(true);
    const orchestrator = harness.makeOrchestrator({
      signal: controller.signal,
      runner: advisorOnly,
    });
    expect(
      (orchestrator as unknown as { config: { advisor: { enabled: boolean } } })
        .config.advisor.enabled,
    ).toBe(true);
    await orchestrator.runLoop();

    expect(
      harness.effects.runnerCalls.map((call) => call.kind),
      fs.readFileSync(path.join(harness.stateDir, "journal.ndjson"), "utf8"),
    ).toEqual(["advise"]);
    expect(controller.signal.aborted).toBe(true);
    expect(harness.effects.commands).toEqual([]);
    expect(harness.effects.events.some((event) => event.type === "submitted")).toBe(false);
    expect(loadState(harness.stateDir)).toMatchObject({
      phase: "paused",
      resumePhase: "loop.end",
    });
  });
});
