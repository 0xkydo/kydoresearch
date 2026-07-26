import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLedgerRecord,
  archivePaths,
  candidateRunPaths,
  candidateRunReadiness,
  copyEditableSource,
  createCandidateRun,
  generateCandidateDiff,
  isCandidateRunSealed,
  readLedger,
  readRunRecord,
  sealCandidateRun,
  snapshotEditableSource,
  writeCandidateDiff,
  writeCandidateIntegrity,
  writeCandidateMetrics,
  writeCandidateParent,
  writeCandidatePostmortem,
  writeCandidateProposal,
  writeCandidateTask,
} from "../src/archive.ts";
import {
  EXPERIMENT_SCHEMA_VERSION,
  normalizeProposal,
  validateResearchTask,
  type CandidateIntegrityV1,
  type CandidateMetricsV1,
  type CandidateParentV1,
  type CandidateProposalV1,
  type PhdImplementationTaskV1,
} from "../src/experiments.ts";

describe("proposal contracts", () => {
  it("normalizes legacy proposals into the canonical versioned shape", () => {
    const proposal = normalizeProposal(
      { title: "Tune batches", spec: "Increase the batch size in src/solution." },
      { parentCandidateId: "baseline", searchMode: "refinement", editFamily: "runtime" },
    );

    expect(proposal).toMatchObject({
      schemaVersion: 1,
      title: "Tune batches",
      parentCandidateId: "baseline",
      searchMode: "refinement",
      editFamily: "runtime",
      intervention: "Increase the batch size in src/solution.",
      evidenceRefs: [],
      risks: [],
      nonGoals: [],
    });
    expect(proposal.hypothesis).toContain("legacy");
  });

  it("preserves complete canonical proposal fields and rejects malformed input", () => {
    const proposal = normalizeProposal(
      {
        schemaVersion: 1,
        title: "Fuse kernels",
        spec: "Fuse the two hot kernels.",
        parentCandidateId: "L002-I1",
        searchMode: "structural",
        editFamily: "kernel-fusion",
        evidenceRefs: ["L002-I1/metrics.json"],
        observation: "Both kernels are launch-bound.",
        hypothesis: "One launch removes overhead.",
        intervention: "Fuse A and B.",
        expectedResult: "Latency falls.",
        falsifiedWhen: "Latency is unchanged.",
        risks: ["register pressure"],
        nonGoals: ["changing precision"],
      },
      { parentCandidateId: "ignored" },
    );
    expect(proposal.searchMode).toBe("structural");
    expect(proposal.evidenceRefs).toEqual(["L002-I1/metrics.json"]);

    expect(() =>
      normalizeProposal({ title: "bad", spec: "x", searchMode: "random" }, { parentCandidateId: "baseline" }),
    ).toThrow(/searchMode/);
    expect(() =>
      normalizeProposal({ schemaVersion: 2, title: "bad", spec: "x" }, { parentCandidateId: "baseline" }),
    ).toThrow(/Unsupported proposal schemaVersion/);
    expect(() => normalizeProposal({ title: "", spec: "x" }, { parentCandidateId: "baseline" })).toThrow(
      /title/,
    );
  });

  it("requires successful setup evidence in initialization tasks", () => {
    const repoRoot = path.join(os.tmpdir(), "setup-task-validation");
    const stateDir = path.join(repoRoot, ".autoresearch");
    const setupTask = {
      schemaVersion: 1,
      taskId: "init-setup",
      kind: "init.explore",
      role: "setup",
      taskPath: path.join(stateDir, "loops", "init", "setup-task.json"),
      stateDir,
      resultPath: path.join(stateDir, "loops", "init", "setup-result.json"),
      input: {
        repoRoot,
        manifestPath: path.join(repoRoot, "benchmark.json"),
        knowledgeBasePath: path.join(stateDir, "knowledge-base.md"),
        setupCommand: "./setup.sh",
        setupLogPath: path.join(stateDir, "logs", "setup.log"),
        setupSucceeded: true,
      },
    };

    expect(validateResearchTask(setupTask)).toEqual(setupTask);
    expect(() =>
      validateResearchTask({
        ...setupTask,
        input: { ...setupTask.input, setupCommand: undefined },
      }),
    ).toThrow(/setupCommand/);
    expect(() =>
      validateResearchTask({
        ...setupTask,
        input: { ...setupTask.input, setupLogPath: "relative\/setup.log" },
      }),
    ).toThrow(/setupLogPath.*absolute path/);
    expect(() =>
      validateResearchTask({
        ...setupTask,
        input: { ...setupTask.input, setupSucceeded: false },
      }),
    ).toThrow(/setupSucceeded/);
  });

  it("validates immutable baseline-review evidence for Setup", () => {
    const repoRoot = path.join(os.tmpdir(), "setup-review-validation");
    const stateDir = path.join(repoRoot, ".autoresearch");
    const task = {
      schemaVersion: 1,
      taskId: "init-setup-review-1",
      kind: "init.review",
      role: "setup",
      taskPath: path.join(stateDir, "loops", "init", "setup-review-task.json"),
      stateDir,
      resultPath: path.join(stateDir, "loops", "init", "setup-result.json"),
      input: {
        repoRoot,
        manifestPath: path.join(repoRoot, "benchmark.json"),
        knowledgeBasePath: path.join(stateDir, "knowledge-base.md"),
        previousVerifyCommand: "./verify.sh",
        previousBenchCommand: "./benchmark.sh",
        benchmarkLogPath: path.join(stateDir, "logs", "benchmark.log"),
        scorePath: path.join(repoRoot, "score.json"),
        benchmarkExitCode: 1,
        benchmarkFailureTail: "local benchmark failed",
      },
    };

    expect(validateResearchTask(task)).toEqual(task);
    expect(() =>
      validateResearchTask({
        ...task,
        input: { ...task.input, benchmarkLogPath: "relative/benchmark.log" },
      }),
    ).toThrow(/benchmarkLogPath.*absolute path/);
    expect(() =>
      validateResearchTask({
        ...task,
        input: { ...task.input, benchmarkFailureTail: "" },
      }),
    ).toThrow(/benchmarkFailureTail/);
  });

  it("validates versioned task envelopes and kind-specific immutable input", () => {
    const stateDir = path.join(os.tmpdir(), "task-validation", ".autoresearch");
    const task = makeTask(stateDir, "L001-I1", "baseline");
    expect(validateResearchTask(task)).toEqual(task);
    expect(() => validateResearchTask({ ...task, role: "professor" })).toThrow(/requires role phd/);
    expect(() =>
      validateResearchTask({
        ...task,
        input: { ...task.input, benchmarkProhibited: false },
      }),
    ).toThrow(/benchmarkProhibited/);
    expect(() => validateResearchTask({ ...task, taskPath: "relative/task.json" })).toThrow(
      /absolute path/,
    );
  });
});

describe("candidate archive", () => {
  let root: string;
  let stateDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kydoresearch-archive-"));
    stateDir = path.join(root, ".autoresearch");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("provides stable safe paths and resume-safe candidate creation", () => {
    const paths = createCandidateRun(stateDir, {
      candidateId: "L004-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(paths.root).toBe(path.join(stateDir, "runs", "L004-I1"));
    expect(readRunRecord(stateDir, "L004-I1")).toEqual({
      schemaVersion: 1,
      candidateId: "L004-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc123",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(createCandidateRun(stateDir, {
      candidateId: "L004-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc123",
    }).root).toBe(paths.root);
    expect(() =>
      createCandidateRun(stateDir, {
        candidateId: "L004-I1",
        parentCandidateId: "other",
        baseRevision: "abc123",
      }),
    ).toThrow(/different lineage/);
    expect(() => candidateRunPaths(stateDir, "../escape")).toThrow(/Invalid candidate ID/);
  });

  it("atomically writes artifacts, keeps task/proposal immutable, and validates candidate IDs", () => {
    createCandidateRun(stateDir, {
      candidateId: "L001-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc",
    });
    const proposal = makeProposal("L001-I1", "baseline");
    const task = makeTask(stateDir, "L001-I1", "baseline");
    writeCandidateProposal(stateDir, "L001-I1", proposal);
    expect(() =>
      writeCandidateTask(stateDir, "L001-I1", {
        ...task,
        taskPath: path.join(stateDir, "wrong-task.json"),
      }),
    ).toThrow(/taskPath does not match/);
    writeCandidateTask(stateDir, "L001-I1", task);
    writeCandidateMetrics(stateDir, "L001-I1", makeMetrics("L001-I1"));
    writeCandidateMetrics(stateDir, "L001-I1", { ...makeMetrics("L001-I1"), score: 8 });
    writeCandidateIntegrity(stateDir, "L001-I1", makeIntegrity("L001-I1", "baseline"));
    writeCandidatePostmortem(stateDir, "L001-I1", "# Result\n\nUseful failure.");

    const paths = candidateRunPaths(stateDir, "L001-I1");
    expect(JSON.parse(fs.readFileSync(paths.task, "utf8"))).toEqual(task);
    expect(JSON.parse(fs.readFileSync(paths.metrics, "utf8")).score).toBe(8);
    expect(fs.readFileSync(paths.postmortem, "utf8")).toBe("# Result\n\nUseful failure.\n");
    expect(fs.readdirSync(paths.root).some((name) => name.includes(".tmp-"))).toBe(false);
    expect(() => writeCandidateTask(stateDir, "L001-I1", task)).toThrow(/immutable/);
    expect(() => writeCandidateProposal(stateDir, "L001-I1", proposal)).toThrow(/immutable/);
    expect(() =>
      writeCandidateMetrics(stateDir, "L001-I1", makeMetrics("L999-I1")),
    ).toThrow(/candidate ID mismatch/);
  });

  it("requires a complete run before sealing and rejects all later writes", () => {
    createCandidateRun(stateDir, {
      candidateId: "L001-I2",
      parentCandidateId: "baseline",
      baseRevision: "abc",
    });
    expect(() =>
      sealCandidateRun(stateDir, "L001-I2", { terminalStatus: "failed" }),
    ).toThrow(/missing required artifacts/);

    populateCompleteRun(stateDir, "L001-I2", "baseline");
    expect(candidateRunReadiness(stateDir, "L001-I2")).toEqual({ ready: true, missing: [] });
    const sealed = sealCandidateRun(stateDir, "L001-I2", {
      terminalStatus: "done-no-improvement",
      sealedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(sealed.status).toBe("sealed");
    expect(sealed.terminalStatus).toBe("done-no-improvement");
    expect(isCandidateRunSealed(stateDir, "L001-I2")).toBe(true);
    expect(() =>
      writeCandidateMetrics(stateDir, "L001-I2", makeMetrics("L001-I2")),
    ).toThrow(/sealed and immutable/);
    expect(() =>
      sealCandidateRun(stateDir, "L001-I2", { terminalStatus: "done-no-improvement" }),
    ).toThrow(/sealed and immutable/);
  });

  it("snapshots and materializes the exact editable surface, including deletions", () => {
    const source = path.join(root, "source-repo");
    const snapshot = path.join(root, "snapshot");
    const target = path.join(root, "target-worktree");
    fs.mkdirSync(path.join(source, "src", "solution"), { recursive: true });
    fs.mkdirSync(path.join(source, "outside"), { recursive: true });
    fs.writeFileSync(path.join(source, "src", "solution", "a.txt"), "parent-a\n");
    fs.writeFileSync(path.join(source, "src", "solution", "b.txt"), "parent-b\n");
    fs.writeFileSync(path.join(source, "outside", "ignored.txt"), "ignored\n");
    snapshotEditableSource(source, snapshot, ["src/solution/"]);

    fs.mkdirSync(path.join(target, "src", "solution"), { recursive: true });
    fs.writeFileSync(path.join(target, "src", "solution", "a.txt"), "old-a\n");
    fs.writeFileSync(path.join(target, "src", "solution", "stale.txt"), "delete me\n");
    copyEditableSource(snapshot, target, ["src/solution"]);

    expect(fs.readFileSync(path.join(target, "src", "solution", "a.txt"), "utf8")).toBe("parent-a\n");
    expect(fs.readFileSync(path.join(target, "src", "solution", "b.txt"), "utf8")).toBe("parent-b\n");
    expect(fs.existsSync(path.join(target, "src", "solution", "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(snapshot, "outside", "ignored.txt"))).toBe(false);
    expect(() => snapshotEditableSource(source, snapshot, ["../outside"])).toThrow(/remain inside/);
    expect(() => snapshotEditableSource(source, source, ["src"])).toThrow(/roots must differ/);
    expect(() => copyEditableSource(snapshot, target, ["."])).toThrow(/remain inside/);
  });

  it("generates deterministic parent-relative text, binary, symlink, add, and delete diffs", () => {
    const parent = path.join(root, "parent");
    const candidate = path.join(root, "candidate");
    for (const directory of [parent, candidate]) {
      fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    }
    fs.writeFileSync(path.join(parent, "src", "changed.txt"), "old\n");
    fs.writeFileSync(path.join(candidate, "src", "changed.txt"), "new\n");
    fs.writeFileSync(path.join(parent, "src", "deleted.txt"), "gone\n");
    fs.writeFileSync(path.join(candidate, "src", "added.txt"), "hello\n");
    fs.writeFileSync(path.join(parent, "src", "binary.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(candidate, "src", "binary.bin"), Buffer.from([0, 1, 3]));
    fs.symlinkSync("changed.txt", path.join(parent, "src", "link"));
    fs.symlinkSync("added.txt", path.join(candidate, "src", "link"));

    const first = generateCandidateDiff(parent, candidate, ["src"]);
    const second = generateCandidateDiff(parent, candidate, ["src"]);
    expect(second).toBe(first);
    expect(first).toContain("diff --git a/src/changed.txt b/src/changed.txt");
    expect(first).toContain("-old");
    expect(first).toContain("+new");
    expect(first).toContain("--- /dev/null");
    expect(first).toContain("+++ /dev/null");
    expect(first).toContain("Binary files differ (sha256");
    expect(first).toContain("@@ symlink @@");
  });

  it("writes a candidate diff into the active run", () => {
    const parent = path.join(root, "parent");
    const candidate = path.join(root, "candidate");
    fs.mkdirSync(path.join(parent, "src"), { recursive: true });
    fs.mkdirSync(path.join(candidate, "src"), { recursive: true });
    fs.writeFileSync(path.join(parent, "src", "value.txt"), "1\n");
    fs.writeFileSync(path.join(candidate, "src", "value.txt"), "2\n");
    createCandidateRun(stateDir, {
      candidateId: "L002-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc",
    });

    const diff = writeCandidateDiff(stateDir, "L002-I1", parent, candidate, ["src"]);
    expect(fs.readFileSync(candidateRunPaths(stateDir, "L002-I1").diff, "utf8")).toBe(diff);
  });

  it("serializes append-only ledger writes and accepts only matching sealed runs", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => `L003-I${index + 1}`);
    for (const candidateId of candidates) {
      createCandidateRun(stateDir, {
        candidateId,
        parentCandidateId: "baseline",
        baseRevision: "abc",
      });
      sealCandidateRun(stateDir, candidateId, {
        terminalStatus: "done-no-improvement",
        requiredArtifacts: [],
        sealedAt: `2026-01-01T00:00:0${candidates.indexOf(candidateId)}.000Z`,
      });
    }

    await Promise.all(
      candidates.map((candidateId) =>
        appendLedgerRecord(stateDir, {
          candidateId,
          parentCandidateId: "baseline",
          title: candidateId,
          terminalStatus: "done-no-improvement",
          searchMode: "exploration",
          editFamily: "test",
          comparisonScore: 10,
          score: 10,
          improved: false,
        }),
      ),
    );

    const ledger = readLedger(stateDir);
    expect(ledger.map((entry) => entry.candidateId)).toEqual(candidates);
    expect(new Set(ledger.map((entry) => entry.candidateId)).size).toBe(candidates.length);
    expect(fs.readFileSync(archivePaths(stateDir).ledger, "utf8").trim().split("\n")).toHaveLength(8);
    await expect(
      appendLedgerRecord(stateDir, {
        candidateId: candidates[0]!,
        parentCandidateId: "baseline",
        title: "duplicate",
        terminalStatus: "done-no-improvement",
        searchMode: "exploration",
        editFamily: "test",
        comparisonScore: 10,
        improved: false,
      }),
    ).rejects.toThrow(/already contains/);

    createCandidateRun(stateDir, {
      candidateId: "L004-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc",
    });
    await expect(
      appendLedgerRecord(stateDir, {
        candidateId: "L004-I1",
        parentCandidateId: "baseline",
        title: "active",
        terminalStatus: "failed",
        searchMode: "repair",
        editFamily: "test",
        comparisonScore: 10,
        improved: false,
      }),
    ).rejects.toThrow(/active candidate/);
  });

  function populateCompleteRun(state: string, candidateId: string, parentCandidateId: string): void {
    const paths = candidateRunPaths(state, candidateId);
    writeCandidateProposal(state, candidateId, makeProposal(candidateId, parentCandidateId));
    writeCandidateTask(state, candidateId, makeTask(state, candidateId, parentCandidateId));
    writeCandidateParent(state, candidateId, makeParent(candidateId, parentCandidateId));
    fs.writeFileSync(path.join(paths.source, "snapshot.txt"), "source\n");
    fs.writeFileSync(paths.diff, "diff\n");
    writeCandidateMetrics(state, candidateId, makeMetrics(candidateId));
    writeCandidateIntegrity(state, candidateId, makeIntegrity(candidateId, parentCandidateId));
    writeCandidatePostmortem(state, candidateId, "# Postmortem\n\nLearned something.");
    fs.writeFileSync(paths.verifyLog, "verify ok\n");
    fs.writeFileSync(paths.benchmarkLog, "benchmark skipped after failure\n");
  }
});

function makeProposal(candidateId: string, parentCandidateId: string): CandidateProposalV1 {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    title: `Proposal ${candidateId}`,
    parentCandidateId,
    searchMode: "exploration",
    editFamily: "test",
    evidenceRefs: [],
    observation: "A test observation.",
    hypothesis: "A test hypothesis.",
    intervention: "Change the test candidate.",
    expectedResult: "The score improves.",
    falsifiedWhen: "The score does not improve.",
    risks: [],
    nonGoals: [],
    spec: "Implement the test candidate.",
  };
}

function makeTask(stateDir: string, candidateId: string, parentCandidateId: string): PhdImplementationTaskV1 {
  const paths = candidateRunPaths(stateDir, candidateId);
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    taskId: `${candidateId}-implement`,
    kind: "implement",
    role: "phd",
    taskPath: paths.task,
    stateDir,
    resultPath: path.join(paths.agentDir, "result.json"),
    input: {
      candidateId,
      parentCandidateId,
      attempt: 1,
      maximumAttempts: 3,
      proposalPath: paths.proposal,
      requiredEvidence: [],
      repositoryInstructionPaths: [],
      editablePaths: ["src"],
      readOnlyPaths: [stateDir],
      verifyCommand: "./verify.sh",
      benchmarkProhibited: true,
      requiredCompletionFields: ["changedFiles", "checks"],
    },
  };
}

function makeMetrics(candidateId: string): CandidateMetricsV1 {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    candidateId,
    terminalStatus: "done-no-improvement",
    comparisonScore: 10,
    score: 10,
    improved: false,
    verify: [],
  };
}

function makeIntegrity(candidateId: string, parentCandidateId: string): CandidateIntegrityV1 {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    candidateId,
    parentCandidateId,
    checkedAt: "2026-01-01T00:00:00.000Z",
    passed: true,
    changedFiles: ["src/value.txt"],
    unexpectedFiles: [],
  };
}

function makeParent(candidateId: string, parentCandidateId: string): CandidateParentV1 {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    candidateId,
    parentCandidateId,
    baseRevision: "abc",
    parentSourcePath: `../${parentCandidateId}/source`,
  };
}
