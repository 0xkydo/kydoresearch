import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { AgentRunner } from "../src/agents/types.ts";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../src/challenge/detect.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import {
  captureVerifierContract,
  computeMetaHarnessParetoFrontier,
  describeVerifierContractDrift,
  loadMetaHarnessStatus,
  MetaHarnessController,
  metaHarnessPaths,
  normalizeVerifierContract,
  readMetaHarnessLedger,
  validateHarnessProfile,
  type HarnessProfileV1,
  type MetaHarnessEvaluationV1,
  type MetaHarnessStateV1,
  type VerifierContractV1,
} from "../src/metaharness.ts";
import { loadState, saveState, statePaths } from "../src/state.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("metaharness profile and verifier contracts", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("accepts candidate-local role artifacts and rejects escaping paths", () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const root = path.join(challenge.repoRoot, ".autoresearch", "metaharness", "candidates", "H0001");
    for (const role of ["professor", "phd", "advisor"]) {
      const roleDir = path.join(root, "artifact", role);
      fs.mkdirSync(roleDir, { recursive: true });
      fs.writeFileSync(path.join(roleDir, "SOUL.md"), `${role} soul\n`);
      fs.writeFileSync(path.join(roleDir, "prompt.md"), `${role} prompt\n`);
    }
    const profile: HarnessProfileV1 = {
      schemaVersion: 1,
      candidateId: "H0001",
      parentCandidateId: "H0000",
      createdAt: new Date().toISOString(),
      hypothesis: {
        observation: "A repeated failure is visible in the inner archive.",
        mechanism: "The professor is not retrieving the relevant trace.",
        intervention: "Require an explicit raw-trace comparison.",
        expectedResult: "Fewer duplicated edit families.",
        falsifiedWhen: "The next evaluation window produces no objective gain.",
        risks: ["Extra context may not help."],
        evidenceRefs: ["runs/L001-I1/agent/events.ndjson"],
      },
      roles: {
        professor: {
          soul: "artifact/professor/SOUL.md",
          prompt: "artifact/professor/prompt.md",
          tools: ["read", "bash"],
        },
        phd: {
          soul: "artifact/phd/SOUL.md",
          prompt: "artifact/phd/prompt.md",
          tools: ["read", "write", "edit", "bash"],
        },
        advisor: {
          soul: "artifact/advisor/SOUL.md",
          prompt: "artifact/advisor/prompt.md",
          tools: ["read"],
        },
      },
    };

    expect(
      validateHarnessProfile(root, profile, {
        expectedCandidateId: "H0001",
        expectedParentCandidateId: "H0000",
        maxBytes: 100_000,
      }),
    ).toEqual(profile);

    fs.writeFileSync(
      path.join(root, "artifact", "professor", "unused.md"),
      "not referenced\n",
    );
    expect(() =>
      validateHarnessProfile(root, profile, {
        expectedCandidateId: "H0001",
        expectedParentCandidateId: "H0000",
        maxBytes: 100_000,
      }),
    ).toThrow(/outside its declared role artifacts.*unused\.md/);
    fs.rmSync(path.join(root, "artifact", "professor", "unused.md"));

    profile.roles.professor.prompt = "artifact/phd/prompt.md";
    expect(() =>
      validateHarnessProfile(root, profile, {
        expectedCandidateId: "H0001",
        expectedParentCandidateId: "H0000",
        maxBytes: 100_000,
      }),
    ).toThrow(/professor\.prompt must stay within artifact\/professor/);

    profile.roles.professor.prompt = "../H0000/profile.json";
    expect(() =>
      validateHarnessProfile(root, profile, {
        expectedCandidateId: "H0001",
        expectedParentCandidateId: "H0000",
        maxBytes: 100_000,
      }),
    ).toThrow(/escapes candidate/);
  });

  it("fingerprints the declared contract without freezing repository files", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    const before = await captureVerifierContract(
      challenge.repoRoot,
      initialized.state,
      nodeExec,
      config,
    );

    fs.writeFileSync(
      path.join(challenge.repoRoot, "src", "solution", "params.json"),
      '{"x": 1, "y": 2}\n',
    );
    const solutionChanged = await captureVerifierContract(
      challenge.repoRoot,
      loadState(initialized.stateDir)!,
      nodeExec,
      config,
    );
    expect(solutionChanged.fingerprint).toBe(before.fingerprint);

    fs.appendFileSync(path.join(challenge.repoRoot, "verify.sh"), "\n# drift\n");
    const verifierChanged = await captureVerifierContract(
      challenge.repoRoot,
      loadState(initialized.stateDir)!,
      nodeExec,
      config,
    );
    expect(verifierChanged.fingerprint).toBe(before.fingerprint);

    const changedState = loadState(initialized.stateDir)!;
    changedState.challenge.verifyCommand += " --different-contract";
    const contractChanged = await captureVerifierContract(
      challenge.repoRoot,
      changedState,
      nodeExec,
      config,
    );
    expect(contractChanged.fingerprint).not.toBe(before.fingerprint);
    expect(describeVerifierContractDrift(before, contractChanged)).toEqual([
      "challenge.verifyCommand",
    ]);

    const legacy = structuredClone(before);
    legacy.files = [];
    delete legacy.fingerprintScope;
    (legacy.runtime as unknown as Record<string, unknown>).implementationFiles = [
      { label: "inner-orchestrator", sha256: "old-source-hash" },
    ];
    (legacy.runtime as unknown as Record<string, unknown>).fixedRoleArtifacts = {
      metaharness: {
        soulSha256: "old-soul-hash",
        promptSha256: "old-prompt-hash",
      },
    };
    legacy.fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          challenge: legacy.challenge,
          files: legacy.files,
          runtime: legacy.runtime,
        }),
      )
      .digest("hex");
    const legacyFingerprint = legacy.fingerprint;
    const normalized = normalizeVerifierContract(legacy);
    expect(normalized.fingerprint).toBe(before.fingerprint);
    expect(normalized.legacyFingerprints).toContain(legacyFingerprint);
    expect(normalized.runtime).not.toHaveProperty("implementationFiles");
    expect(normalized.runtime).not.toHaveProperty("fixedRoleArtifacts");
  });

  it("keeps non-dominated quality, reliability, and wall-time tradeoffs", () => {
    const entry = (
      candidateId: string,
      objectiveGain: number,
      candidateSuccessRate: number,
      wallTimeMs: number,
    ): MetaHarnessEvaluationV1 => ({
      schemaVersion: 1,
      candidateId,
      parentCandidateId: "H0000",
      profileHash: candidateId,
      verifierFingerprint: "fixed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      loops: [1],
      startScore: 10,
      endScore: 9,
      objectiveGain,
      relativeGain: objectiveGain / 10,
      totalIdeas: 2,
      failedIdeas: 0,
      candidateSuccessRate,
      wallTimeMs,
      accepted: objectiveGain > 0,
    });
    const frontier = computeMetaHarnessParetoFrontier([
      entry("H0001", 1, 0.5, 2_000),
      entry("H0002", 2, 0.8, 2_000),
      entry("H0003", 1.5, 1, 3_000),
      entry("H0004", 0.5, 0.2, 4_000),
    ]);
    expect(frontier.map((item) => item.candidateId).sort()).toEqual([
      "H0002",
      "H0003",
    ]);
  });
});

describe("MetaHarnessController", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("fail-stops on the configured fatal attempt and records the current recovery", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    config.metaHarness.maxRecoveryAttempts = 2;
    config.metaHarness.retryBaseDelayMs = 0;
    config.metaHarness.retryMaxDelayMs = 0;
    config.resilience.agentMaxAttempts = 1;
    let proposalCalls = 0;
    const runner: AgentRunner = {
      async run(task) {
        if (task.kind === "propose") {
          proposalCalls += 1;
          return {
            ok: false,
            output: "",
            error: "current provider outage",
            filesWritten: [],
          };
        }
        return new MockAgentRunner().run(task);
      },
    };
    const manifest = readManifest(challenge.repoRoot);
    const controller = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      {
        runner,
        adapter: new YukonCliAdapter({
          repoRoot: challenge.repoRoot,
          manifest,
          cli: detectCli(challenge.repoRoot, manifest),
          verifyCommand: initialized.state.challenge.verifyCommand,
          benchCommand: initialized.state.challenge.benchCommand,
          execution: config.execution,
          logDir: statePaths(initialized.stateDir).logsDir,
          exec: nodeExec,
        }),
        exec: nodeExec,
        emit: () => {},
        delay: async () => {},
      },
    );

    await controller.runUntilDone();

    expect(proposalCalls).toBe(2);
    expect(loadMetaHarnessStatus(initialized.stateDir)).toMatchObject({
      phase: "paused",
      recoveryAttempts: 2,
    });
    expect(loadState(initialized.stateDir)).toMatchObject({
      phase: "paused",
      resumePhase: "loop.proposing",
      recovery: {
        scope: "loop.proposing",
        message: expect.stringContaining("current provider outage"),
        consecutiveFailures: 2,
      },
    });
    const journal = fs.readFileSync(
      metaHarnessPaths(initialized.stateDir).journal,
      "utf8",
    );
    expect(journal).toContain("metaharness recovery 2/2");
    expect(journal).not.toContain("metaharness recovery 3/2");
  });

  it("excludes operational-only loops from a harness evaluation window", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const baseRunner = new MockAgentRunner();
    const runner: AgentRunner = {
      async run(task) {
        if (task.kind === "implement" && task.input.loop === 2) {
          return {
            ok: false,
            output: "",
            error: "provider authentication unavailable",
            filesWritten: [],
          };
        }
        return baseRunner.run(task);
      },
    };
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner,
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    config.metaHarness.evaluationLoops = 1;
    config.metaHarness.maxGenerations = 1;
    config.maxLoops = 3;
    config.advisor.enabled = false;
    config.churchTriggerThreshold = 0;
    const manifest = readManifest(challenge.repoRoot);
    const controller = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      {
        runner,
        adapter: new YukonCliAdapter({
          repoRoot: challenge.repoRoot,
          manifest,
          cli: detectCli(challenge.repoRoot, manifest),
          verifyCommand: initialized.state.challenge.verifyCommand,
          benchCommand: initialized.state.challenge.benchCommand,
          execution: config.execution,
          logDir: statePaths(initialized.stateDir).logsDir,
          exec: nodeExec,
        }),
        exec: nodeExec,
        emit: () => {},
        delay: async () => {},
      },
    );

    await controller.runUntilDone();

    expect(loadState(initialized.stateDir)?.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ loop: 2, evaluatedCandidates: 0 }),
      ]),
    );
    const evaluation = readMetaHarnessLedger(initialized.stateDir)[0]!;
    expect(evaluation.loops).toEqual([3]);
    expect(evaluation.totalIdeas).toBeGreaterThan(0);
    expect(
      fs.readFileSync(metaHarnessPaths(initialized.stateDir).journal, "utf8"),
    ).toContain("metaharness.loop-not-evaluable");
  }, 30_000);

  it("evaluates immutable profiles through ordinary loops and resumes with a champion", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    config.metaHarness.evaluationLoops = 1;
    config.metaHarness.maxGenerations = 2;
    config.maxLoops = 3;

    const manifest = readManifest(challenge.repoRoot);
    const controller = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      {
        runner: new MockAgentRunner(),
        adapter: new YukonCliAdapter({
          repoRoot: challenge.repoRoot,
          manifest,
          cli: detectCli(challenge.repoRoot, manifest),
          verifyCommand: initialized.state.challenge.verifyCommand,
          benchCommand: initialized.state.challenge.benchCommand,
          execution: config.execution,
          logDir: statePaths(initialized.stateDir).logsDir,
          exec: nodeExec,
        }),
        exec: nodeExec,
        emit: () => {},
        delay: async () => {},
      },
    );

    await controller.runUntilDone();

    const ledger = readMetaHarnessLedger(initialized.stateDir);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((entry) => entry.verifierFingerprint === ledger[0]!.verifierFingerprint)).toBe(true);
    expect(fs.existsSync(metaHarnessPaths(initialized.stateDir).frontier)).toBe(true);
    expect(loadState(initialized.stateDir)?.phase).toBe("done");
    expect(loadMetaHarnessStatus(initialized.stateDir)?.phase).toBe("done");
    expect(controller.status().metaHarness?.generation).toBe(2);
  }, 30_000);

  it("confines metaharness writes to the assigned candidate surface", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    config.metaHarness.maxGenerations = 1;
    config.maxLoops = 2;
    const baseRunner = new MockAgentRunner();
    let metaharnessTools: string[] | undefined;
    const runner: AgentRunner = {
      async run(task) {
        const result = await baseRunner.run(task);
        if (task.kind !== "evolve-harness") return result;
        metaharnessTools = task.tools;
        return {
          ...result,
          filesWritten: [
            ...result.filesWritten,
            path.join(challenge.repoRoot, "benchmark.sh"),
          ],
        };
      },
    };
    const manifest = readManifest(challenge.repoRoot);
    const controller = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      {
        runner,
        adapter: new YukonCliAdapter({
          repoRoot: challenge.repoRoot,
          manifest,
          cli: detectCli(challenge.repoRoot, manifest),
          verifyCommand: initialized.state.challenge.verifyCommand,
          benchCommand: initialized.state.challenge.benchCommand,
          execution: config.execution,
          logDir: statePaths(initialized.stateDir).logsDir,
          exec: nodeExec,
        }),
        exec: nodeExec,
        emit: () => {},
        delay: async () => {},
      },
    );

    await controller.runUntilDone();

    expect(metaharnessTools).toEqual(["read", "write", "edit"]);
    const metaState = JSON.parse(
      fs.readFileSync(metaHarnessPaths(initialized.stateDir).state, "utf8"),
    ) as MetaHarnessStateV1;
    expect(metaState.candidates.find((candidate) => candidate.candidateId === "H0001"))
      .toMatchObject({
        status: "failed",
        error: expect.stringMatching(
          /attempted to write outside its candidate allowlist.*benchmark\.sh/,
        ),
      });
  }, 30_000);

  it("pauses both loops when a fixed runtime setting drifts on resume", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    const manifest = readManifest(challenge.repoRoot);
    const ports = {
      runner: new MockAgentRunner(),
      adapter: new YukonCliAdapter({
        repoRoot: challenge.repoRoot,
        manifest,
        cli: detectCli(challenge.repoRoot, manifest),
        verifyCommand: initialized.state.challenge.verifyCommand,
        benchCommand: initialized.state.challenge.benchCommand,
        execution: config.execution,
        logDir: statePaths(initialized.stateDir).logsDir,
        exec: nodeExec,
      }),
      exec: nodeExec,
      emit: () => {},
      delay: async () => {},
    };
    await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    const paths = metaHarnessPaths(initialized.stateDir);
    const legacyVerifier = JSON.parse(
      fs.readFileSync(paths.verifier, "utf8"),
    ) as VerifierContractV1 & {
      runtime: Record<string, unknown>;
    };
    legacyVerifier.files = [];
    delete legacyVerifier.fingerprintScope;
    legacyVerifier.runtime.implementationFiles = [
      { label: "inner-orchestrator", sha256: "old-source-hash" },
    ];
    legacyVerifier.runtime.fixedRoleArtifacts = {
      metaharness: {
        soulSha256: "old-soul-hash",
        promptSha256: "old-prompt-hash",
      },
    };
    legacyVerifier.fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          challenge: legacyVerifier.challenge,
          files: legacyVerifier.files,
          runtime: legacyVerifier.runtime,
        }),
      )
      .digest("hex");
    const legacyFingerprint = legacyVerifier.fingerprint;
    fs.writeFileSync(paths.verifier, `${JSON.stringify(legacyVerifier, null, 2)}\n`);
    const pausedMeta = JSON.parse(
      fs.readFileSync(paths.state, "utf8"),
    ) as MetaHarnessStateV1;
    pausedMeta.phase = "paused";
    fs.writeFileSync(paths.state, `${JSON.stringify(pausedMeta, null, 2)}\n`);
    const pausedInner = loadState(initialized.stateDir)!;
    pausedInner.phase = "paused";
    pausedInner.resumePhase = "ready";
    saveState(initialized.stateDir, pausedInner);

    await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    const migratedVerifier = JSON.parse(
      fs.readFileSync(paths.verifier, "utf8"),
    ) as { legacyFingerprints?: string[]; runtime?: Record<string, unknown> };
    expect(migratedVerifier.legacyFingerprints).toContain(legacyFingerprint);
    expect(migratedVerifier.runtime).not.toHaveProperty("implementationFiles");
    expect(migratedVerifier.runtime).not.toHaveProperty("fixedRoleArtifacts");
    expect(loadMetaHarnessStatus(initialized.stateDir)?.phase).toBe("ready");

    const policyDrift = structuredClone(config);
    policyDrift.maxVerifyAttempts = config.maxVerifyAttempts - 1;
    await expect(
      MetaHarnessController.create(
        challenge.repoRoot,
        initialized.stateDir,
        policyDrift,
        ports,
      ),
    ).rejects.toThrow(
      /runtime\.innerPolicy\.maxVerifyAttempts.*expected 3, observed 2.*restore the frozen value/i,
    );

    await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    expect(loadMetaHarnessStatus(initialized.stateDir)?.phase).toBe("ready");

    const drifted = structuredClone(config);
    drifted.roles.professor.model = "example/different-fixed-model";
    await expect(
      MetaHarnessController.create(
        challenge.repoRoot,
        initialized.stateDir,
        drifted,
        ports,
      ),
    ).rejects.toThrow(
      /changed components: runtime\.evolvingRoleModels\.professor\.model/,
    );

    expect(loadState(initialized.stateDir)?.phase).toBe("paused");
    expect(loadMetaHarnessStatus(initialized.stateDir)?.phase).toBe("paused");

    await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    expect(loadMetaHarnessStatus(initialized.stateDir)?.phase).toBe("ready");
  }, 30_000);

  it("reuses a durable draft generation after an interrupted proposal", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const initialized = await initChallenge({
      repoRoot: challenge.repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.metaHarness.enabled = true;
    config.metaHarness.evaluationLoops = 1;
    config.metaHarness.maxGenerations = 1;
    config.maxLoops = null;

    const manifest = readManifest(challenge.repoRoot);
    const ports = {
      runner: new MockAgentRunner(),
      adapter: new YukonCliAdapter({
        repoRoot: challenge.repoRoot,
        manifest,
        cli: detectCli(challenge.repoRoot, manifest),
        verifyCommand: initialized.state.challenge.verifyCommand,
        benchCommand: initialized.state.challenge.benchCommand,
        execution: config.execution,
        logDir: statePaths(initialized.stateDir).logsDir,
        exec: nodeExec,
      }),
      exec: nodeExec,
      emit: () => {},
      delay: async () => {},
    };
    await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );

    const paths = metaHarnessPaths(initialized.stateDir);
    const state = JSON.parse(
      fs.readFileSync(paths.state, "utf8"),
    ) as MetaHarnessStateV1;
    const createdAt = new Date().toISOString();
    state.phase = "proposing";
    state.generation = 1;
    state.candidates.push({
      candidateId: "H0001",
      parentCandidateId: "H0000",
      generation: 1,
      status: "draft",
      profilePath: path.join(
        paths.candidatesDir,
        "H0001",
        "profile.json",
      ),
      createdAt,
      proposalAttempts: 1,
    });
    fs.writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);

    const resumed = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    await resumed.runUntilDone();

    const finalState = JSON.parse(
      fs.readFileSync(paths.state, "utf8"),
    ) as MetaHarnessStateV1;
    expect(finalState.generation).toBe(1);
    expect(finalState.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "H0000",
      "H0001",
    ]);
    expect(finalState.candidates[1]?.proposalAttempts).toBe(2);
    expect(readMetaHarnessLedger(initialized.stateDir).map((entry) => entry.candidateId)).toEqual([
      "H0001",
    ]);

    const evaluationPath = path.join(
      paths.candidatesDir,
      "H0001",
      "evaluation.json",
    );
    const evaluationText = fs.readFileSync(evaluationPath, "utf8");
    const evaluation = JSON.parse(
      evaluationText,
    ) as MetaHarnessEvaluationV1;
    finalState.phase = "recording";
    finalState.championCandidateId = "H0000";
    finalState.activeEvaluation = {
      candidateId: "H0001",
      startedAt: evaluation.startedAt,
      startScore: evaluation.startScore,
      targetLoops: 1,
      completedLoops: [...evaluation.loops],
      lastRecordedLoop: evaluation.loops.at(-1) ?? 0,
      totalIdeas: evaluation.totalIdeas,
      failedIdeas: evaluation.failedIdeas,
    };
    finalState.candidates[1]!.status = "evaluating";
    finalState.candidates[1]!.evaluationPath = undefined;
    fs.writeFileSync(paths.state, `${JSON.stringify(finalState, null, 2)}\n`);

    const recordingResume = await MetaHarnessController.create(
      challenge.repoRoot,
      initialized.stateDir,
      config,
      ports,
    );
    await recordingResume.runUntilDone();

    expect(fs.readFileSync(evaluationPath, "utf8")).toBe(evaluationText);
    expect(readMetaHarnessLedger(initialized.stateDir)).toHaveLength(1);
    expect(loadMetaHarnessStatus(initialized.stateDir)?.championCandidateId).toBe(
      evaluation.accepted ? "H0001" : "H0000",
    );
  }, 30_000);
});
