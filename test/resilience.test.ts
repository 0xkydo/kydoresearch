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
import { loadState, saveState } from "../src/state.ts";
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

  it("fetches fresh leaderboard evidence even when repository sync stays unavailable", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    let syncCalls = 0;
    let listCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      sync: async () => {
        syncCalls += 1;
        return { ok: false, raw: "temporary leaderboard outage" };
      },
      listSubmissions: async (all, signal) => {
        listCalls += 1;
        return harness.adapter.listSubmissions(all, signal);
      },
    });

    const summary = await harness.makeOrchestrator(harness.runner, adapter).runLoop();

    expect(summary).not.toBeNull();
    expect(syncCalls).toBe(2);
    expect(listCalls).toBe(2);
    const snapshotPath = path.join(
      harness.stateDir,
      "loops",
      "loop-001",
      "leaderboard-snapshot.json",
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
      provenance: string;
      sync: { ok: boolean };
      entries: unknown[];
    };
    expect(snapshot).toMatchObject({
      provenance: "remote",
      sync: { ok: false },
    });
    expect(snapshot.entries).toHaveLength(2);
    const professorTask = JSON.parse(
      fs.readFileSync(
        path.join(harness.stateDir, "loops", "loop-001", "professor-task.json"),
        "utf8",
      ),
    ) as { input: { leaderboardSnapshotPath?: string } };
    expect(professorTask.input.leaderboardSnapshotPath).toBe(snapshotPath);
  });

  it("freezes cached leaderboard evidence when both sync and fetch are unavailable", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    const cachedAt = "2026-07-30T12:00:00.000Z";
    fs.writeFileSync(
      path.join(harness.stateDir, "leaderboard.json"),
      JSON.stringify({
        fetchedAt: cachedAt,
        entries: [
          {
            id: "cached-frontier",
            score: 7,
            author: "competitor",
            promoted: true,
          },
        ],
      }),
    );
    const adapter = overrideAdapter(harness.adapter, {
      sync: async () => ({ ok: false, raw: "sync unavailable" }),
      listSubmissions: async () => {
        throw new Error("leaderboard fetch unavailable");
      },
    });

    await harness.makeOrchestrator(harness.runner, adapter).runLoop();

    const snapshot = JSON.parse(
      fs.readFileSync(
        path.join(
          harness.stateDir,
          "loops",
          "loop-001",
          "leaderboard-snapshot.json",
        ),
        "utf8",
      ),
    ) as {
      provenance: string;
      observedAt?: string;
      entries: Array<{ id: string }>;
    };
    expect(snapshot).toMatchObject({
      provenance: "cache",
      observedAt: cachedAt,
      entries: [{ id: "cached-frontier" }],
    });
  });

  it("reuses an existing loop snapshot without refreshing evidence on resume", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    const state = loadState(harness.stateDir)!;
    state.loop = 1;
    state.phase = "paused";
    state.resumePhase = "loop.syncing";
    saveState(harness.stateDir, state);
    const snapshotPath = path.join(
      harness.stateDir,
      "loops",
      "loop-001",
      "leaderboard-snapshot.json",
    );
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        loop: 1,
        capturedAt: "2026-07-30T12:00:00.000Z",
        provenance: "cache",
        observedAt: "2026-07-30T11:00:00.000Z",
        sync: { ok: false, detail: "previous sync unavailable" },
        entries: [],
      }),
    );
    let syncCalls = 0;
    let listCalls = 0;
    const adapter = overrideAdapter(harness.adapter, {
      sync: async () => {
        syncCalls += 1;
        return { ok: true, raw: "unexpected refresh" };
      },
      listSubmissions: async () => {
        listCalls += 1;
        return [];
      },
    });

    const summary = await harness.makeOrchestrator(harness.runner, adapter).runLoop();

    expect(summary?.loop).toBe(1);
    expect(syncCalls).toBe(0);
    expect(listCalls).toBe(0);
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))).toMatchObject({
      provenance: "cache",
      capturedAt: "2026-07-30T12:00:00.000Z",
    });
  });

  it("archives an explicitly non-promoted submission without presenting it as promoted", async () => {
    const harness = await makeResilienceHarness(repoRoot);
    const adapter = overrideAdapter(harness.adapter, {
      submit: async () => ({
        ok: true,
        submissionId: "sub-raced-frontier",
        status: "accepted",
        promoted: false,
        raw: "submitted but not promoted",
      }),
    });
    const orchestrator = harness.makeOrchestrator(harness.runner, adapter);

    await orchestrator.runLoop();
    await orchestrator.runLoop();

    const metrics = JSON.parse(
      fs.readFileSync(
        path.join(harness.stateDir, "runs", "L002-I1", "metrics.json"),
        "utf8",
      ),
    ) as { submission?: { submissionId?: string; promoted?: boolean } };
    expect(metrics.submission).toEqual({
      submissionId: "sub-raced-frontier",
      promoted: false,
    });
    expect(
      fs.readFileSync(path.join(harness.stateDir, "knowledge-base.md"), "utf8"),
    ).toContain("not promoted");
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

  it.each(["accepted", "rejected"] as const)(
    "continues after a queued submission and feeds a later %s review into the next loop",
    async (remoteStatus) => {
      const harness = await makeResilienceHarness(repoRoot);
      let resolved = false;
      let submitCalls = 0;
      const proposalInputs: Record<string, unknown>[] = [];
      const runner: AgentRunner = {
        run: async (task) => {
          if (task.kind === "propose") proposalInputs.push(task.input);
          return harness.runner.run(task);
        },
      };
      const remoteEntry = {
        id: "sub-review1",
        score: remoteStatus === "accepted" ? 2 : null,
        author: "me",
        status: remoteStatus,
        rawStatus: remoteStatus === "accepted" ? "promoted" : "rejected",
        metrics: remoteStatus === "accepted" ? '{"verified":true}' : "official verifier failed",
        promoted: remoteStatus === "accepted",
        createdAt: "2026-07-31T12:00:00.000Z",
      } as const;
      const adapter = overrideAdapter(harness.adapter, {
        submit: async () => {
          submitCalls += 1;
          return {
            ok: true,
            submissionId: remoteEntry.id,
            status: "pending",
            promoted: false,
            raw: "Submission queued\nstatus validating",
          };
        },
        listSubmissions: async () => resolved ? [remoteEntry] : [],
      });

      await harness.makeOrchestrator(runner, adapter).runLoop();
      const submittedLoop = await harness.makeOrchestrator(runner, adapter).runLoop();

      expect(submittedLoop).toMatchObject({ loop: 2, improved: true });
      expect(submitCalls).toBe(1);
      expect(loadState(harness.stateDir)).toMatchObject({
        history: [{ loop: 1 }, { loop: 2 }],
        submissionReviews: [
          {
            candidateId: "L002-I1",
            submissionId: remoteEntry.id,
            status: "pending",
          },
        ],
      });

      resolved = true;
      await harness.makeOrchestrator(runner, adapter).runLoop();

      const state = loadState(harness.stateDir)!;
      expect(state.history).toHaveLength(3);
      expect(state.submissionReviews).toMatchObject([
        {
          candidateId: "L002-I1",
          submissionId: remoteEntry.id,
          status: remoteStatus,
          remoteStatus: remoteEntry.rawStatus,
          remoteMetrics: remoteEntry.metrics,
          promoted: remoteEntry.promoted,
        },
      ]);
      expect(proposalInputs.at(-1)).toMatchObject({
        resolvedSubmissionReviews: [
          {
            candidateId: "L002-I1",
            submissionId: remoteEntry.id,
            status: remoteStatus,
          },
        ],
      });

      const knowledge = fs.readFileSync(path.join(harness.stateDir, "knowledge-base.md"), "utf8");
      expect(knowledge).toContain(`Remote submission ${remoteStatus}`);
      expect(knowledge).toContain(remoteEntry.metrics);

      await harness.makeOrchestrator(runner, adapter).runLoop();
      const afterRepeat = fs.readFileSync(
        path.join(harness.stateDir, "knowledge-base.md"),
        "utf8",
      );
      expect(afterRepeat.match(new RegExp(`Remote submission ${remoteStatus}`, "g"))).toHaveLength(1);
    },
  );

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
