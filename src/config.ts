import { atomicWriteJson, readJsonIfExists } from "./util.ts";
import { statePaths } from "./state.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RoleSpec {
  /** Model ref for the pi subprocess (v2), e.g. "anthropic/claude-opus-4-8". */
  model: string;
  thinking?: ThinkingLevel;
  /** Tool allowlist for the role's subprocess (v2). */
  tools?: string[];
  /**
   * Prompt MD file for the role. A bare filename ("professor.md") resolves
   * against the bundled extensions/autoresearch/prompts/; a repo-relative path
   * (".autoresearch/prompts/custom.md") against the challenge repo. Defaults
   * to "<role>.md" (bundled).
   */
  prompt?: string;
}

export interface RolesConfig {
  setup: RoleSpec;
  professor: RoleSpec;
  phd: RoleSpec;
  god: RoleSpec;
  advisor: RoleSpec;
}

export interface ExecutionConfig {
  /** Dependency/setup command deadline. */
  setupTimeoutMs: number;
  /** Per correctness-check deadline. */
  verifyTimeoutMs: number;
  /** Per performance benchmark deadline; real challenge benches may take minutes. */
  benchmarkTimeoutMs: number;
}

export interface HarnessConfig {
  version: 1;
  runner: "mock" | "subprocess";
  roles: RolesConfig;
  /** Consecutive dry loops before the professor talks to God. 0 disables. */
  godTriggerThreshold: number;
  maxVerifyAttempts: number;
  /** Cap on ideas the professor may propose per loop (professor decides actual count <= cap). */
  maxIdeasPerLoop: number;
  maxLoops: number | null;
  /** Relative epsilon for "meaningful improvement". */
  minImprovement: number;
  /** Demo-only pause after each completed mock loop. 0 disables. */
  mockLoopDelayMs: number;
  execution: ExecutionConfig;
  advisor: { enabled: boolean; watchdogFile: string };
  /** Model name passed to `submit --model` when the challenge requires it (mlxfast). */
  submitModelName?: string;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  version: 1,
  runner: "mock",
  roles: {
    setup: { model: "anthropic/claude-sonnet-5", thinking: "medium" },
    professor: { model: "anthropic/claude-fable-5", thinking: "high" },
    phd: { model: "anthropic/claude-sonnet-5", thinking: "medium" },
    god: { model: "anthropic/claude-fable-5", thinking: "high" },
    advisor: { model: "anthropic/claude-fable-5", thinking: "medium" },
  },
  godTriggerThreshold: 3,
  maxVerifyAttempts: 3,
  maxIdeasPerLoop: 5,
  maxLoops: null,
  minImprovement: 0.005,
  mockLoopDelayMs: 0,
  execution: {
    setupTimeoutMs: 30 * 60_000,
    verifyTimeoutMs: 10 * 60_000,
    benchmarkTimeoutMs: 60 * 60_000,
  },
  advisor: { enabled: true, watchdogFile: "WATCHDOG.md" },
};

export function loadConfig(stateDir: string): HarnessConfig {
  const onDisk = readJsonIfExists<Partial<HarnessConfig>>(statePaths(stateDir).config);
  if (!onDisk) return structuredClone(DEFAULT_CONFIG);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...onDisk,
    roles: { ...structuredClone(DEFAULT_CONFIG.roles), ...(onDisk.roles ?? {}) },
    execution: { ...structuredClone(DEFAULT_CONFIG.execution), ...(onDisk.execution ?? {}) },
    advisor: { ...structuredClone(DEFAULT_CONFIG.advisor), ...(onDisk.advisor ?? {}) },
    version: 1,
  };
}

export function saveConfig(stateDir: string, config: HarnessConfig): void {
  atomicWriteJson(statePaths(stateDir).config, config);
}
