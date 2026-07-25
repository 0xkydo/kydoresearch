import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutionConfig } from "../config.ts";
import type { ExecPort, ExecResult } from "../exec.ts";
import { shellExec } from "../exec.ts";
import type {
  BenchmarkManifest,
  ChallengeAdapter,
  LeaderboardEntry,
  ScoreResult,
  SubmitResult,
} from "./types.ts";

const RAW_TAIL = 4000;

function tail(result: ExecResult): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length > RAW_TAIL ? combined.slice(-RAW_TAIL) : combined;
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
    return { ok: result.code === 0, raw: tail(result), exitCode: result.code };
  }

  async verify(cwd?: string, signal?: AbortSignal): Promise<ScoreResult> {
    const result = await this.runCommand(
      "verify",
      this.verifyCommand,
      cwd ?? this.repoRoot,
      this.execution?.verifyTimeoutMs,
      signal,
    );
    return { ok: result.code === 0, raw: tail(result), exitCode: result.code };
  }

  async bench(cwd?: string, signal?: AbortSignal): Promise<ScoreResult> {
    const dir = cwd ?? this.repoRoot;
    const scoreFile = path.join(dir, this.manifest.scorePath);
    if (fs.existsSync(scoreFile)) fs.rmSync(scoreFile); // stale score guard
    const result = await this.runCommand(
      "benchmark",
      this.benchCommand,
      dir,
      this.execution?.benchmarkTimeoutMs,
      signal,
    );
    if (result.code !== 0) return { ok: false, raw: tail(result), exitCode: result.code };
    if (!fs.existsSync(scoreFile)) {
      return {
        ok: false,
        raw: `${tail(result)}\n[bench succeeded but ${this.manifest.scorePath} was not written]`,
        exitCode: result.code,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(scoreFile, "utf8")) as { score?: unknown };
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
      return { ok: false, raw: `${tail(result)}\n[invalid score in ${this.manifest.scorePath}]`, exitCode: 1 };
    }
    return { ok: true, score: parsed.score, raw: tail(result), exitCode: 0 };
  }

  private async runCommand(
    phase: "setup" | "verify" | "benchmark",
    command: string,
    cwd: string,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExecResult> {
    const logFile = this.logDir ? path.join(this.logDir, `${phase}.log`) : undefined;
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
    return {
      ok: result.code === 0,
      submissionId: idMatch?.[1],
      promoted: /promoted/i.test(raw) && !/not promoted/i.test(raw),
      raw,
    };
  }

  async listSubmissions(all: boolean, signal?: AbortSignal): Promise<LeaderboardEntry[]> {
    if (!this.cli) return [];
    const result = await this.sh(`${this.cli} submissions${all ? " --all" : ""}`, {
      cwd: this.repoRoot,
      signal,
    });
    if (result.code !== 0) return [];
    // Tab-separated table: ID SCORE AUTHOR PROMOTED CREATED (header row skipped).
    return result.stdout
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 4 && Number.isFinite(Number(cols[1])))
      .map((cols) => ({
        id: cols[0] ?? "",
        score: Number(cols[1]),
        author: cols[2] ?? "",
        promoted: (cols[3] ?? "").toLowerCase().startsWith("y"),
        createdAt: cols[4],
      }));
  }

  async sync(signal?: AbortSignal): Promise<{ ok: boolean; raw: string }> {
    if (!this.cli) return { ok: true, raw: "No challenge CLI detected; sync skipped." };
    const result = await this.sh(`${this.cli} sync`, { cwd: this.repoRoot, signal });
    return { ok: result.code === 0, raw: tail(result) };
  }
}
