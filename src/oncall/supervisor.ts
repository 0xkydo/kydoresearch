import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assessmentPrompt, repairPrompt } from "./prompt.ts";
import type {
  DeterministicIncident,
  OncallAssessment,
  ProcessExit,
  RepairResult,
  StreamBatch,
  SupervisorOptions,
} from "./types.ts";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
const DEFAULT_THINKING = "high";
const MAX_STREAM_WINDOW_BYTES = 96 * 1024;
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;
const MAX_AGENT_OUTPUT_BYTES = 2 * 1024 * 1024;
const ANALYST_TIMEOUT_MS = 10 * 60_000;
const REPAIR_TIMEOUT_MS = 60 * 60_000;
const STABLE_RUN_MS = 30 * 60_000;
const ACTIVE_PHASE_PREFIXES = ["init.", "loop."];
const TERMINAL_PHASES = new Set(["done", "ready"]);

interface ParsedCli {
  options: SupervisorOptions;
  help: boolean;
}

interface TailCursor {
  offset: number;
  identity: string;
}

interface RunningProcess {
  exit: Promise<ProcessExit>;
  terminate: () => Promise<void>;
}

interface IncidentFiles {
  directory: string;
  reportJson: string;
  reportMarkdown: string;
  evidence: string;
  codexTrace: string;
  codexResult: string;
}

export function parseSupervisorArgs(
  argv: string[],
  cwd = process.cwd(),
  runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
): ParsedCli {
  const forwarded: string[] = [];
  let piBin = process.env.KYDO_PI_BIN?.trim() || "pi";
  let codexBin = process.env.KYDO_CODEX_BIN?.trim() || "codex";
  let oncallModel = process.env.KYDO_ONCALL_MODEL?.trim() || DEFAULT_MODEL;
  let oncallThinking = process.env.KYDO_ONCALL_THINKING?.trim() || DEFAULT_THINKING;
  let scanIntervalMs = 30_000;
  let stalledAfterMs = 90 * 60_000;
  let restartBaseDelayMs = 5_000;
  let restartMaxDelayMs = 5 * 60_000;
  let maxRestarts = 10;
  let repairEnabled = true;
  let explicitExtension = true;
  let stateDir = path.join(cwd, ".autoresearch");
  let help = false;
  let passthrough = false;

  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value === "--") throw new Error(`${flag} requires a value`);
    return value;
  };
  const positiveInteger = (raw: string, flag: string): number => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${flag} must be a positive integer`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (passthrough) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pi-bin") {
      piBin = readValue(index, arg);
      index++;
    } else if (arg === "--codex-bin") {
      codexBin = readValue(index, arg);
      index++;
    } else if (arg === "--oncall-model") {
      oncallModel = readValue(index, arg);
      index++;
    } else if (arg === "--oncall-thinking") {
      oncallThinking = readValue(index, arg);
      index++;
    } else if (arg === "--scan-interval-ms") {
      scanIntervalMs = positiveInteger(readValue(index, arg), arg);
      index++;
    } else if (arg === "--stalled-after-ms") {
      stalledAfterMs = positiveInteger(readValue(index, arg), arg);
      index++;
    } else if (arg === "--restart-base-delay-ms") {
      restartBaseDelayMs = positiveInteger(readValue(index, arg), arg);
      index++;
    } else if (arg === "--restart-max-delay-ms") {
      restartMaxDelayMs = positiveInteger(readValue(index, arg), arg);
      index++;
    } else if (arg === "--max-restarts") {
      maxRestarts = positiveInteger(readValue(index, arg), arg);
      index++;
    } else if (arg === "--state-dir") {
      stateDir = path.resolve(cwd, readValue(index, arg));
      index++;
    } else if (arg === "--no-repair") {
      repairEnabled = false;
    } else if (arg === "--no-explicit-extension") {
      explicitExtension = false;
    } else {
      forwarded.push(arg);
    }
  }

  const extensionPath = path.join(runtimeRoot, "extensions", "autoresearch", "index.ts");
  return {
    help,
    options: {
      repoRoot: cwd,
      runtimeRoot,
      extensionPath,
      stateDir,
      piBin,
      codexBin,
      piArgs: forwarded,
      oncallModel,
      oncallThinking,
      scanIntervalMs,
      stalledAfterMs,
      restartBaseDelayMs,
      restartMaxDelayMs,
      maxRestarts,
      repairEnabled,
      explicitExtension,
    },
  };
}

export function supervisorHelp(): string {
  return `Usage: pi-kydo [supervisor options] [-- Pi options]

Launch interactive Pi with kydoresearch under a catastrophic-failure supervisor.
Unknown options are forwarded to Pi. Use -- to separate Pi options explicitly.

Supervisor options:
  --pi-bin PATH                 Pi executable (default: pi)
  --codex-bin PATH              Codex executable (default: codex)
  --oncall-model MODEL          Pi on-call analyst model
  --oncall-thinking LEVEL       Pi on-call reasoning level (default: high)
  --scan-interval-ms N          Durable stream scan interval (default: 30000)
  --stalled-after-ms N          No-progress catastrophe threshold (default: 5400000)
  --restart-base-delay-ms N     Initial restart backoff (default: 5000)
  --restart-max-delay-ms N      Maximum restart backoff (default: 300000)
  --max-restarts N              Crash-loop circuit breaker (default: 10)
  --state-dir PATH              AutoResearch state directory
  --no-repair                   Diagnose and restart without dispatching Codex
  --no-explicit-extension       Rely on Pi's installed extension discovery
  -h, --help                    Show this help

Codex repairs always use gpt-5.6-sol at high reasoning in workspace-write mode.
Press Ctrl-C to stop the supervisor intentionally.`;
}

export function deterministicIncident(
  state: Record<string, unknown> | null,
  nowMs: number,
  lastProgressAt: number,
  stalledAfterMs: number,
): DeterministicIncident | null {
  const phase = typeof state?.phase === "string" ? state.phase : undefined;
  const recovery = isRecord(state?.recovery) ? state.recovery : undefined;
  if (phase === "paused" && recovery) {
    return {
      category: "recovery-circuit-open",
      problem: "AutoResearch paused after exhausting its systemic recovery circuit.",
      why: stringValue(recovery.message) || "Durable state contains a recovery record.",
      evidence: [JSON.stringify({ phase, recovery })],
    };
  }

  const active =
    phase !== undefined &&
    (ACTIVE_PHASE_PREFIXES.some((prefix) => phase.startsWith(prefix)) ||
      phase === "church" ||
      phase === "god");
  if (active && nowMs - lastProgressAt >= stalledAfterMs) {
    return {
      category: "progress-stalled",
      problem: `AutoResearch made no durable progress for ${nowMs - lastProgressAt}ms.`,
      why: `The active durable phase remained "${phase}" past the configured stall threshold.`,
      evidence: [JSON.stringify({ phase, lastProgressAt, nowMs, stalledAfterMs })],
    };
  }
  return null;
}

export function processExitIncident(
  exit: ProcessExit,
  state: Record<string, unknown> | null,
): DeterministicIncident | null {
  const phase = typeof state?.phase === "string" ? state.phase : undefined;
  if (exit.code === 0 && (phase === undefined || TERMINAL_PHASES.has(phase) || phase === "paused")) {
    return null;
  }
  return {
    category: "process-crash",
    problem: `The supervised Pi process exited unexpectedly (code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}).`,
    why: phase
      ? `Durable AutoResearch phase "${phase}" was not terminal when Pi exited.`
      : "Pi exited nonzero before a terminal AutoResearch checkpoint was available.",
    evidence: [JSON.stringify({ exit, phase: phase ?? null })],
  };
}

export function parseOncallAssessment(text: string): OncallAssessment | null {
  const value = parseJsonObject(text);
  if (!value) return null;
  const categories = new Set([
    "process-crash",
    "recovery-circuit-open",
    "progress-stalled",
    "provider-outage",
    "runtime-corruption",
    "infrastructure-failure",
    "none",
  ]);
  const confidence = new Set(["low", "medium", "high"]);
  if (
    typeof value.catastrophic !== "boolean" ||
    typeof value.category !== "string" ||
    !categories.has(value.category) ||
    typeof value.confidence !== "string" ||
    !confidence.has(value.confidence) ||
    typeof value.problem !== "string" ||
    typeof value.why !== "string" ||
    !stringArray(value.errorLogs) ||
    !stringArray(value.possibleRootCauses) ||
    typeof value.repairable !== "boolean" ||
    !stringArray(value.repairScope) ||
    typeof value.restartRecommended !== "boolean"
  ) {
    return null;
  }
  return value as unknown as OncallAssessment;
}

export function shouldIntervene(
  assessment: OncallAssessment | null,
  deterministic: DeterministicIncident | null,
  matchingAssessments = 1,
): boolean {
  if (deterministic) return true;
  return (
    assessment?.catastrophic === true &&
    assessment.confidence === "high" &&
    matchingAssessments >= 2
  );
}

export class OncallSupervisor {
  private readonly options: SupervisorOptions;
  private stopping = false;
  private current: RunningProcess | null = null;
  private readonly cursors = new Map<string, TailCursor>();
  private lastProgressAt = Date.now();
  private lastStateFingerprint = "";
  private streamWindow = "";
  private pendingStreamEvidence = false;
  private restartCount = 0;
  private seenIncidentSignatures = new Set<string>();
  private lastSemanticIncident = "";
  private matchingSemanticAssessments = 0;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  async run(): Promise<number> {
    this.installSignalHandlers();
    this.ensureOncallDirectory();
    this.recordStream("supervisor", "pi-kydo supervisor started");

    while (!this.stopping) {
      const autoResume = this.restartCount > 0;
      const launchedAt = Date.now();
      this.current = this.launchPi(autoResume);
      let outcome: { assessment: OncallAssessment; evidence: string } | null;
      try {
        outcome = await this.monitorCurrentProcess(this.current);
      } catch (error) {
        await this.current.terminate();
        const message = errorMessage(error);
        outcome = {
          assessment: {
            catastrophic: true,
            category: "infrastructure-failure",
            confidence: "high",
            problem: "The outer supervisor failed while monitoring active AutoResearch.",
            why: message,
            errorLogs: [message],
            possibleRootCauses: ["Unreadable or corrupt runtime evidence", "Supervisor defect"],
            repairable: true,
            repairScope: ["Outer supervisor monitoring path"],
            restartRecommended: true,
          },
          evidence: `${this.streamWindow}\n[supervisor.error]\n${message}`,
        };
      }
      this.current = null;

      if (this.stopping || !outcome) return 0;
      if (Date.now() - launchedAt >= STABLE_RUN_MS) {
        this.restartCount = 0;
        this.seenIncidentSignatures.clear();
      }
      if (this.restartCount >= this.options.maxRestarts) {
        this.recordStream(
          "supervisor",
          `restart circuit opened after ${this.restartCount} incidents`,
        );
        process.stderr.write(
          `[pi-kydo] restart circuit opened after ${this.restartCount} incidents; see ${this.oncallRoot()}\n`,
        );
        return 1;
      }

      this.restartCount++;
      try {
        await this.handleIncident(outcome.assessment, outcome.evidence);
      } catch (error) {
        process.stderr.write(
          `[pi-kydo] failed to persist or dispatch incident repair: ${errorMessage(error)}\n`,
        );
      }
      this.lastSemanticIncident = "";
      this.matchingSemanticAssessments = 0;
      if (this.stopping) return 0;

      const delayMs = Math.min(
        this.options.restartMaxDelayMs,
        this.options.restartBaseDelayMs * 2 ** Math.max(0, this.restartCount - 1),
      );
      process.stderr.write(`[pi-kydo] restarting AutoResearch in ${delayMs}ms\n`);
      await delay(delayMs);
    }
    return 0;
  }

  private async monitorCurrentProcess(
    current: RunningProcess,
  ): Promise<{ assessment: OncallAssessment; evidence: string } | null> {
    while (!this.stopping) {
      const result = await Promise.race([
        current.exit.then((exit) => ({ type: "exit" as const, exit })),
        delay(this.options.scanIntervalMs).then(() => ({ type: "scan" as const })),
      ]);
      if (this.stopping) return null;

      const batch = this.collectStreamBatch();
      const deterministic =
        result.type === "exit"
          ? processExitIncident(result.exit, batch.state)
          : deterministicIncident(
              batch.state,
              Date.now(),
              batch.lastProgressAt,
              this.options.stalledAfterMs,
            );

      if (result.type === "exit" && !deterministic) return null;
      if (!batch.changed && !deterministic) continue;

      const assessment = await this.runOncallAnalyst(
        batch.text,
        deterministic
          ? `${deterministic.problem}\n${deterministic.why}\n${deterministic.evidence.join("\n")}`
          : undefined,
      );
      const matchingAssessments = deterministic
        ? 0
        : this.recordSemanticAssessment(assessment);
      if (!shouldIntervene(assessment, deterministic, matchingAssessments)) {
        if (result.type === "exit") {
          const fallback = fallbackAssessment(deterministic!);
          return { assessment: fallback, evidence: batch.text };
        }
        continue;
      }

      if (result.type !== "exit") await current.terminate();
      return {
        assessment: assessment ?? fallbackAssessment(deterministic!),
        evidence: batch.text,
      };
    }
    return null;
  }

  private recordSemanticAssessment(assessment: OncallAssessment | null): number {
    if (!assessment?.catastrophic || assessment.confidence !== "high") {
      this.lastSemanticIncident = "";
      this.matchingSemanticAssessments = 0;
      return 0;
    }
    const signature = `${assessment.category}\0${assessment.problem}`;
    if (signature !== this.lastSemanticIncident) {
      this.lastSemanticIncident = signature;
      this.matchingSemanticAssessments = 1;
    } else {
      this.matchingSemanticAssessments++;
    }
    return this.matchingSemanticAssessments;
  }

  private launchPi(autoResume: boolean): RunningProcess {
    const args = [
      ...(this.options.explicitExtension ? ["-e", this.options.extensionPath] : []),
      ...this.options.piArgs,
    ];
    const child = spawn(this.options.piBin, args, {
      cwd: this.options.repoRoot,
      env: {
        ...process.env,
        KYDO_ONCALL_SUPERVISED: "1",
        ...(autoResume ? { KYDO_ONCALL_RESTART: String(this.restartCount) } : {}),
      },
      stdio: ["inherit", "inherit", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    this.recordStream(
      "supervisor",
      `launched Pi pid=${child.pid ?? "unknown"}${autoResume ? " with durable auto-resume" : ""}`,
    );

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      process.stderr.write(chunk);
      stderrTail = clipTail(stderrTail + chunk, MAX_CAPTURED_STDERR_BYTES);
      this.appendEvidence("[pi.stderr]", chunk);
      this.recordStream("pi.stderr", chunk);
    });

    const exit = new Promise<ProcessExit>((resolve) => {
      child.once("error", (error) => {
        this.recordStream("pi.error", error.message);
        resolve({ code: 1, signal: null });
      });
      child.once("exit", (code, signal) => {
        this.appendEvidence(
          "[pi.exit]",
          JSON.stringify({ code, signal, stderrTail }),
        );
        this.recordStream(
          "pi.exit",
          JSON.stringify({ code, signal, stderrTail }),
        );
        resolve({ code, signal });
      });
    });

    return {
      exit,
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        } else {
          child.kill("SIGTERM");
        }
        await Promise.race([exit, delay(5_000)]);
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else {
            child.kill("SIGKILL");
          }
          await exit;
        }
      },
    };
  }

  private collectStreamBatch(): StreamBatch {
    const chunks: string[] = [];
    for (const file of this.streamFiles()) {
      const chunk = this.readTail(file);
      if (chunk) chunks.push(`[${path.relative(this.options.repoRoot, file)}]\n${chunk}`);
    }
    const state = readJsonRecord(path.join(this.options.stateDir, "state.json"));
    const fingerprint = state ? progressFingerprint(state) : "";
    if (fingerprint && fingerprint !== this.lastStateFingerprint) {
      this.lastStateFingerprint = fingerprint;
      this.lastProgressAt = Date.now();
    }
    if (chunks.length > 0) {
      this.lastProgressAt = Date.now();
      const joined = chunks.join("\n");
      this.recordStream("durable.tail", joined);
      this.appendEvidence("[durable]", joined);
    }
    const changed = chunks.length > 0 || this.pendingStreamEvidence;
    this.pendingStreamEvidence = false;
    return {
      text: this.streamWindow || "(no durable AutoResearch events captured yet)",
      changed,
      state,
      lastProgressAt: this.lastProgressAt,
    };
  }

  private streamFiles(): string[] {
    const candidates = [
      path.join(this.options.stateDir, "journal.ndjson"),
      path.join(this.options.stateDir, "agent-invocations.ndjson"),
      path.join(this.options.stateDir, "state.json"),
      path.join(this.options.stateDir, "logs"),
    ];
    const files: string[] = [];
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          files.push(candidate);
          continue;
        }
        walkLogFiles(candidate, files);
      } catch {
        // Atomic replacement or cleanup may race a scan; the next scan retries.
      }
    }
    const runsDirectory = path.join(this.options.stateDir, "runs");
    try {
      for (const entry of fs.readdirSync(runsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        walkLogFiles(path.join(runsDirectory, entry.name, "logs"), files);
      }
    } catch {
      // No candidate archive exists yet, or a candidate sealed during the scan.
    }
    return files.sort();
  }

  private readTail(file: string): string {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return "";
    }
    const identity = `${stat.dev}:${stat.ino}`;
    const previous = this.cursors.get(file);
    const offset =
      !previous || previous.identity !== identity || previous.offset > stat.size
        ? 0
        : previous.offset;
    if (offset === stat.size) return "";
    const length = Math.min(stat.size - offset, MAX_STREAM_WINDOW_BYTES);
    const start = stat.size - offset > MAX_STREAM_WINDOW_BYTES ? stat.size - length : offset;
    const descriptor = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      this.cursors.set(file, { offset: stat.size, identity });
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private async runOncallAnalyst(
    stream: string,
    forcedReason?: string,
  ): Promise<OncallAssessment | null> {
    const tracePath = path.join(this.oncallRoot(), "analyst.ndjson");
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--model",
      this.options.oncallModel,
      "--thinking",
      this.options.oncallThinking,
      "--no-tools",
      assessmentPrompt(stream, forcedReason),
    ];
    const result = await captureProcess(
      this.options.piBin,
      args,
      this.options.repoRoot,
      tracePath,
      ANALYST_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      this.recordStream(
        "oncall.error",
        `analyst exited ${result.code}: ${clipTail(result.stderr, 4_096)}`,
      );
      return null;
    }
    const assistant = assistantTextFromPiJsonl(result.stdout);
    const assessment = parseOncallAssessment(assistant);
    if (!assessment) {
      this.recordStream("oncall.error", "analyst returned an invalid incident contract");
    }
    return assessment;
  }

  private async handleIncident(
    assessment: OncallAssessment,
    evidence: string,
  ): Promise<void> {
    const signature = incidentSignature(assessment, evidence);
    const files = this.createIncidentFiles(signature);
    fs.writeFileSync(files.evidence, evidence.endsWith("\n") ? evidence : `${evidence}\n`);
    fs.writeFileSync(files.reportJson, `${JSON.stringify(assessment, null, 2)}\n`);
    fs.writeFileSync(files.reportMarkdown, incidentMarkdown(assessment));
    this.recordStream("incident", `sealed incident ${path.basename(files.directory)}`);
    process.stderr.write(
      `[pi-kydo] catastrophic ${assessment.category}: ${assessment.problem}\n` +
        `[pi-kydo] report: ${files.reportMarkdown}\n`,
    );

    if (!this.options.repairEnabled) return;
    if (this.seenIncidentSignatures.has(signature)) {
      this.recordStream(
        "repair",
        "identical incident already dispatched to Codex; suppressing duplicate repair",
      );
      return;
    }
    this.seenIncidentSignatures.add(signature);
    const repair = await this.runCodexRepair(files, assessment);
    fs.writeFileSync(files.codexResult, `${JSON.stringify(repair, null, 2)}\n`);
    process.stderr.write(`[pi-kydo] Codex repair status: ${repair.status} — ${repair.summary}\n`);
  }

  private async runCodexRepair(
    files: IncidentFiles,
    assessment: OncallAssessment,
  ): Promise<RepairResult> {
    const lastMessage = path.join(files.directory, "codex-last-message.md");
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--color",
      "never",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="high"',
      "--config",
      'approval_policy="never"',
      "--sandbox",
      "workspace-write",
      "--cd",
      this.options.repoRoot,
      "--output-last-message",
      lastMessage,
    ];
    if (path.resolve(this.options.runtimeRoot) !== path.resolve(this.options.repoRoot)) {
      args.push("--add-dir", this.options.runtimeRoot);
    }
    args.push(
      repairPrompt(
        files.reportMarkdown,
        files.evidence,
        this.options.runtimeRoot,
        assessment,
      ),
    );
    const result = await captureProcess(
      this.options.codexBin,
      args,
      this.options.repoRoot,
      files.codexTrace,
      REPAIR_TIMEOUT_MS,
    );
    const finalText = fs.existsSync(lastMessage)
      ? fs.readFileSync(lastMessage, "utf8")
      : assistantTextFromCodexJsonl(result.stdout);
    const parsed = parseRepairResult(finalText);
    if (parsed) return parsed;
    return {
      status: result.code === 0 ? "unknown" : "failed",
      summary:
        result.code === 0
          ? "Codex completed without a valid structured repair result."
          : `Codex exited with code ${result.code}: ${clipTail(result.stderr, 2_048)}`,
      filesChanged: [],
      validation: [],
      remainingRisk: "The repair outcome could not be verified from the agent contract.",
    };
  }

  private createIncidentFiles(signature: string): IncidentFiles {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    const directory = path.join(
      this.oncallRoot(),
      "incidents",
      `${timestamp}-${signature.slice(0, 8)}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    return {
      directory,
      reportJson: path.join(directory, "report.json"),
      reportMarkdown: path.join(directory, "report.md"),
      evidence: path.join(directory, "evidence.log"),
      codexTrace: path.join(directory, "codex.ndjson"),
      codexResult: path.join(directory, "repair.json"),
    };
  }

  private oncallRoot(): string {
    return path.join(this.options.stateDir, "oncall");
  }

  private ensureOncallDirectory(): void {
    ensureGitExclude(this.options.repoRoot);
    fs.mkdirSync(path.join(this.oncallRoot(), "incidents"), { recursive: true });
  }

  private recordStream(source: string, text: string): void {
    this.ensureOncallDirectory();
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      source,
      text: clipTail(text, MAX_CAPTURED_STDERR_BYTES),
    });
    fs.appendFileSync(path.join(this.oncallRoot(), "process-stream.ndjson"), `${entry}\n`);
  }

  private appendEvidence(source: string, text: string): void {
    this.streamWindow = clipTail(
      `${this.streamWindow}\n${source}\n${text}`,
      MAX_STREAM_WINDOW_BYTES,
    );
    this.pendingStreamEvidence = true;
  }

  private installSignalHandlers(): void {
    const stop = (): void => {
      if (this.stopping) return;
      this.stopping = true;
      this.recordStream("supervisor", "operator requested stop");
      void this.current?.terminate();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}

function fallbackAssessment(incident: DeterministicIncident): OncallAssessment {
  return {
    catastrophic: true,
    category: incident.category,
    confidence: "high",
    problem: incident.problem,
    why: incident.why,
    errorLogs: incident.evidence,
    possibleRootCauses: ["The deterministic supervisor signal requires focused diagnosis."],
    repairable: incident.category !== "provider-outage",
    repairScope: ["Restore process-level forward progress without changing research policy."],
    restartRecommended: true,
  };
}

function parseRepairResult(text: string): RepairResult | null {
  const value = parseJsonObject(text);
  if (!value) return null;
  const statuses = new Set(["fixed", "no-code-fix", "blocked"]);
  if (
    typeof value.status !== "string" ||
    !statuses.has(value.status) ||
    typeof value.summary !== "string" ||
    !stringArray(value.filesChanged) ||
    !stringArray(value.validation) ||
    typeof value.remainingRisk !== "string"
  ) {
    return null;
  }
  return value as unknown as RepairResult;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i)?.[1];
  for (const candidate of [trimmed, fenced]) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {
      // Try the next representation.
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function assistantTextFromPiJsonl(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (
        !isRecord(event) ||
        event.type !== "message_end" ||
        !isRecord(event.message) ||
        event.message.role !== "assistant"
      ) {
        continue;
      }
      const content = event.message.content;
      if (typeof content === "string") messages.push(content);
      if (Array.isArray(content)) {
        messages.push(
          content
            .filter((part): part is Record<string, unknown> => isRecord(part))
            .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
            .join(""),
        );
      }
    } catch {
      // The trace remains authoritative; malformed lines do not become incidents.
    }
  }
  return messages.at(-1) ?? "";
}

function assistantTextFromCodexJsonl(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) continue;
      if (event.type === "item.completed" && isRecord(event.item)) {
        if (event.item.type === "agent_message" && typeof event.item.text === "string") {
          messages.push(event.item.text);
        }
      }
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }
  return messages.at(-1) ?? "";
}

async function captureProcess(
  command: string,
  args: string[],
  cwd: string,
  tracePath: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  const traceFile = fs.openSync(tracePath, "a");
  const stderrFile = fs.openSync(`${tracePath}.stderr.log`, "a");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fs.closeSync(traceFile);
      fs.closeSync(stderrFile);
      resolve({ code, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish(1);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      fs.writeSync(traceFile, chunk);
      stdout = clipTail(stdout + chunk, MAX_AGENT_OUTPUT_BYTES);
    });
    child.stderr?.on("data", (chunk: string) => {
      fs.writeSync(stderrFile, chunk);
      stderr = clipTail(stderr + chunk, MAX_AGENT_OUTPUT_BYTES);
    });
    child.once("error", (error) => {
      fs.writeSync(stderrFile, error.message);
      stderr = clipTail(stderr + error.message, MAX_AGENT_OUTPUT_BYTES);
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
    timeout = setTimeout(() => {
      const message = `${stderr.endsWith("\n") || !stderr ? "" : "\n"}process timed out after ${timeoutMs}ms\n`;
      fs.writeSync(stderrFile, message);
      stderr = clipTail(stderr + message, MAX_AGENT_OUTPUT_BYTES);
      terminateChild(child);
      setTimeout(() => terminateChild(child, true), 5_000).unref();
    }, timeoutMs);
    timeout.unref();
  });
}

function terminateChild(
  child: ReturnType<typeof spawn>,
  force = false,
): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  child.kill(signal);
}

function progressFingerprint(state: Record<string, unknown>): string {
  const ideas = Array.isArray(state.ideas)
    ? state.ideas.map((idea) =>
        isRecord(idea)
          ? {
              id: idea.id,
              status: idea.status,
              verifyAttempts: idea.verifyAttempts,
              archivedAt: idea.archivedAt,
            }
          : idea,
      )
    : [];
  return JSON.stringify({
    phase: state.phase,
    loop: state.loop,
    historyLength: Array.isArray(state.history) ? state.history.length : 0,
    ideas,
    recovery: state.recovery,
    updatedAt: state.updatedAt,
  });
}

function walkLogFiles(directory: string, output: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkLogFiles(target, output);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".log") || entry.name.endsWith(".ndjson"))
    ) {
      output.push(target);
    }
  }
}

function incidentMarkdown(assessment: OncallAssessment): string {
  const bullets = (values: string[]): string =>
    values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- None captured.";
  return `# AutoResearch incident

## Problem

${assessment.problem}

## Why this is catastrophic

${assessment.why}

## Error logs

${bullets(assessment.errorLogs)}

## Possible root causes

${bullets(assessment.possibleRootCauses)}

## Permitted repair scope

${bullets(assessment.repairScope)}

Category: \`${assessment.category}\`  
Confidence: \`${assessment.confidence}\`  
Locally repairable: \`${assessment.repairable}\`  
Restart recommended: \`${assessment.restartRecommended}\`
`;
}

function incidentSignature(assessment: OncallAssessment, evidence: string): string {
  return createHash("sha256")
    .update(assessment.category)
    .update("\0")
    .update(assessment.problem)
    .update("\0")
    .update(clipTail(evidence, 16_384))
    .digest("hex");
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipTail(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maximumBytes) return value;
  return buffer.subarray(buffer.length - maximumBytes).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureGitExclude(repoRoot: string): void {
  try {
    const dotGit = path.join(repoRoot, ".git");
    if (!fs.existsSync(dotGit)) return;
    let gitDirectory = dotGit;
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const pointer = fs.readFileSync(dotGit, "utf8").trim();
      const match = pointer.match(/^gitdir:\s*(.+)$/i);
      if (!match) return;
      gitDirectory = path.resolve(repoRoot, match[1]!);
    }
    const exclude = path.join(gitDirectory, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (/^\.autoresearch\/?$/m.test(current)) return;
    fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.autoresearch/\n`);
  } catch {
    // The extension repeats this best-effort local-only exclusion during init.
  }
}
