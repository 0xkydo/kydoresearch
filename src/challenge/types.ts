import type { Direction } from "../util.ts";

/** Parsed benchmark.json (yukon contract). */
export interface BenchmarkManifest {
  name: string;
  description?: string;
  setupCommand: string;
  benchmarkCommand: string;
  scorePath: string;
  direction: Direction;
  editablePaths: string[];
  preSubmitCommand?: string;
}

export interface ScoreResult {
  ok: boolean;
  score?: number;
  raw: string; // combined stdout/stderr tail for diagnostics
  exitCode: number;
  timedOut?: boolean;
  failureKind?:
    | "command-not-found"
    | "timeout"
    | "command-exit"
    | "score-file-missing"
    | "score-json-invalid"
    | "score-value-invalid";
}

export interface SubmitResult {
  ok: boolean;
  submissionId?: string;
  promoted?: boolean;
  raw: string;
}

export interface LeaderboardEntry {
  id: string;
  score: number;
  author: string;
  promoted: boolean;
  createdAt?: string;
}

export interface ChallengeAdapter {
  readonly manifest: BenchmarkManifest;
  /** Install dependencies (setupCommand). */
  setup(signal?: AbortSignal): Promise<ScoreResult>;
  /** Correctness check. cwd overrides the repo root (idea worktrees). */
  verify(cwd?: string, signal?: AbortSignal, logFile?: string): Promise<ScoreResult>;
  /** Performance benchmark; parses scorePath. cwd overrides the repo root. */
  bench(cwd?: string, signal?: AbortSignal, logFile?: string): Promise<ScoreResult>;
  /** Submit editablePaths via the challenge CLI. Always runs at repo root. */
  submit(opts: { noteFile: string; model?: string }, signal?: AbortSignal): Promise<SubmitResult>;
  listSubmissions(all: boolean, signal?: AbortSignal): Promise<LeaderboardEntry[]>;
  sync(signal?: AbortSignal): Promise<{ ok: boolean; raw: string }>;
}
