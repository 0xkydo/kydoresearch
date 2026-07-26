import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { AgentResult, AgentRunner } from "../src/agents/types.ts";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../src/challenge/detect.ts";
import type { ChallengeAdapter } from "../src/challenge/types.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { loadState } from "../src/state.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("overnight failure recovery", () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = makeTmpChallenge()));
  afterEach(() => cleanup());

  it("retries a failed professor checkpoint and still finishes an in-progress max loop", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.maxLoops = 1;
    harness.config.resilience.agentMaxAttempts = 2;
    harness.config.resilience.maxConsecutiveLoopFailures = 3;

    let proposalCalls = 0;
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "propose" && ++proposalCalls <= 3) {
          return Promise.resolve(failedAgent("temporary provider outage"));
        }
        return harness.runner.run(task);
      },
    };

    await harness.makeOrchestrator(runner).runUntilDone();

    expect(proposalCalls).toBe(4);
    expect(loadState(harness.stateDir)).toMatchObject({
      phase: "done",
      loop: 1,
      history: [{ loop: 1 }],
    });
    expect(loadState(harness.stateDir)!.recovery).toBeUndefined();
  });

  it("opens a durable circuit breaker only after repeated systemic failures", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.maxLoops = 1;
    harness.config.resilience.agentMaxAttempts = 1;
    harness.config.resilience.maxConsecutiveLoopFailures = 2;
    let proposalCalls = 0;
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "propose") {
          proposalCalls += 1;
          return Promise.resolve(failedAgent("provider remains unavailable"));
        }
        return harness.runner.run(task);
      },
    };

    await harness.makeOrchestrator(runner).runUntilDone();

    expect(proposalCalls).toBe(2);
    expect(loadState(harness.stateDir)).toMatchObject({
      phase: "paused",
      resumePhase: "loop.proposing",
      loop: 1,
      history: [],
      recovery: {
        scope: "loop.proposing",
        consecutiveFailures: 2,
      },
    });
  });

  it("continues from cached knowledge when leaderboard sync stays unavailable", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    let syncCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      sync: async () => {
        syncCalls += 1;
        return { ok: false, raw: "temporary leaderboard outage" };
      },
    });

    const summary = await harness.makeOrchestrator(harness.runner, adapter).runLoop();

    expect(summary).not.toBeNull();
    expect(syncCalls).toBe(2);
    expect(
      fs.readFileSync(path.join(harness.stateDir, "journal.ndjson"), "utf8"),
    ).toContain("continuing with 0 cached submission(s)");
  });

  it("reconciles an ambiguously accepted submission instead of submitting twice", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.resilience.submitMaxAttempts = 3;
    let submitCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      submit: async (options, signal) => {
        submitCalls += 1;
        const accepted = await harness.adapter.submit(options, signal);
        return { ...accepted, ok: false, raw: "connection reset after request was sent" };
      },
    });
    const orchestrator = harness.makeOrchestrator(harness.runner, adapter);

    await orchestrator.runLoop();
    const summary = await orchestrator.runLoop();

    expect(summary).toMatchObject({ loop: 2, improved: true });
    expect(submitCalls).toBe(1);
    expect(loadState(harness.stateDir)).toMatchObject({
      bestScore: 2,
      bestSubmittedScore: 2,
    });
  });

  it("keeps a failed submission resumable and does not skip it at maxLoops", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.maxLoops = 2;
    harness.config.resilience.submitMaxAttempts = 1;
    let submitCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      submit: async (options, signal) => {
        submitCalls += 1;
        if (submitCalls === 1) {
          return { ok: false, raw: "temporary submit outage" };
        }
        return harness.adapter.submit(options, signal);
      },
    });

    await harness.makeOrchestrator(harness.runner, adapter).runUntilDone();

    expect(submitCalls).toBe(2);
    expect(loadState(harness.stateDir)).toMatchObject({
      phase: "done",
      loop: 2,
      bestScore: 2,
      bestSubmittedScore: 2,
      history: [{ loop: 1 }, { loop: 2, improved: true }],
    });
  });

  it("falls through to the next qualifying idea when the best fails the main gate", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.resilience.commandMaxAttempts = 1;
    let mainVerifyCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      verify: async (cwd, signal) => {
        if (cwd === undefined && ++mainVerifyCalls === 1) {
          return {
            ok: false,
            raw: "transient candidate-specific main verification failure",
            exitCode: 1,
          };
        }
        return harness.adapter.verify(cwd, signal);
      },
    });
    const orchestrator = harness.makeOrchestrator(harness.runner, adapter);

    await orchestrator.runLoop();
    const summary = await orchestrator.runLoop();
    const byId = Object.fromEntries(summary!.ideas.map((idea) => [idea.id, idea]));

    expect(byId["L002-I1"]).toMatchObject({ status: "failed" });
    expect(byId["L002-I2"]).toMatchObject({ status: "done-improved", localScore: 4 });
    expect(loadState(harness.stateDir)).toMatchObject({
      bestScore: 4,
      bestSubmittedScore: 4,
    });
  });

  it("restores the pre-finalization main checkout when every finalist fails", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    harness.config.resilience.commandMaxAttempts = 1;
    const adapter = overrideAdapter(harness.adapter, {
      verify: async (cwd, signal) =>
        cwd === undefined
          ? { ok: false, raw: "all main-checkout gates failed", exitCode: 1 }
          : harness.adapter.verify(cwd, signal),
    });
    const orchestrator = harness.makeOrchestrator(harness.runner, adapter);

    await orchestrator.runLoop();
    const summary = await orchestrator.runLoop();
    const params = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "src", "solution", "params.json"), "utf8"),
    ) as { algorithm: string; x: number; y: number };

    expect(summary).toMatchObject({ loop: 2, improved: false });
    expect(summary!.ideas.map((idea) => idea.status)).toEqual(["failed", "failed"]);
    expect(params).toEqual({ algorithm: "baseline-guess", x: 0, y: 0 });
    expect(
      fs.existsSync(path.join(harness.stateDir, "main-snapshots", "loop-002")),
    ).toBe(false);
  });
});

async function makeResilienceHarness(repoRoot: string) {
  const runner = new MockAgentRunner();
  const { stateDir, config } = await initChallenge({ repoRoot, runner, exec: nodeExec });
  config.churchTriggerThreshold = 0;
  config.advisor.enabled = false;
  config.resilience.retryBaseDelayMs = 0;
  config.resilience.retryMaxDelayMs = 0;
  config.resilience.loopFailureBaseDelayMs = 0;
  config.resilience.loopFailureMaxDelayMs = 0;

  const manifest = readManifest(repoRoot);
  const adapter = new YukonCliAdapter({
    repoRoot,
    manifest,
    cli: detectCli(repoRoot, manifest),
    verifyCommand: "./verify.sh",
    benchCommand: "./benchmark.sh",
    exec: nodeExec,
  });

  return {
    stateDir,
    config,
    runner,
    adapter,
    makeOrchestrator: (
      selectedRunner: AgentRunner = runner,
      selectedAdapter: ChallengeAdapter = adapter,
    ) =>
      new Orchestrator(repoRoot, stateDir, config, {
        runner: selectedRunner,
        adapter: selectedAdapter,
        exec: nodeExec,
        emit: () => {},
        delay: async () => {},
      }),
  };
}

function overrideAdapter(
  base: ChallengeAdapter,
  overrides: Partial<ChallengeAdapter>,
): ChallengeAdapter {
  return {
    manifest: base.manifest,
    setup: base.setup.bind(base),
    verify: base.verify.bind(base),
    bench: base.bench.bind(base),
    submit: base.submit.bind(base),
    listSubmissions: base.listSubmissions.bind(base),
    sync: base.sync.bind(base),
    ...overrides,
  };
}

function failedAgent(error: string): AgentResult {
  return {
    ok: false,
    output: "",
    error,
    filesWritten: [],
    usage: { cost: 0, turns: 0 },
  };
}
