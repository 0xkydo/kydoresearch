import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner } from "./agents/types.ts";
import { candidateRunPaths, snapshotEditableSource } from "./archive.ts";
import { YukonCliAdapter } from "./challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "./challenge/detect.ts";
import type { ScoreResult } from "./challenge/types.ts";
import type { HarnessConfig } from "./config.ts";
import { loadConfig, saveConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import { retryOperation, type RetryDelay } from "./retry.ts";
import type {
  SetupResultV1,
  SetupReviewTaskV1,
  SetupTaskV1,
} from "./experiments.ts";
import { EXPERIMENT_SCHEMA_VERSION, validateResearchTask } from "./experiments.ts";
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
  stage: "setup" | "setup-agent" | "baseline" | "baseline-review" | "ready";
  status: "running" | "retrying" | "succeeded" | "resuming";
  message: string;
  command?: string;
  attempt?: number;
  maxAttempts?: number;
  logPath?: string;
}

/**
 * First-run initialization inside a challenge repo:
 *  1. Read + validate benchmark.json; guard that .autoresearch/ is outside editablePaths.
 *  2. Scaffold .autoresearch/ and hide it via .git/info/exclude (local-only,
 *     never dirties submission tarballs).
 *  3. Run setupCommand (dependency install) and fail loudly if it fails.
 *  4. Run the setup agent ("init.explore") to classify the repository's
 *     existing commands, confirm readiness, and pause for outside work when
 *     needed.
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
  const manifest = readManifest(repoRoot);
  const gitCheck = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
  if (gitCheck.code !== 0 || gitCheck.stdout.trim() !== "true") {
    throw new Error(
      `Not a git repository: ${repoRoot}. ` +
        "Clone the challenge, cd into it, then retry /autoresearch.",
    );
  }

  if (isInsideEditablePaths(STATE_DIR_NAME, manifest.editablePaths)) {
    throw new Error(
      `.autoresearch/ would fall inside editablePaths (${manifest.editablePaths.join(", ")}); ` +
        "the harness state dir must not ship in submission tarballs. Aborting init.",
    );
  }

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
  excludeFromGit(repoRoot, `${STATE_DIR_NAME}/`);

  const config = loadConfig(stateDir);
  const cli = detectCli(repoRoot, manifest);
  const setupTaskDir = path.join(paths.loopsDir, "init");
  fs.mkdirSync(setupTaskDir, { recursive: true });
  const setupTaskPath = path.join(setupTaskDir, "setup-task.json");
  const setupResultPath = path.join(setupTaskDir, "setup-result.json");
  const revision = await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (revision.code !== 0 || revision.stdout.trim() === "") {
    throw new Error(`Unable to record baseline Git revision: ${revision.stderr.trim()}`);
  }
  const checkpointFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        manifest,
        revision: revision.stdout.trim(),
        setupRole: config.roles.setup,
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
  let reviewCount = 0;
  const persistedSetup = loadSetupResult(setupResultPath, checkpointFingerprint);

  if (persistedSetup) {
    verifyCommand = persistedSetup.verifyCommand;
    benchCommand = persistedSetup.benchCommand;
    subjectArea = persistedSetup.subjectArea;
    reviewCount = persistedSetup.reviewCount;
    emit(`init: resuming from durable Setup result (bench: ${benchCommand})`);
    opts.onProgress?.({
      stage: "baseline",
      status: "resuming",
      message: "resuming the saved baseline command",
      command: benchCommand,
      logPath: path.join(paths.logsDir, "benchmark.log"),
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
      throw new Error(
        `Dependency setup failed (exit ${setup.exitCode}):\n${setup.raw}\n\n` +
          `Run "${manifest.setupCommand}" manually, fix the reported error, then retry /autoresearch.`,
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
    if (!explore.ok) throw new Error(`Setup agent failed: ${explore.error ?? explore.output}`);

    const structured = explore.structured ?? {};
    if (structured.status === "needs-user-action") {
      throw new Error(formatSetupUserAction(structured.userAction));
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
    writeSetupResult(setupResultPath, {
      checkpointFingerprint,
      verifyCommand,
      benchCommand,
      subjectArea,
      knowledgeBasePath: paths.knowledgeBase,
      reviewCount,
      summary: explore.output,
    });
    opts.onProgress?.({
      stage: "setup-agent",
      status: "succeeded",
      message: "Setup agent selected effective local commands",
      command: benchCommand,
      logPath: path.join(paths.resolvedAgentsDir, "setup", "events.ndjson"),
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
    if (
      baseline.exitCode === 127 ||
      /(?:command not found|No such file or directory)/i.test(baseline.raw)
    ) {
      throw new Error(
        `Benchmark command "${benchCommand}" was not found or could not start.\n${baseline.raw}\n\n` +
          "Install the required executable or fix benchmarkCommand in benchmark.json, then retry /autoresearch.",
      );
    }
    throw new Error(`Baseline benchmark failed (exit ${baseline.exitCode}):\n${baseline.raw}`);
  }
  opts.onProgress?.({
    stage: "baseline",
    status: "succeeded",
    message: "local baseline completed",
    command: benchCommand,
    logPath: path.join(paths.logsDir, "benchmark.log"),
  });

  const state = newLoopState(challenge);
  state.bestScore = baseline.score;
  state.bestCandidateId = "baseline";
  const baselinePaths = candidateRunPaths(stateDir, "baseline");
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
  appendJournal(paths.journal, { phase: "ready", challenge: challenge.name, verifyCommand, benchCommand });
  emit(`init: ready (verify: ${verifyCommand} · bench: ${benchCommand})`);
  opts.onProgress?.({
    stage: "ready",
    status: "succeeded",
    message: "initialization complete",
    command: benchCommand,
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
      throw new Error(`Setup baseline review failed: ${review.error ?? review.output}`);
    }
    const structured = review.structured ?? {};
    if (structured.status === "needs-user-action") {
      throw new Error(formatSetupUserAction(structured.userAction));
    }
    if (structured.status !== "ready") {
      throw new Error(
        "Setup baseline review returned no readiness decision. " +
          "Inspect .autoresearch/resolved-agents/setup-review/events.ndjson, then retry /autoresearch.",
      );
    }

    verifyCommand = commandFromResult(structured.verifyCommand, verifyCommand);
    benchCommand = commandFromResult(structured.benchCommand, benchCommand);
    challenge.verifyCommand = verifyCommand;
    challenge.benchCommand = benchCommand;
    if (typeof structured.subjectArea === "string" && structured.subjectArea.trim()) {
      subjectArea = structured.subjectArea.trim();
      challenge.subjectArea = subjectArea;
    }
    reviewCount += 1;
    writeSetupResult(setupResultPath, {
      checkpointFingerprint,
      verifyCommand,
      benchCommand,
      subjectArea,
      knowledgeBasePath: paths.knowledgeBase,
      reviewCount,
      summary: review.output,
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
    });
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
}

function commandFromResult(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function writeSetupResult(
  resultPath: string,
  input: {
    checkpointFingerprint: string;
    verifyCommand: string;
    benchCommand: string;
    subjectArea?: string;
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

function formatSetupUserAction(value: unknown): string {
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
  const owner =
    typeof action.suggestedOwner === "string" && action.suggestedOwner.trim()
      ? `Suggested owner: ${action.suggestedOwner.trim()}`
      : undefined;
  const requiredAction =
    instructions.length > 0
      ? `Required action:\n${instructions.map((instruction) => `- ${instruction.trim()}`).join("\n")}`
      : "Required action: Resolve the missing setup outside this agent.";

  return [
    "Initialization paused: Setup needs user action before the harness can continue.",
    `Reason: ${reason}`,
    location,
    requiredAction,
    owner,
    "Complete the requested work, then retry /autoresearch.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Add a pattern to .git/info/exclude (idempotent). No-op outside a git repo. */
function excludeFromGit(repoRoot: string, pattern: string): void {
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
