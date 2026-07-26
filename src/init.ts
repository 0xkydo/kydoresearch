import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner } from "./agents/types.ts";
import { candidateRunPaths, snapshotEditableSource } from "./archive.ts";
import { YukonCliAdapter } from "./challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "./challenge/detect.ts";
import type { HarnessConfig } from "./config.ts";
import { loadConfig, saveConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import type { SetupTaskV1 } from "./experiments.ts";
import { EXPERIMENT_SCHEMA_VERSION, validateResearchTask } from "./experiments.ts";
import type { ChallengeInfo, LoopState } from "./state.ts";
import { newLoopState, saveState, STATE_DIR_NAME, statePaths } from "./state.ts";
import { appendJournal, atomicWriteJson } from "./util.ts";

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
 *  4. Run the setup agent ("init.explore") to build the knowledge base and
 *     detect the verify vs perf commands (sometimes the same, sometimes not).
 *  5. Persist config.json + state.json at phase "ready".
 */
export async function initChallenge(opts: {
  repoRoot: string;
  runner: AgentRunner;
  exec: ExecPort;
  signal?: AbortSignal;
  emit?: (msg: string) => void;
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
  fs.mkdirSync(paths.loopsDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.resolvedAgentsDir, { recursive: true });
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
  const setup = await bootstrapAdapter.setup(opts.signal);
  if (!setup.ok) {
    throw new Error(
      `Dependency setup failed (exit ${setup.exitCode}):\n${setup.raw}\n\n` +
        `Run "${manifest.setupCommand}" manually, fix the reported error, then retry /autoresearch.`,
    );
  }

  // Phase init.knowledge — setup agent reads the repo, builds the knowledge
  // base, and reports the verification scheme.
  emit("init: exploring repo and building knowledge base");
  appendJournal(paths.journal, { phase: "init.knowledge" });
  const setupTaskDir = path.join(paths.loopsDir, "init");
  fs.mkdirSync(setupTaskDir, { recursive: true });
  const setupTaskPath = path.join(setupTaskDir, "setup-task.json");
  const setupTask: SetupTaskV1 = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    taskId: "init-setup",
    kind: "init.explore",
    role: "setup",
    taskPath: setupTaskPath,
    stateDir,
    resultPath: path.join(setupTaskDir, "setup-result.json"),
    input: {
      repoRoot,
      manifestPath: path.join(repoRoot, "benchmark.json"),
      knowledgeBasePath: paths.knowledgeBase,
    },
  };
  validateResearchTask(setupTask);
  atomicWriteJson(setupTaskPath, setupTask);
  const explore = await runner.run({
    role: "setup",
    kind: "init.explore",
    cwd: repoRoot,
    stateDir,
    input: {
      ...setupTask.input,
      manifest,
      setupCommand: manifest.setupCommand,
      taskPath: setupTaskPath,
      traceDir: path.join(paths.resolvedAgentsDir, "setup"),
    },
    signal: opts.signal,
  });
  if (!explore.ok) throw new Error(`Setup agent failed: ${explore.error ?? explore.output}`);

  const structured = explore.structured ?? {};
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
  const baseline = await baselineAdapter.bench(undefined, opts.signal);
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
  state.bestCandidateId = "baseline";
  const baselinePaths = candidateRunPaths(stateDir, "baseline");
  snapshotEditableSource(repoRoot, baselinePaths.source, challenge.editablePaths);
  const revision = await exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (revision.code !== 0 || revision.stdout.trim() === "") {
    throw new Error(`Unable to record baseline Git revision: ${revision.stderr.trim()}`);
  }
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

  return { state, config, stateDir };
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
