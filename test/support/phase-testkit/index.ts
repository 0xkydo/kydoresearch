import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner, AgentTask } from "../../../src/agents/types.ts";
import { MockAgentRunner } from "../../../src/agents/mock.ts";
import { YukonCliAdapter } from "../../../src/challenge/adapter.ts";
import type { ChallengeAdapter } from "../../../src/challenge/types.ts";
import type { HarnessConfig } from "../../../src/config.ts";
import type { ExecPort, ExecResult } from "../../../src/exec.ts";
import { nodeExec } from "../../../src/exec.ts";
import { initChallenge } from "../../../src/init.ts";
import type {
  OrchestratorEvent,
  OrchestratorPorts,
} from "../../../src/orchestrator.ts";
import { Orchestrator } from "../../../src/orchestrator.ts";
import type { Phase } from "../../../src/phases.ts";
import { loadState, statePaths } from "../../../src/state.ts";
import { detectCli, readManifest } from "../../../src/challenge/detect.ts";
import { makeTmpChallenge } from "../../helpers/tmp-challenge.ts";

export interface RecordedCommand {
  command: string;
  args: string[];
  cwd?: string;
  result: ExecResult;
}

export interface PhaseEffects {
  runnerCalls: AgentTask[];
  commands: RecordedCommand[];
  events: OrchestratorEvent[];
  delays: number[];
}

export interface PhaseHarness {
  repoRoot: string;
  stateDir: string;
  config: HarnessConfig;
  effects: PhaseEffects;
  runner: AgentRunner;
  adapter: ChallengeAdapter;
  exec: ExecPort;
  makeOrchestrator(options?: {
    signal?: AbortSignal;
    stopBeforePhase?: Phase;
    runner?: AgentRunner;
    adapter?: ChallengeAdapter;
  }): Orchestrator;
  resetEffects(): void;
  stateFiles(): string[];
  cleanup(): void;
}

export async function createPhaseHarness(options: {
  runner?: AgentRunner;
  config?: Partial<HarnessConfig>;
} = {}): Promise<PhaseHarness> {
  const temporary = makeTmpChallenge();
  const effects: PhaseEffects = {
    runnerCalls: [],
    commands: [],
    events: [],
    delays: [],
  };
  const baseRunner = options.runner ?? new MockAgentRunner();
  const runner = recordingRunner(baseRunner, effects);
  const exec = recordingExec(nodeExec, effects);
  try {
    const initialized = await initChallenge({
      repoRoot: temporary.repoRoot,
      runner,
      exec,
      delay: async (ms) => {
        effects.delays.push(ms);
      },
    });
    Object.assign(initialized.config, options.config);
    const manifest = readManifest(temporary.repoRoot);
    const adapter = new YukonCliAdapter({
      repoRoot: temporary.repoRoot,
      manifest,
      cli: detectCli(temporary.repoRoot, manifest),
      verifyCommand: initialized.state.challenge.verifyCommand,
      benchCommand: initialized.state.challenge.benchCommand,
      exec,
    });
    return {
      repoRoot: temporary.repoRoot,
      stateDir: initialized.stateDir,
      config: initialized.config,
      effects,
      runner,
      adapter,
      exec,
      makeOrchestrator(orchestratorOptions = {}) {
        const controller = orchestratorOptions.stopBeforePhase
          ? new AbortController()
          : undefined;
        const signal = orchestratorOptions.signal ?? controller?.signal;
        const emit = (event: OrchestratorEvent): void => {
          effects.events.push(event);
          if (
            event.type === "phase" &&
            event.phase === orchestratorOptions.stopBeforePhase
          ) {
            controller?.abort();
          }
        };
        const ports: OrchestratorPorts = {
          runner: orchestratorOptions.runner
            ? recordingRunner(orchestratorOptions.runner, effects)
            : runner,
          adapter: orchestratorOptions.adapter ?? adapter,
          exec,
          emit,
          signal,
          delay: async (ms) => {
            effects.delays.push(ms);
          },
        };
        return new Orchestrator(
          temporary.repoRoot,
          initialized.stateDir,
          initialized.config,
          ports,
        );
      },
      resetEffects() {
        effects.runnerCalls.length = 0;
        effects.commands.length = 0;
        effects.events.length = 0;
        effects.delays.length = 0;
      },
      stateFiles() {
        return listFiles(initialized.stateDir).map((file) =>
          path.relative(initialized.stateDir, file).replaceAll("\\", "/")
        );
      },
      cleanup: temporary.cleanup,
    };
  } catch (error) {
    temporary.cleanup();
    throw error;
  }
}

export function recordingRunner(base: AgentRunner, effects: PhaseEffects): AgentRunner {
  return {
    run(task) {
      effects.runnerCalls.push(structuredCloneTask(task));
      return base.run(task);
    },
  };
}

export function abortAfterAgentCall(
  base: AgentRunner,
  effects: PhaseEffects,
  controller: AbortController,
  kind: AgentTask["kind"],
): AgentRunner {
  return {
    async run(task) {
      effects.runnerCalls.push(structuredCloneTask(task));
      const result = await base.run(task);
      if (task.kind === kind) controller.abort();
      return result;
    },
  };
}

export function loadFrozenFixture<T>(
  fixtureRoot: string,
  relativePath: string,
): Readonly<T> {
  if (path.isAbsolute(relativePath)) {
    throw new Error("Fixture path must be relative to the declared fixture root");
  }
  const root = path.resolve(fixtureRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Fixture path escapes the test root: ${relativePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as T;
  return deepFreeze(parsed);
}

export function readJournalPhases(stateDir: string): string[] {
  const journal = statePaths(stateDir).journal;
  if (!fs.existsSync(journal)) return [];
  return fs.readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as { phase?: string };
      return entry.phase ?? "";
    })
    .filter(Boolean);
}

export function assertDurableStateReadable(stateDir: string): void {
  if (!loadState(stateDir)) throw new Error(`Expected readable state at ${stateDir}`);
}

function recordingExec(base: ExecPort, effects: PhaseEffects): ExecPort {
  return async (command, args, options) => {
    const result = await base(command, args, options);
    effects.commands.push({
      command,
      args: [...args],
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      result,
    });
    return result;
  };
}

function structuredCloneTask(task: AgentTask): AgentTask {
  return {
    ...task,
    input: structuredClone(task.input),
  };
}

function listFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(resolved));
    else if (entry.isFile()) result.push(resolved);
  }
  return result.sort();
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
