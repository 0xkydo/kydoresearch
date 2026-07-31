import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutionConfig } from "../config.ts";
import type { ExecPort, ExecResult } from "../exec.ts";
import { shellExec } from "../exec.ts";
import type {
  BenchmarkManifest,
  ChallengeAdapter,
  LeaderboardEntry,
  RemoteSubmissionStatus,
  ScoreResult,
  SubmitResult,
} from "./types.ts";

const RAW_TAIL = 4000;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

function tail(result: ExecResult): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length > RAW_TAIL ? combined.slice(-RAW_TAIL) : combined;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function remoteSubmissionStatus(raw: string): RemoteSubmissionStatus {
  const status = raw.trim().toLowerCase();
  if (
    status === "rejected" ||
    status === "failed"
  ) {
    return "rejected";
  }
  if (
    status === "promoted" ||
    status === "not promoted" ||
    status === "promotion failed" ||
    status === "superseded" ||
    status === "accepted"
  ) {
    return "accepted";
  }
  return "pending";
}

export interface YukonCliAdapterOptions {
  repoRoot: string;
  manifest: BenchmarkManifest;
  /** CLI command, e.g. "ecdsafail", "mlxfast", "./bin/mockchal". Null disables submit/sync/leaderboard. */
  cli: string | null;
  /** Correctness command; defaults to benchmarkCommand (ecdsafail-style). */
  verifyCommand?: string;
  /** Perf command; defaults to benchmarkCommand. */
  benchCommand?: string;
  /** Per-phase command deadlines from the persisted harness config. */
  execution?: ExecutionConfig;
  /** Append-only command logs. Omit to disable file logging. */
  logDir?: string;
  exec: ExecPort;
}

/**
 * The one real adapter. Shells out to manifest commands and the challenge CLI.
 * Works identically against mockchal (fixture) and ecdsafail/mlxfast (real).
 */
export class YukonCliAdapter implements ChallengeAdapter {
  readonly manifest: BenchmarkManifest;
  private readonly repoRoot: string;
  private readonly cli: string | null;
  private readonly verifyCommand: string;
  private readonly benchCommand: string;
  private readonly execution: ExecutionConfig | undefined;
  private readonly logDir: string | undefined;
  private readonly sh: ReturnType<typeof shellExec>;

  constructor(opts: YukonCliAdapterOptions) {
    this.manifest = opts.manifest;
    this.repoRoot = opts.repoRoot;
    this.cli = opts.cli;
    this.verifyCommand = opts.verifyCommand ?? opts.manifest.benchmarkCommand;
    this.benchCommand = opts.benchCommand ?? opts.manifest.benchmarkCommand;
    this.execution = opts.execution;
    this.logDir = opts.logDir;
    this.sh = shellExec(opts.exec);
  }

  async setup(signal?: AbortSignal): Promise<ScoreResult> {
    const result = await this.runCommand(
      "setup",
      this.manifest.setupCommand,
      this.repoRoot,
      this.execution?.setupTimeoutMs,
      signal,
    );
    return {
      ok: result.code === 0,
      raw: tail(result),
      exitCode: result.code,
      timedOut: result.timedOut,
      ...(result.code === 0
        ? {}
        : {
            failureKind: result.timedOut
              ? ("timeout" as const)
              : result.code === 127
                ? ("command-not-found" as const)
                : ("command-exit" as const),
          }),
    };
  }

  async verify(cwd?: string, signal?: AbortSignal, logFile?: string): Promise<ScoreResult> {
    const result = await this.runCommand(
      "verify",
      this.verifyCommand,
      cwd ?? this.repoRoot,
      this.execution?.verifyTimeoutMs,
      signal,
      logFile,
    );
    return {
      ok: result.code === 0,
      raw: tail(result),
      exitCode: result.code,
      timedOut: result.timedOut,
      ...(result.code === 0
        ? {}
        : {
            failureKind: result.timedOut
              ? ("timeout" as const)
              : result.code === 127
                ? ("command-not-found" as const)
                : ("command-exit" as const),
          }),
    };
  }

  async bench(cwd?: string, signal?: AbortSignal, logFile?: string): Promise<ScoreResult> {
    const dir = cwd ?? this.repoRoot;
    const scoreFile = path.join(dir, this.manifest.scorePath);
    if (fs.existsSync(scoreFile)) fs.rmSync(scoreFile); // stale score guard
    const result = await this.runCommand(
      "benchmark",
      this.benchCommand,
      dir,
      this.execution?.benchmarkTimeoutMs,
      signal,
      logFile,
    );
    if (result.code !== 0) {
      return {
        ok: false,
        raw: tail(result),
        exitCode: result.code,
        timedOut: result.timedOut,
        failureKind: result.timedOut
          ? "timeout"
          : result.code === 127
            ? "command-not-found"
            : "command-exit",
      };
    }
    if (!fs.existsSync(scoreFile)) {
      return {
        ok: false,
        raw: `${tail(result)}\n[bench succeeded but ${this.manifest.scorePath} was not written]`,
        exitCode: result.code,
        failureKind: "score-file-missing",
      };
    }
    let parsed: { score?: unknown };
    try {
      parsed = JSON.parse(fs.readFileSync(scoreFile, "utf8")) as { score?: unknown };
    } catch (error) {
      return {
        ok: false,
        raw: `${tail(result)}\n[invalid JSON in ${this.manifest.scorePath}: ${
          error instanceof Error ? error.message : String(error)
        }]`,
        exitCode: 1,
        failureKind: "score-json-invalid",
      };
    }
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
      return {
        ok: false,
        raw: `${tail(result)}\n[invalid score in ${this.manifest.scorePath}]`,
        exitCode: 1,
        failureKind: "score-value-invalid",
      };
    }
    return { ok: true, score: parsed.score, raw: tail(result), exitCode: 0 };
  }

  private async runCommand(
    phase: "setup" | "verify" | "benchmark",
    command: string,
    cwd: string,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    logFileOverride?: string,
  ): Promise<ExecResult> {
    const logFile = logFileOverride ?? (this.logDir ? path.join(this.logDir, `${phase}.log`) : undefined);
    const startedAt = new Date();
    if (logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(
        logFile,
        `\n[${startedAt.toISOString()}] start · cwd=${cwd} · timeout=${timeout ?? "default"}ms\n$ ${command}\n`,
      );
    }
    const result = await this.sh(command, {
      cwd,
      signal,
      timeout,
      onOutput: logFile ? (chunk) => fs.appendFileSync(logFile, chunk) : undefined,
    });
    if (logFile) {
      fs.appendFileSync(
        logFile,
        `\n[${new Date().toISOString()}] end · exit=${result.code} · duration=${Date.now() - startedAt.getTime()}ms\n`,
      );
    }
    return result;
  }

  async submit(opts: { noteFile: string; model?: string }, signal?: AbortSignal): Promise<SubmitResult> {
    if (!this.cli) return { ok: false, raw: "No challenge CLI detected; submit disabled." };
    const args = ["submit", "--note-file", opts.noteFile];
    if (opts.model) args.push("--model", opts.model);
    const result = await this.sh(`${this.cli} ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
      cwd: this.repoRoot,
      signal,
    });
    const raw = tail(result);
    const idMatch = raw.match(/\b(sub-[a-z0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/i);
    const plain = stripAnsi(raw);
    const statusMatch = /^status\s+(.+?)\s*$/im.exec(plain);
    const rawStatus = statusMatch?.[1]?.trim();
    const promoted = /\bpromoted\b/i.test(plain) && !/\bnot promoted\b/i.test(plain);
    return {
      ok: result.code === 0,
      submissionId: idMatch?.[1],
      ...(result.code === 0
        ? {
            status: rawStatus
              ? remoteSubmissionStatus(rawStatus)
              : ("accepted" as const),
          }
        : {}),
      promoted,
      raw,
    };
  }

  async listSubmissions(all: boolean, signal?: AbortSignal): Promise<LeaderboardEntry[]> {
    if (!this.cli) return [];
    const result = await this.sh(`${this.cli} submissions${all ? " --all" : ""}`, {
      cwd: this.repoRoot,
      signal,
    });
    if (result.code !== 0) {
      throw new Error(`Challenge submissions command failed (exit ${result.code}): ${tail(result)}`);
    }
    return parseSubmissionTable(result.stdout);
  }

  async sync(signal?: AbortSignal): Promise<{ ok: boolean; raw: string }> {
    if (!this.cli) return { ok: true, raw: "No challenge CLI detected; sync skipped." };
    const result = await this.sh(`${this.cli} sync`, { cwd: this.repoRoot, signal });
    return { ok: result.code === 0, raw: tail(result) };
  }
}

/** Parse both legacy Yukon TSV output and the current mlxfast status table. */
export function parseSubmissionTable(stdout: string): LeaderboardEntry[] {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const legacyHeader = lines.findIndex((line) => /^ID\tSCORE\tAUTHOR\tPROMOTED(?:\t|$)/i.test(line));
  if (legacyHeader >= 0) {
    return lines
      .slice(legacyHeader + 1)
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 4 && Number.isFinite(Number(cols[1])))
      .map((cols) => ({
        id: cols[0] ?? "",
        score: Number(cols[1]),
        author: cols[2] ?? "",
        status: "accepted",
        rawStatus: (cols[3] ?? "").toLowerCase().startsWith("y")
          ? "promoted"
          : "not promoted",
        promoted: (cols[3] ?? "").toLowerCase().startsWith("y"),
        createdAt: cols[4],
      }));
  }

  const headerIndex = lines.findIndex((line) => {
    const headers = line.trim().split(/\s{2,}/).map((column) => column.toLowerCase());
    return headers.includes("submission") && headers.includes("solver") && headers.includes("status");
  });
  if (headerIndex < 0) return [];
  const headers = lines[headerIndex]!.trim().split(/\s{2,}/).map((column) => column.toLowerCase());
  const index = (name: string) => headers.indexOf(name);
  const submissionIndex = index("submission");
  const solverIndex = index("solver");
  const statusIndex = index("status");
  const scoreIndex = index("score");
  const metricsIndex = index("metrics");
  const createdIndex = index("created");

  return lines
    .slice(headerIndex + 1)
    .filter((line) => !/^[\s\-─]+$/.test(line))
    .map((line) => line.trim().split(/\s{2,}/))
    .filter((columns) =>
      submissionIndex >= 0 &&
      solverIndex >= 0 &&
      statusIndex >= 0 &&
      columns.length > Math.max(submissionIndex, solverIndex, statusIndex)
    )
    .map((columns) => {
      const rawStatus = columns[statusIndex]?.trim() ?? "unknown";
      const rawScore = scoreIndex >= 0 ? columns[scoreIndex]?.trim() : undefined;
      const score = rawScore === undefined || rawScore.toLowerCase() === "n/a"
        ? null
        : Number(rawScore);
      const rawMetrics = metricsIndex >= 0 ? columns[metricsIndex]?.trim() : undefined;
      return {
        id: columns[submissionIndex]?.trim() ?? "",
        score: score !== null && Number.isFinite(score) ? score : null,
        author: columns[solverIndex]?.trim() ?? "",
        status: remoteSubmissionStatus(rawStatus),
        rawStatus,
        metrics: rawMetrics && rawMetrics.toLowerCase() !== "n/a" ? rawMetrics : undefined,
        promoted: rawStatus.toLowerCase() === "promoted",
        createdAt: createdIndex >= 0 ? columns.slice(createdIndex).join("  ").trim() : undefined,
      };
    })
    .filter((entry) => entry.id !== "");
}
