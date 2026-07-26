import { MockAgentRunner } from "../../src/agents/mock.ts";
import type { PhaseHarness } from "../support/phase-testkit/index.ts";

export async function stopAfterProfessor(harness: PhaseHarness): Promise<void> {
  await harness.makeOrchestrator({ stopBeforePhase: "loop.ideas" }).runLoop();
}

export async function stopAfterPhd(harness: PhaseHarness): Promise<void> {
  await stopAfterProfessor(harness);
  harness.resetEffects();
  await harness.makeOrchestrator({
    stopBeforePhase: "loop.finalizing",
    runner: new MockAgentRunner(),
  }).runLoop();
}
