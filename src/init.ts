import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner } from "./agents/types.ts";
import { YukonCliAdapter } from "./challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "./challenge/detect.ts";
import type { HarnessConfig } from "./config.ts";
import { loadConfig, saveConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import { retryOperation, type RetryDelay } from "./retry.ts";
import type { ChallengeInfo, LoopState } from "./state.ts";
import { newLoopState, saveState, STATE_DIR_NAME, statePaths } from "./state.ts";
import { appendJournal } from "./util.ts";

export interface InitResult {
  state: LoopState;
  config: HarnessConfig;
  stateDir: string;
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
 *  5. Persist config.json + state.json at phase "ready".
 */
export async function initChallenge(opts: {
  repoRoot: string;
  runner: AgentRunner;
  exec: ExecPort;
  signal?: AbortSignal;
  emit?: (msg: string) => void;
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
  fs.mkdirSync(paths.ideasDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.notesDir, { recursive: true });
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  excludeFromGit(repoRoot, `${STATE_DIR_NAME}/`);

  const config = loadConfig(stateDir);
  const cli = detectCli(repoRoot, manifest);

  // Phase init.setup — dependency install before anything else.
  emit(`init: running setup (${manifest.setupCommand})`);
  appendJournal(paths.journal, { phase: "init.setup", setupCommand: manifest.setupCommand });
  const bootstrapAdapter = new YukonCliAdapter({
    repoRoot,
    manifest,
    cli,
    execution: config.execution,
    logDir: paths.logsDir,
    exec,
  });
  const retryPolicy = {
    maxAttempts: config.resilience.commandMaxAttempts,
    baseDelayMs: config.resilience.retryBaseDelayMs,
    maxDelayMs: config.resilience.retryMaxDelayMs,
    signal: opts.signal,
    delay: opts.delay,
  };
  const setup = await retryOperation({
    ...retryPolicy,
    operation: () => bootstrapAdapter.setup(opts.signal),
    isSuccess: (result) => result.ok,
    onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) =>
      emit(
        `init: setup failed (attempt ${attempt}/${maxAttempts}); retrying in ${nextDelayMs}ms` +
          (value?.raw ? ` · ${firstLine(value.raw)}` : ""),
      ),
  });
  if (!setup.ok) {
    throw new Error(
      `Dependency setup failed (exit ${setup.exitCode}):\n${setup.raw}\n\n` +
        `Run "${manifest.setupCommand}" manually, fix the reported error, then retry /autoresearch.`,
    );
  }

  // Phase init.knowledge — Setup classifies the repo's existing harness inputs,
  // confirms readiness, and writes the knowledge base.
  emit("init: classifying repo and confirming readiness");
  appendJournal(paths.journal, { phase: "init.knowledge" });
  const explore = await retryOperation({
    ...retryPolicy,
    maxAttempts: config.resilience.agentMaxAttempts,
    operation: () =>
      runner.run({
        role: "setup",
        kind: "init.explore",
        cwd: repoRoot,
        stateDir,
        input: { manifest, setupCommand: manifest.setupCommand },
        signal: opts.signal,
      }),
    isSuccess: (result) => result.ok,
    onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) =>
      emit(
        `init: setup agent failed (attempt ${attempt}/${maxAttempts}); retrying in ${nextDelayMs}ms` +
          (value ? ` · ${firstLine(value.error ?? value.output)}` : ""),
      ),
  });
  if (!explore.ok) throw new Error(`Setup agent failed: ${explore.error ?? explore.output}`);

  const structured = explore.structured ?? {};
  if (structured.status === "needs-user-action") {
    throw new Error(formatSetupUserAction(structured.userAction));
  }
  const verifyCommand =
    typeof structured.verifyCommand === "string"
      ? structured.verifyCommand
      : manifest.preSubmitCommand ?? manifest.benchmarkCommand;
  const benchCommand =
    typeof structured.benchCommand === "string" ? structured.benchCommand : manifest.benchmarkCommand;

  const challenge: ChallengeInfo = {
    name: manifest.name,
    cli: cli ?? "",
    direction: manifest.direction,
    setupCommand: manifest.setupCommand,
    verifyCommand,
    benchCommand,
    preSubmitCommand: manifest.preSubmitCommand,
    submitNeedsModel: manifest.name.toLowerCase().includes("mlxfast"),
    editablePaths: manifest.editablePaths,
    scorePath: manifest.scorePath,
    subjectArea: typeof structured.subjectArea === "string" ? structured.subjectArea : undefined,
  };

  // Establish the baseline score (real yukon CLIs run the benchmark once on
  // clone). Without a baseline, the first valid idea would always "improve".
  emit(`init: measuring baseline (${benchCommand})`);
  const baselineAdapter = new YukonCliAdapter({
    repoRoot,
    manifest,
    cli,
    verifyCommand,
    benchCommand,
    execution: config.execution,
    logDir: paths.logsDir,
    exec,
  });
  const baseline = await retryOperation({
    ...retryPolicy,
    operation: () => baselineAdapter.bench(undefined, opts.signal),
    isSuccess: (result) => result.ok && result.score !== undefined,
    onRetry: ({ attempt, maxAttempts, nextDelayMs, value }) =>
      emit(
        `init: baseline failed (attempt ${attempt}/${maxAttempts}); retrying in ${nextDelayMs}ms` +
          (value?.raw ? ` · ${firstLine(value.raw)}` : ""),
      ),
  });
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

  const state = newLoopState(challenge);
  state.bestScore = baseline.score;
  state.phase = "ready";
  saveState(stateDir, state);
  saveConfig(stateDir, config);
  appendJournal(paths.journal, { phase: "ready", challenge: challenge.name, verifyCommand, benchCommand });
  emit(`init: ready (verify: ${verifyCommand} · bench: ${benchCommand})`);

  return { state, config, stateDir };
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
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
