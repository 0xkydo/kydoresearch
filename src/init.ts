import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner } from "./agents/types.ts";
import { candidateRunPaths, snapshotEditableSource } from "./archive.ts";
import { YukonCliAdapter } from "./challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "./challenge/detect.ts";
import type { BenchmarkManifest, ScoreResult } from "./challenge/types.ts";
import type { HarnessConfig } from "./config.ts";
import { loadConfig, saveConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import { retryOperation, type RetryDelay } from "./retry.ts";
import type {
  LocalEvaluationV1,
  SetupDecisionTaskV1,
  SetupResultV1,
  SetupReviewTaskV1,
  SetupTaskV1,
} from "./experiments.ts";
import { EXPERIMENT_SCHEMA_VERSION, validateResearchTask } from "./experiments.ts";
import {
  InitializationError,
  type InitializationDiagnosticV1,
} from "./initialization.ts";
import type { ChallengeInfo, LoopState } from "./state.ts";
import { newLoopState, saveState, STATE_DIR_NAME, statePaths } from "./state.ts";
import { LocalTelemetry } from "./telemetry.ts";
import { appendJournal, atomicWriteJson, readJsonIfExists } from "./util.ts";

export interface InitResult {
  state: LoopState;
  config: HarnessConfig;
  stateDir: string;
}

export interface InitProgress {
  stage:
    | "validate"
    | "setup"
    | "setup-agent"
    | "baseline"
    | "baseline-review"
    | "archive"
    | "ready";
  status: "running" | "retrying" | "succeeded" | "resuming";
  message: string;
  command?: string;
  attempt?: number;
  maxAttempts?: number;
  logPath?: string;
  localEvaluation?: LocalEvaluationV1;
  baselineScore?: number;
  direction?: "+" | "-";
  verifyCommand?: string;
  benchCommand?: string;
  submissionReady?: boolean;
  evidencePath?: string;
}

/**
 * First-run initialization inside a challenge repo:
 *  1. Read + validate benchmark.json; guard that .autoresearch/ is outside editablePaths.
 *  2. Scaffold .autoresearch/ and hide it via .git/info/exclude (local-only,
 *     never dirties submission tarballs).
 *  3. Run setupCommand (dependency install) and fail loudly if it fails.
 *  4. Run the setup agent ("init.explore") to classify the repository's
 *     existing commands and choose the best supported local evaluation mode.
 *     A legacy request for user judgment is resolved by a separate,
 *     autonomous Setup decision task.
 *  5. Persist the effective command result before baseline measurement.
 *  6. If the first baseline fails, let Setup review that evidence before the
 *     remaining bounded command attempt.
 *  7. Persist config.json + state.json at phase "ready".
 */
export async function initChallenge(opts: {
  repoRoot: string;
  runner: AgentRunner;
  exec: ExecPort;
  signal?: AbortSignal;
  emit?: (msg: string) => void;
  /** Structured first-run progress for persistent interactive status surfaces. */
  onProgress?: (progress: InitProgress) => void;
  /** Injectable for deterministic retry tests. */
  delay?: RetryDelay;
}): Promise<InitResult> {
  const { repoRoot, runner, exec } = opts;
  const emit = opts.emit ?? (() => {});
  let manifest: BenchmarkManifest;
  try {
    manifest = readManifest(repoRoot);
  } catch (error) {
    throw new InitializationError({
      code: "invalid-manifest",
      step: "validate",
      title: "Challenge manifest is invalid",
      reason: error instanceof Error ? error.message : String(error),
      action: "Fix benchmark.json, then retry /autoresearch.",
      evidencePath: path.join(repoRoot, "benchmark.json"),
      retryable: true,
      resumesFromCheckpoint: false,
    });
  }
  opts.onProgress?.({
    stage: "validate",
    status: "running",
    message: "validating benchmark.json and Git checkout",
  });
  const gitCheck = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  if (gitCheck.code !== 0 || gitCheck.stdout.trim() !== "true") {
    throw new InitializationError({
      code: "not-git-repository",
      step: "validate",
      title: "Git checkout is required",
      reason: `Not a git repository: ${repoRoot}.`,
      action: "Clone the challenge, cd into it, then retry /autoresearch.",
      retryable: true,
      resumesFromCheckpoint: false,
    });
  }

  if (isInsideEditablePaths(STATE_DIR_NAME, manifest.editablePaths)) {
    throw new InitializationError({
      code: "state-path-conflict",
      step: "validate",
      title: "Harness state overlaps the submission surface",
      reason: `.autoresearch/ falls inside editablePaths (${manifest.editablePaths.join(", ")}).`,
      action:
        "Narrow editablePaths in benchmark.json so .autoresearch is excluded, then retry.",
      evidencePath: path.join(repoRoot, "benchmark.json"),
      retryable: true,
      resumesFromCheckpoint: false,
    });
  }
  opts.onProgress?.({
    stage: "validate",
    status: "succeeded",
    message: "challenge manifest and Git checkout are valid",
  });

  const stateDir = path.join(repoRoot, STATE_DIR_NAME);
  const paths = statePaths(stateDir);
  const telemetry = new LocalTelemetry(paths.telemetry);
  fs.mkdirSync(paths.ideasDir, { recursive: true });
  fs.mkdirSync(paths.loopsDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.resolvedAgentsDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.notesDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  excludeAutoresearchStateFromGit(repoRoot);

  const config = loadConfig(stateDir);
  const cli = detectCli(repoRoot, manifest);
  const setupTaskDir = path.join(paths.loopsDir, "init");
  fs.mkdirSync(setupTaskDir, { recursive: true });
  const setupTaskPath = path.join(setupTaskDir, "setup-task.json");
  const setupResultPath = path.join(setupTaskDir, "setup-result.json");
  const revision = await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (revision.code !== 0 || revision.stdout.trim() === "") {
    throw new InitializationError({
      code: "persistence-failed",
      step: "archive",
      title: "Baseline revision could not be recorded",
      reason: revision.stderr.trim() || "git rev-parse HEAD returned no revision.",
      action: "Repair the Git checkout, then retry /autoresearch.",
      retryable: true,
      resumesFromCheckpoint: false,
    });
  }
  const checkpointFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        manifest,
        revision: revision.stdout.trim(),
        setupRole: config.roles.setup,
        setupDecisionContract: "autonomous-local-evaluation-v2",
      }),
    )
    .digest("hex");

  const retryPolicy = {
    maxAttempts: config.resilience.commandMaxAttempts,
    baseDelayMs: config.resilience.retryBaseDelayMs,
    maxDelayMs: config.resilience.retryMaxDelayMs,
    signal: opts.signal,
    delay: opts.delay,
  };
  let verifyCommand: string;
  let benchCommand: string;
  let subjectArea: string | undefined;
  let localEvaluation: LocalEvaluationV1;
  let reviewCount = 0;
  const persistedSetup = loadSetupResult(setupResultPath, checkpointFingerprint);

  if (persistedSetup) {
    verifyCommand = persistedSetup.verifyCommand;
    benchCommand = persistedSetup.benchCommand;
    subjectArea = persistedSetup.subjectArea;
    localEvaluation = persistedSetup.localEvaluation;
    reviewCount = persistedSetup.reviewCount;
    emit(`init: resuming from durable Setup result (bench: ${benchCommand})`);
    opts.onProgress?.({
      stage: "baseline",
      status: "resuming",
      message: "resuming the saved baseline command",
      command: benchCommand,
      logPath: path.join(paths.logsDir, "benchmark.log"),
      localEvaluation,
    });
  } else {
    // Phase init.setup — dependency install before anything else.
    emit(`init: running setup (${manifest.setupCommand})`);
    opts.onProgress?.({
      stage: "setup",
      status: "running",
      message: "running challenge dependency setup",
      command: manifest.setupCommand,
      attempt: 1,
      maxAttempts: config.resilience.commandMaxAttempts,
      logPath: path.join(paths.logsDir, "setup.log"),
    });
    appendJournal(paths.journal, { phase: "init.setup", setupCommand: manifest.setupCommand });
    const bootstrapAdapter = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli,
      execution: config.execution,
      logDir: paths.logsDir,
      exec,
    });
    const setup = await telemetry.measure(
      "init.setup",
      { scope: "init" },
      () =>
        retryOperation({
          ...retryPolicy,
          operation: (attempt) => {
            opts.onProgress?.({
              stage: "setup",
              status: attempt === 1 ? "running" : "retrying",
              message: "running challenge dependency setup",
              command: manifest.setupCommand,
              attempt,
              maxAttempts: config.resilience.commandMaxAttempts,
              logPath: path.join(paths.logsDir, "setup.log"),
            });
            return bootstrapAdapter.setup(opts.signal);
          },
          isSuccess: (result) => result.ok,
          onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) => {
            emit(
              `init: setup failed (attempt ${attempt}/${maxAttempts}); retrying in ${nextDelayMs}ms` +
                (value?.raw ? ` · ${firstLine(value.raw)}` : ""),
            );
          },
        }),
      (result) => (opts.signal?.aborted ? "aborted" : result.ok ? "ok" : "error"),
    );
    if (!setup.ok) {
      throw new InitializationError(
        commandDiagnostic(
          "setup",
          setup,
          manifest.setupCommand,
          path.join(paths.logsDir, "setup.log"),
        ),
      );
    }
    opts.onProgress?.({
      stage: "setup",
      status: "succeeded",
      message: "challenge dependency setup completed",
      command: manifest.setupCommand,
      logPath: path.join(paths.logsDir, "setup.log"),
    });

    // Phase init.knowledge — Setup classifies the repo's existing harness inputs,
    // confirms readiness, and writes the knowledge base.
    emit("init: Setup agent is reviewing the repository and local hardware");
    opts.onProgress?.({
      stage: "setup-agent",
      status: "running",
      message: "Setup agent is reviewing repository and hardware evidence",
      attempt: 1,
      maxAttempts: config.resilience.agentMaxAttempts,
      logPath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
    });
    appendJournal(paths.journal, { phase: "init.knowledge" });
    const setupTask: SetupTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: "init-setup",
      kind: "init.explore",
      role: "setup",
      taskPath: setupTaskPath,
      stateDir,
      resultPath: setupResultPath,
      input: {
        repoRoot,
        manifestPath: path.join(repoRoot, "benchmark.json"),
        knowledgeBasePath: paths.knowledgeBase,
        setupCommand: manifest.setupCommand,
        setupLogPath: path.join(paths.logsDir, "setup.log"),
        setupSucceeded: true,
      },
    };
    validateResearchTask(setupTask);
    atomicWriteJson(setupTaskPath, setupTask);
    const explore = await telemetry.measure(
      "setup.explore",
      { scope: "init" },
      () =>
        retryOperation({
          ...retryPolicy,
          maxAttempts: config.resilience.agentMaxAttempts,
          operation: (attempt) => {
            opts.onProgress?.({
              stage: "setup-agent",
              status: attempt === 1 ? "running" : "retrying",
              message: "Setup agent is reviewing repository and hardware evidence",
              attempt,
              maxAttempts: config.resilience.agentMaxAttempts,
              logPath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
            });
            return runner.run({
              role: "setup",
              kind: "init.explore",
              cwd: repoRoot,
              stateDir,
              input: {
                ...setupTask.input,
                manifest,
                taskPath: setupTaskPath,
                traceDir: path.join(paths.resolvedAgentsDir, "setup"),
              },
              signal: opts.signal,
            });
          },
          isSuccess: (result) => result.ok,
          onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) =>
            emit(
              `init: setup agent failed (attempt ${attempt}/${maxAttempts}); retrying in ${nextDelayMs}ms` +
                (value ? ` · ${firstLine(value.error ?? value.output)}` : ""),
            ),
        }),
      (result) => (opts.signal?.aborted ? "aborted" : result.ok ? "ok" : "error"),
    );
    if (!explore.ok) {
      throw new InitializationError({
        code: "setup-agent-failed",
        step: "setup-agent",
        title: "Setup profile could not complete",
        reason: firstLine(explore.error ?? explore.output) || "The Setup worker failed.",
        action:
          "Check the configured Setup model and provider, inspect its trace, then retry /autoresearch.",
        evidencePath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
        retryable: true,
        resumesFromCheckpoint: false,
      });
    }

    let structured = explore.structured ?? {};
    const initialDecision = await resolveAutonomousSetupDecision(structured, {
      stage: "setup-agent",
      previousVerifyCommand: manifest.preSubmitCommand ?? manifest.benchmarkCommand,
      previousBenchCommand: manifest.benchmarkCommand,
      evidencePaths: [
        path.join(repoRoot, "benchmark.json"),
        path.join(paths.logsDir, "setup.log"),
        paths.knowledgeBase,
      ],
    });
    structured = initialDecision.structured;
    if (
      structured.status !== "ready" &&
      (typeof structured.verifyCommand !== "string" ||
        typeof structured.benchCommand !== "string")
    ) {
      throw new InitializationError({
        code: "setup-result-invalid",
        step: "setup-agent",
        title: "Setup returned an incomplete readiness result",
        reason:
          "The Setup result contained neither a ready decision nor usable verification and benchmark commands.",
        action:
          "Inspect the Setup trace or restore the bundled Setup prompt, then retry /autoresearch.",
        evidencePath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
        retryable: true,
        resumesFromCheckpoint: false,
      });
    }
    verifyCommand = commandFromResult(
      structured.verifyCommand,
      manifest.preSubmitCommand ?? manifest.benchmarkCommand,
    );
    benchCommand = commandFromResult(structured.benchCommand, manifest.benchmarkCommand);
    subjectArea =
      typeof structured.subjectArea === "string" && structured.subjectArea.trim()
        ? structured.subjectArea.trim()
        : undefined;
    localEvaluation = localEvaluationFromResult(structured.localEvaluation);
    writeSetupResult(setupResultPath, {
      checkpointFingerprint,
      verifyCommand,
      benchCommand,
      subjectArea,
      localEvaluation,
      knowledgeBasePath: paths.knowledgeBase,
      reviewCount,
      summary: combineSetupSummaries(explore.output, initialDecision.summary),
    });
    opts.onProgress?.({
      stage: "setup-agent",
      status: "succeeded",
      message: "Setup agent selected effective local commands",
      command: benchCommand,
      logPath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
      localEvaluation,
    });
  }

  const challenge: ChallengeInfo = {
    name: manifest.name,
    cli: cli ?? "",
    direction: manifest.direction,
    setupCommand: manifest.setupCommand,
    verifyCommand,
    benchCommand,
    preSubmitCommand: manifest.preSubmitCommand,
    submitNeedsModel: cli === "mlxfast",
    editablePaths: manifest.editablePaths,
    scorePath: manifest.scorePath,
    subjectArea,
    localEvaluation,
  };

  // Establish the baseline score (real yukon CLIs run the benchmark once on
  // clone). Without a baseline, the first valid idea would always "improve".
  emit(`init: measuring baseline (${benchCommand})`);
  let baselineAdapter = makeBaselineAdapter();
  const baseline = await telemetry.measure(
    "challenge.benchmark",
    { scope: "init" },
    () =>
      retryOperation({
        ...retryPolicy,
        operation: (attempt) => {
          opts.onProgress?.({
            stage: "baseline",
            status: attempt === 1 ? "running" : "retrying",
            message: "measuring the local baseline",
            command: benchCommand,
            attempt,
            maxAttempts: config.resilience.commandMaxAttempts,
            logPath: path.join(paths.logsDir, "benchmark.log"),
            localEvaluation,
          });
          return baselineAdapter.bench(undefined, opts.signal);
        },
        isSuccess: (result) => result.ok && result.score !== undefined,
        onRetry: async ({ attempt, maxAttempts, nextDelayMs, value }) => {
          emit(
            `init: baseline failed (attempt ${attempt}/${maxAttempts}); Setup is reviewing the failure` +
              (value?.raw ? ` · ${firstLine(value.raw)}` : ""),
          );
          if (value) await reviewBaselineFailure(value, attempt, maxAttempts);
          emit(`init: retrying baseline in ${nextDelayMs}ms (bench: ${benchCommand})`);
        },
      }),
    (result) =>
      opts.signal?.aborted
        ? "aborted"
        : result.ok && result.score !== undefined
          ? "ok"
          : "error",
  );
  if (!baseline.ok || baseline.score === undefined) {
    throw new InitializationError(
      baselineDiagnostic(
        baseline,
        benchCommand,
        manifest.scorePath,
        path.join(paths.logsDir, "benchmark.log"),
      ),
    );
  }
  opts.onProgress?.({
    stage: "baseline",
    status: "succeeded",
    message: "local baseline completed",
    command: benchCommand,
    logPath: path.join(paths.logsDir, "benchmark.log"),
    localEvaluation,
  });

  opts.onProgress?.({
    stage: "archive",
    status: "running",
    message: "archiving the baseline and saving ready state",
  });
  let state: LoopState;
  let baselinePaths;
  try {
    state = newLoopState(challenge);
    state.bestScore = baseline.score;
    state.bestCandidateId = "baseline";
    baselinePaths = candidateRunPaths(stateDir, "baseline");
    snapshotEditableSource(repoRoot, baselinePaths.source, challenge.editablePaths);
    atomicWriteJson(path.join(baselinePaths.root, "baseline.json"), {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      candidateId: "baseline",
      baseRevision: revision.stdout.trim(),
      score: baseline.score,
      capturedAt: new Date().toISOString(),
      editablePaths: challenge.editablePaths,
    });
    state.phase = "ready";
    saveState(stateDir, state);
    saveConfig(stateDir, config);
  } catch (error) {
    throw new InitializationError({
      code: "persistence-failed",
      step: "archive",
      title: "Ready state could not be saved",
      reason: error instanceof Error ? error.message : String(error),
      action:
        "Check filesystem permissions and available disk space, then retry /autoresearch.",
      evidencePath: path.join(stateDir, "loops", "init"),
      retryable: true,
      resumesFromCheckpoint: true,
    });
  }
  appendJournal(paths.journal, {
    phase: "ready",
    challenge: challenge.name,
    verifyCommand,
    benchCommand,
    localEvaluation,
  });
  emit(`init: ready (verify: ${verifyCommand} · bench: ${benchCommand})`);
  opts.onProgress?.({
    stage: "archive",
    status: "succeeded",
    message: "initialization complete",
    command: benchCommand,
    localEvaluation,
    baselineScore: baseline.score,
    direction: manifest.direction,
    verifyCommand,
    benchCommand,
    submissionReady:
      Boolean(cli) &&
      (cli !== "mlxfast" || Boolean(config.submitModelName?.trim())),
    evidencePath: baselinePaths.root,
  });

  return { state, config, stateDir };

  function makeBaselineAdapter(): YukonCliAdapter {
    return new YukonCliAdapter({
      repoRoot,
      manifest,
      cli,
      verifyCommand,
      benchCommand,
      execution: config.execution,
      logDir: paths.logsDir,
      exec,
    });
  }

  async function reviewBaselineFailure(
    failed: ScoreResult,
    attempt: number,
    maxAttempts: number,
  ): Promise<void> {
    const reviewTaskPath = path.join(setupTaskDir, "setup-review-task.json");
    const reviewTask: SetupReviewTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `init-setup-review-${reviewCount + 1}`,
      kind: "init.review",
      role: "setup",
      taskPath: reviewTaskPath,
      stateDir,
      resultPath: setupResultPath,
      input: {
        repoRoot,
        manifestPath: path.join(repoRoot, "benchmark.json"),
        knowledgeBasePath: paths.knowledgeBase,
        previousVerifyCommand: verifyCommand,
        previousBenchCommand: benchCommand,
        benchmarkLogPath: path.join(paths.logsDir, "benchmark.log"),
        scorePath: path.join(repoRoot, manifest.scorePath),
        benchmarkExitCode: failed.exitCode,
        benchmarkFailureTail: failed.raw.trim() || `benchmark exited ${failed.exitCode}`,
      },
    };
    validateResearchTask(reviewTask);
    atomicWriteJson(reviewTaskPath, reviewTask);
    appendJournal(paths.journal, {
      phase: "init.review",
      attempt,
      benchmarkExitCode: failed.exitCode,
    });
    opts.onProgress?.({
      stage: "baseline-review",
      status: "running",
      message: "Setup is reviewing the failed baseline",
      command: benchCommand,
      attempt,
      maxAttempts,
      logPath: path.join(paths.logsDir, "benchmark.log"),
      localEvaluation,
    });

    const review = await telemetry.measure(
      "setup.review",
      { scope: "init", attempt },
      () =>
        retryOperation({
          ...retryPolicy,
          maxAttempts: config.resilience.agentMaxAttempts,
          operation: (agentAttempt) => {
            opts.onProgress?.({
              stage: "baseline-review",
              status: agentAttempt === 1 ? "running" : "retrying",
              message: "Setup is reviewing the failed baseline",
              command: benchCommand,
              attempt: agentAttempt,
              maxAttempts: config.resilience.agentMaxAttempts,
              logPath: path.join(paths.resolvedAgentsDir, "setup-review", "events.ndjson"),
              localEvaluation,
            });
            return runner.run({
              role: "setup",
              kind: "init.review",
              cwd: repoRoot,
              stateDir,
              input: {
                ...reviewTask.input,
                manifest,
                taskPath: reviewTaskPath,
                traceDir: path.join(paths.resolvedAgentsDir, "setup-review"),
              },
              signal: opts.signal,
            });
          },
          isSuccess: (result) => result.ok,
          onRetry: ({ attempt: agentAttempt, maxAttempts: agentMax, nextDelayMs, value }) =>
            emit(
              `init: Setup review failed (attempt ${agentAttempt}/${agentMax}); ` +
                `retrying in ${nextDelayMs}ms` +
                (value ? ` · ${firstLine(value.error ?? value.output)}` : ""),
            ),
        }),
      (result) => (opts.signal?.aborted ? "aborted" : result.ok ? "ok" : "error"),
    );
    if (!review.ok) {
      throw new InitializationError({
        code: "setup-agent-failed",
        step: "baseline",
        title: "Setup could not review the failed baseline",
        reason: firstLine(review.error ?? review.output) || "The Setup review worker failed.",
        action:
          "Inspect the Setup review trace and benchmark log, then retry /autoresearch.",
        evidencePath: path.join(paths.resolvedAgentsDir, "setup-review", "events.ndjson"),
        retryable: true,
        resumesFromCheckpoint: true,
      });
    }
    let structured = review.structured ?? {};
    const reviewedDecision = await resolveAutonomousSetupDecision(structured, {
      stage: "baseline-review",
      previousVerifyCommand: verifyCommand,
      previousBenchCommand: benchCommand,
      evidencePaths: [
        path.join(repoRoot, "benchmark.json"),
        paths.knowledgeBase,
        path.join(paths.logsDir, "benchmark.log"),
        path.join(repoRoot, manifest.scorePath),
      ],
    });
    structured = reviewedDecision.structured;
    if (
      structured.status !== "ready" &&
      (typeof structured.verifyCommand !== "string" ||
        typeof structured.benchCommand !== "string")
    ) {
      throw new InitializationError({
        code: "setup-result-invalid",
        step: "baseline",
        title: "Setup review returned an incomplete recovery decision",
        reason:
          "The review contained neither a ready decision nor usable revised commands.",
        action:
          "Inspect the Setup review trace or restore the bundled prompt, then retry /autoresearch.",
        evidencePath: path.join(paths.resolvedAgentsDir, "setup-review", "events.ndjson"),
        retryable: true,
        resumesFromCheckpoint: true,
      });
    }

    verifyCommand = commandFromResult(structured.verifyCommand, verifyCommand);
    benchCommand = commandFromResult(structured.benchCommand, benchCommand);
    challenge.verifyCommand = verifyCommand;
    challenge.benchCommand = benchCommand;
    if (typeof structured.subjectArea === "string" && structured.subjectArea.trim()) {
      subjectArea = structured.subjectArea.trim();
      challenge.subjectArea = subjectArea;
    }
    localEvaluation = localEvaluationFromResult(
      structured.localEvaluation,
      localEvaluation,
    );
    challenge.localEvaluation = localEvaluation;
    reviewCount += 1;
    writeSetupResult(setupResultPath, {
      checkpointFingerprint,
      verifyCommand,
      benchCommand,
      subjectArea,
      localEvaluation,
      knowledgeBasePath: paths.knowledgeBase,
      reviewCount,
      summary: combineSetupSummaries(review.output, reviewedDecision.summary),
    });
    baselineAdapter = makeBaselineAdapter();
    opts.onProgress?.({
      stage: "baseline-review",
      status: "succeeded",
      message:
        benchCommand === reviewTask.input.previousBenchCommand
          ? "Setup retained the benchmark command for a transient retry"
          : "Setup selected a revised benchmark command",
      command: benchCommand,
      logPath: path.join(paths.resolvedAgentsDir, "setup-review", "events.ndjson"),
      localEvaluation,
    });
  }

  async function resolveAutonomousSetupDecision(
    structured: Record<string, unknown>,
    context: {
      stage: "setup-agent" | "baseline-review";
      previousVerifyCommand: string;
      previousBenchCommand: string;
      evidencePaths: string[];
    },
  ): Promise<{ structured: Record<string, unknown>; summary?: string }> {
    if (structured.status === "blocked-external") {
      throw externalBlockerError(structured.externalBlocker, context.stage);
    }
    if (structured.status !== "needs-user-action") return { structured };

    const decisionRequest = describeSetupDecisionRequest(structured.userAction);
    const decisionNumber = reviewCount + 1;
    const decisionId =
      context.stage === "setup-agent" ? "initial" : `review-${decisionNumber}`;
    const decisionTaskPath = path.join(
      setupTaskDir,
      `setup-decision-task-${decisionId}.json`,
    );
    const decisionTask: SetupDecisionTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `init-setup-decision-${decisionId}`,
      kind: "init.decide",
      role: "setup",
      taskPath: decisionTaskPath,
      stateDir,
      resultPath: setupResultPath,
      input: {
        repoRoot,
        manifestPath: path.join(repoRoot, "benchmark.json"),
        knowledgeBasePath: paths.knowledgeBase,
        previousVerifyCommand: context.previousVerifyCommand,
        previousBenchCommand: context.previousBenchCommand,
        decisionRequest,
        evidencePaths: context.evidencePaths,
      },
    };
    validateResearchTask(decisionTask);
    atomicWriteJson(decisionTaskPath, decisionTask);
    appendJournal(paths.journal, {
      phase: "init.decide",
      priorStage: context.stage,
      decisionRequest: firstLine(decisionRequest),
    });
    emit("init: Setup is resolving its judgment call autonomously");
    opts.onProgress?.({
      stage: context.stage,
      status: "running",
      message: "Setup is choosing the safest documented local mode",
      command: context.previousBenchCommand,
      attempt: 1,
      maxAttempts: config.resilience.agentMaxAttempts,
      logPath: path.join(
        paths.resolvedAgentsDir,
        `setup-decision-${decisionId}`,
        "events.ndjson",
      ),
    });

    const decision = await telemetry.measure(
      "setup.decide",
      { scope: "init", attempt: decisionNumber },
      () =>
        retryOperation({
          ...retryPolicy,
          maxAttempts: config.resilience.agentMaxAttempts,
          operation: (agentAttempt) => {
            opts.onProgress?.({
              stage: context.stage,
              status: agentAttempt === 1 ? "running" : "retrying",
              message: "Setup is choosing the safest documented local mode",
              command: context.previousBenchCommand,
              attempt: agentAttempt,
              maxAttempts: config.resilience.agentMaxAttempts,
              logPath: path.join(
                paths.resolvedAgentsDir,
                `setup-decision-${decisionId}`,
                "events.ndjson",
              ),
            });
            return runner.run({
              role: "setup",
              kind: "init.decide",
              cwd: repoRoot,
              stateDir,
              input: {
                ...decisionTask.input,
                manifest,
                taskPath: decisionTaskPath,
                traceDir: path.join(
                  paths.resolvedAgentsDir,
                  `setup-decision-${decisionId}`,
                ),
              },
              signal: opts.signal,
            });
          },
          isSuccess: (result) =>
            result.ok &&
            (result.structured?.status === "ready" ||
              result.structured?.status === "blocked-external"),
          onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) =>
            emit(
              `init: autonomous Setup decision failed (attempt ${attempt}/${maxAttempts}); ` +
                `retrying in ${nextDelayMs}ms` +
                (value ? ` · ${firstLine(value.error ?? value.output)}` : ""),
            ),
        }),
      (result) =>
        opts.signal?.aborted
          ? "aborted"
          : result.ok && result.structured?.status === "ready"
            ? "ok"
            : "error",
    );

    const resolved = decision.structured ?? {};
    if (resolved.status === "blocked-external") {
      throw externalBlockerError(resolved.externalBlocker, context.stage);
    }
    if (!decision.ok || resolved.status !== "ready") {
      throw new InitializationError({
        code: "setup-agent-failed",
        step: context.stage === "setup-agent" ? "setup-agent" : "baseline",
        title: "Setup could not resolve the local evaluation mode",
        reason:
          firstLine(decision.error ?? decision.output) ||
          "The autonomous Setup decision failed.",
        action:
          "Inspect the Setup decision trace and repository guidance, then retry /autoresearch.",
        evidencePath: path.join(
          paths.resolvedAgentsDir,
          `setup-decision-${decisionId}`,
          "events.ndjson",
        ),
        retryable: true,
        resumesFromCheckpoint: context.stage === "baseline-review",
      });
    }
    return { structured: resolved, summary: decision.output };
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
}

function commandFromResult(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function combineSetupSummaries(primary: string, decision: string | undefined): string {
  return decision?.trim()
    ? `${primary.trim()}\n\nAutonomous Setup decision:\n${decision.trim()}`
    : primary;
}

function writeSetupResult(
  resultPath: string,
  input: {
    checkpointFingerprint: string;
    verifyCommand: string;
    benchCommand: string;
    subjectArea?: string;
    localEvaluation: LocalEvaluationV1;
    knowledgeBasePath: string;
    reviewCount: number;
    summary: string;
  },
): void {
  const result: SetupResultV1 = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    taskId: "init-setup",
    kind: "init.explore.result",
    ok: true,
    summary: input.summary,
    knowledgeBasePath: input.knowledgeBasePath,
    verifyCommand: input.verifyCommand,
    benchCommand: input.benchCommand,
    localEvaluation: input.localEvaluation,
    checkpointFingerprint: input.checkpointFingerprint,
    reviewCount: input.reviewCount,
    ...(input.subjectArea ? { subjectArea: input.subjectArea } : {}),
  };
  atomicWriteJson(resultPath, result);
}

function loadSetupResult(
  resultPath: string,
  checkpointFingerprint: string,
): SetupResultV1 | null {
  const result = readJsonIfExists<Partial<SetupResultV1>>(resultPath);
  if (
    result?.schemaVersion !== EXPERIMENT_SCHEMA_VERSION ||
    result.kind !== "init.explore.result" ||
    result.ok !== true ||
    result.checkpointFingerprint !== checkpointFingerprint ||
    typeof result.verifyCommand !== "string" ||
    result.verifyCommand.trim() === "" ||
    typeof result.benchCommand !== "string" ||
    result.benchCommand.trim() === "" ||
    !isLocalEvaluation(result.localEvaluation) ||
    typeof result.knowledgeBasePath !== "string" ||
    typeof result.summary !== "string" ||
    typeof result.reviewCount !== "number" ||
    !Number.isInteger(result.reviewCount) ||
    result.reviewCount < 0
  ) {
    return null;
  }
  return result as SetupResultV1;
}

function localEvaluationFromResult(
  value: unknown,
  fallback?: LocalEvaluationV1,
): LocalEvaluationV1 {
  if (!isLocalEvaluation(value)) {
    return (
      fallback ?? {
        fidelity: "reduced",
        decision:
          "Setup selected local commands without declaring their fidelity; treat them conservatively as a regression signal.",
        limitations: ["Setup did not establish that the local commands cover the full evaluator."],
        officialValidationRequired: true,
      }
    );
  }
  return {
    fidelity: value.fidelity,
    decision: value.decision.trim(),
    limitations:
      value.fidelity === "reduced" && value.limitations.length === 0
        ? ["Setup selected reduced fidelity without identifying the uncovered evaluator paths."]
        : value.limitations.map((limitation) => limitation.trim()),
    officialValidationRequired:
      value.fidelity === "reduced" || value.officialValidationRequired,
  };
}

function isLocalEvaluation(value: unknown): value is LocalEvaluationV1 {
  if (typeof value !== "object" || value === null) return false;
  const evaluation = value as Record<string, unknown>;
  return (
    (evaluation.fidelity === "full" || evaluation.fidelity === "reduced") &&
    typeof evaluation.decision === "string" &&
    evaluation.decision.trim().length > 0 &&
    Array.isArray(evaluation.limitations) &&
    evaluation.limitations.every(
      (limitation) =>
        typeof limitation === "string" && limitation.trim().length > 0,
    ) &&
    typeof evaluation.officialValidationRequired === "boolean"
  );
}

function describeSetupDecisionRequest(value: unknown): string {
  const action =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const reason =
    typeof action.reason === "string" && action.reason.trim()
      ? action.reason.trim()
      : "Setup found that the challenge is not ready.";
  const location =
    typeof action.location === "string" && action.location.trim()
      ? `Where: ${action.location.trim()}`
      : undefined;
  const instructions = Array.isArray(action.instructions)
    ? action.instructions.filter(
        (instruction): instruction is string =>
          typeof instruction === "string" && instruction.trim().length > 0,
      )
    : typeof action.instructions === "string" && action.instructions.trim()
      ? [action.instructions.trim()]
      : [];
  return [
    reason,
    location,
    ...instructions.map((instruction) => `Requested action: ${instruction.trim()}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function externalBlockerError(
  value: unknown,
  stage: "setup-agent" | "baseline-review",
): InitializationError {
  const blocker =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const reason =
    typeof blocker.reason === "string" && blocker.reason.trim()
      ? blocker.reason.trim()
      : "Setup found a required external capability that is unavailable.";
  const evidencePath =
    typeof blocker.location === "string" && blocker.location.trim()
      ? blocker.location.trim()
      : undefined;
  const instructions = Array.isArray(blocker.instructions)
    ? blocker.instructions.filter(
        (instruction): instruction is string =>
          typeof instruction === "string" && instruction.trim().length > 0,
      )
    : [];
  return new InitializationError({
    code: "external-capability-blocker",
    step: stage === "setup-agent" ? "setup-agent" : "baseline",
    title: "Initialization is blocked by an external requirement",
    reason,
    action:
      `${
        instructions.map((instruction) => instruction.trim()).join(" ") ||
        "Provide the external capability."
      } Then retry /autoresearch.`,
    ...(evidencePath ? { evidencePath } : {}),
    retryable: true,
    resumesFromCheckpoint: stage === "baseline-review",
  });
}

function commandDiagnostic(
  step: "setup",
  result: ScoreResult,
  command: string,
  evidencePath: string,
): InitializationDiagnosticV1 {
  if (
    result.failureKind === "command-not-found" ||
    result.exitCode === 127 ||
    /(?:command not found|No such file or directory)/i.test(result.raw)
  ) {
    return {
      code: "command-not-found",
      step,
      title: "Dependency command could not start",
      reason: `The configured setup command "${command}" was not found or could not start.`,
      action:
        "Install the required executable or fix setupCommand in benchmark.json, then retry /autoresearch.",
      command,
      exitCode: result.exitCode,
      evidencePath,
      retryable: true,
      resumesFromCheckpoint: false,
    };
  }
  if (result.failureKind === "timeout" || result.timedOut) {
    return {
      code: "command-timeout",
      step,
      title: "Dependency setup timed out",
      reason: `The setup command exceeded its configured timeout.`,
      action:
        "Inspect the setup log; if it was making useful progress, increase setupTimeoutMs and retry.",
      command,
      exitCode: result.exitCode,
      evidencePath,
      retryable: true,
      resumesFromCheckpoint: false,
    };
  }
  return {
    code: "setup-command-failed",
    step,
    title: "Dependency setup failed",
    reason:
      firstLine(result.raw) ||
      `The setup command exited with status ${result.exitCode}.`,
    action: `Run "${command}" manually, fix the reported error, then retry /autoresearch.`,
    command,
    exitCode: result.exitCode,
    evidencePath,
    retryable: true,
    resumesFromCheckpoint: false,
  };
}

function baselineDiagnostic(
  result: ScoreResult,
  command: string,
  scorePath: string,
  evidencePath: string,
): InitializationDiagnosticV1 {
  const common = {
    step: "baseline" as const,
    command,
    exitCode: result.exitCode,
    evidencePath,
    retryable: true,
    resumesFromCheckpoint: true,
  };
  switch (result.failureKind) {
    case "command-not-found":
      return {
        ...common,
        code: "command-not-found",
        title: "Baseline command could not start",
        reason: `Benchmark command "${command}" was not found or could not start.`,
        action:
          "Install the required executable or fix benchmarkCommand in benchmark.json, then retry /autoresearch.",
      };
    case "timeout":
      return {
        ...common,
        code: "command-timeout",
        title: "Baseline measurement timed out",
        reason: "The benchmark exceeded benchmarkTimeoutMs.",
        action:
          "Inspect the benchmark log; if it was making useful progress, increase benchmarkTimeoutMs and retry.",
      };
    case "score-file-missing":
      return {
        ...common,
        code: "score-file-missing",
        title: "Benchmark produced no score artifact",
        reason: `The command exited successfully but did not write ${scorePath}.`,
        action:
          "Fix the benchmark output or scorePath in benchmark.json, then retry /autoresearch.",
      };
    case "score-json-invalid":
      return {
        ...common,
        code: "score-json-invalid",
        title: "Score artifact is not valid JSON",
        reason: `${scorePath} could not be parsed after the benchmark completed.`,
        action:
          "Fix the benchmark so it writes valid JSON containing a numeric score, then retry.",
      };
    case "score-value-invalid":
      return {
        ...common,
        code: "score-value-invalid",
        title: "Score artifact has no finite numeric score",
        reason: `${scorePath} must contain a finite numeric "score" field.`,
        action:
          "Fix the benchmark score output, then retry /autoresearch.",
      };
    default:
      return {
        ...common,
        code: "baseline-failed",
        title: "Baseline benchmark failed",
        reason:
          firstLine(result.raw) ||
          `The benchmark exited with status ${result.exitCode}.`,
        action:
          "Inspect the benchmark log and Setup trace, correct the reported problem, then retry.",
      };
  }
}

/** Add a pattern to .git/info/exclude (idempotent). No-op outside a git repo. */
export function excludeAutoresearchStateFromGit(repoRoot: string): void {
  const pattern = `${STATE_DIR_NAME}/`;
  const gitDir = path.join(repoRoot, ".git");
  if (!fs.existsSync(gitDir)) return;
  // .git can be a file in worktrees; only handle the plain-dir case.
  if (!fs.statSync(gitDir).isDirectory()) return;
  const excludeFile = path.join(gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  if (existing.split("\n").includes(pattern)) return;
  fs.writeFileSync(excludeFile, existing.endsWith("\n") || existing === "" ? `${existing}${pattern}\n` : `${existing}\n${pattern}\n`);
}
