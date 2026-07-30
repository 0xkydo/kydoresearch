export type IncidentCategory =
  | "process-crash"
  | "recovery-circuit-open"
  | "progress-stalled"
  | "provider-outage"
  | "runtime-corruption"
  | "infrastructure-failure"
  | "none";

export type IncidentConfidence = "low" | "medium" | "high";

export interface OncallAssessment {
  catastrophic: boolean;
  category: IncidentCategory;
  confidence: IncidentConfidence;
  problem: string;
  why: string;
  errorLogs: string[];
  possibleRootCauses: string[];
  repairable: boolean;
  repairScope: string[];
  restartRecommended: boolean;
}

export interface SupervisorOptions {
  repoRoot: string;
  runtimeRoot: string;
  extensionPath: string;
  stateDir: string;
  piBin: string;
  codexBin: string;
  piArgs: string[];
  oncallModel: string;
  oncallThinking: string;
  scanIntervalMs: number;
  stalledAfterMs: number;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  maxRestarts: number;
  repairEnabled: boolean;
  explicitExtension: boolean;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StreamBatch {
  text: string;
  changed: boolean;
  state: Record<string, unknown> | null;
  lastProgressAt: number;
}

export interface DeterministicIncident {
  category: Exclude<IncidentCategory, "none">;
  problem: string;
  why: string;
  evidence: string[];
}

export interface RepairResult {
  status: "fixed" | "no-code-fix" | "blocked" | "failed" | "unknown";
  summary: string;
  filesChanged: string[];
  validation: string[];
  remainingRisk: string;
}
