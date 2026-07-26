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
   * Stable role-profile MD file. A bare filename ("professor.md") resolves
   * against bundled prompts/roles/; a repo-relative path
   * (".autoresearch/prompts/roles/custom.md") against the challenge repo.
   * Defaults to the bundled "roles/<role>.md". A separate task prompt is
   * composed at runtime from prompts/tasks/.
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

export interface ResilienceConfig {
  /** Total calls for one model task, including the first call. */
  agentMaxAttempts: number;
  /** Total calls for setup, verify, benchmark, sync, and worktree operations. */
  commandMaxAttempts: number;
  /** Submission gets a wider retry window because it is the final valuable step. */
  submitMaxAttempts: number;
  /** Consecutive failed loop resumptions before the overnight circuit breaker pauses. */
  maxConsecutiveLoopFailures: number;
  /** Exponential backoff for retries within one operation. */
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** Longer exponential backoff between failed resumptions of the same loop. */
  loopFailureBaseDelayMs: number;
  loopFailureMaxDelayMs: number;
}

export interface HarnessConfig {
  version: 1;
  runner: "mock" | "subprocess";
  roles: RolesConfig;
  /** Consecutive dry loops before the professor goes to church. 0 disables. */
  churchTriggerThreshold: number;
  maxVerifyAttempts: number;
  /** Cap on ideas the professor may propose per loop (professor decides actual count <= cap). */
  maxIdeasPerLoop: number;
  maxLoops: number | null;
  /** Relative epsilon for "meaningful improvement". */
  minImprovement: number;
  /** Demo-only pause after each completed mock loop. 0 disables. */
  mockLoopDelayMs: number;
  execution: ExecutionConfig;
  resilience: ResilienceConfig;
  advisor: { enabled: boolean; watchdogFile: string };
  /** Model name passed to `submit --model` when the challenge requires it (mlxfast). */
  submitModelName?: string;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  version: 1,
  runner: "mock",
  roles: {
    setup: {
      model: "anthropic/claude-sonnet-5",
      thinking: "medium",
      tools: ["read", "bash", "write", "grep", "find", "ls"],
    },
    professor: {
      model: "anthropic/claude-fable-5",
      thinking: "high",
      tools: ["read", "grep", "find", "ls"],
    },
    phd: {
      model: "anthropic/claude-sonnet-5",
      thinking: "medium",
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    },
    god: {
      model: "anthropic/claude-fable-5",
      thinking: "high",
      tools: ["read", "write", "grep", "find", "ls"],
    },
    advisor: {
      model: "anthropic/claude-fable-5",
      thinking: "medium",
      tools: [],
    },
  },
  churchTriggerThreshold: 3,
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
  resilience: {
    agentMaxAttempts: 3,
    commandMaxAttempts: 2,
    submitMaxAttempts: 5,
    maxConsecutiveLoopFailures: 12,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 60_000,
    loopFailureBaseDelayMs: 60_000,
    loopFailureMaxDelayMs: 15 * 60_000,
  },
  advisor: { enabled: true, watchdogFile: "WATCHDOG.md" },
};

export function loadConfig(stateDir: string): HarnessConfig {
  const onDisk = readJsonIfExists<
    Partial<HarnessConfig> & { godTriggerThreshold?: number }
  >(statePaths(stateDir).config);
  if (!onDisk) return structuredClone(DEFAULT_CONFIG);
  const { godTriggerThreshold: legacyGodTriggerThreshold, ...current } = onDisk;
  const defaultRoles = structuredClone(DEFAULT_CONFIG.roles);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...current,
    churchTriggerThreshold:
      current.churchTriggerThreshold ??
      legacyGodTriggerThreshold ??
      DEFAULT_CONFIG.churchTriggerThreshold,
    roles: {
      setup: { ...defaultRoles.setup, ...current.roles?.setup },
      professor: { ...defaultRoles.professor, ...current.roles?.professor },
      phd: { ...defaultRoles.phd, ...current.roles?.phd },
      god: { ...defaultRoles.god, ...current.roles?.god },
      advisor: { ...defaultRoles.advisor, ...current.roles?.advisor },
    },
    execution: { ...structuredClone(DEFAULT_CONFIG.execution), ...(current.execution ?? {}) },
    resilience: { ...structuredClone(DEFAULT_CONFIG.resilience), ...(current.resilience ?? {}) },
    advisor: { ...structuredClone(DEFAULT_CONFIG.advisor), ...(current.advisor ?? {}) },
    version: 1,
  };
}

export function saveConfig(stateDir: string, config: HarnessConfig): void {
  atomicWriteJson(statePaths(stateDir).config, config);
}
