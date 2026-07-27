import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentActivityRecorder,
  emptyAgentTokenUsage,
  resolveAgentInvocationIdentity,
  resolveAgentTracePath,
} from "../agent-activity.ts";
import type { RolesConfig, RoleSpec } from "../config.ts";
import type {
  AgentResult,
  AgentRunner,
  AgentTask,
  AgentTokenUsage,
  AgentUsage,
  TaskKind,
} from "./types.ts";

const BUNDLED_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/autoresearch/prompts",
);
const BUNDLED_TASK_PROMPTS_DIR = path.join(BUNDLED_PROMPTS_DIR, "tasks");
const TASK_PROMPT_FILES: Partial<Record<TaskKind, string>> = {
  "init.explore": "init-explore.md",
  "init.review": "init-review.md",
  "init.decide": "init-decide.md",
  propose: "propose.md",
  implement: "implement.md",
  "write-note": "write-note.md",
  church: "church.md",
  "god-conversation": "church.md",
  advise: "advise.md",
};
const BUNDLED_AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/autoresearch/agents",
);
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export interface PiSubprocessRunnerOptions {
  /** Maximum wall time for one agent turn. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Time between SIGTERM and forced SIGKILL. Defaults to 5 seconds. */
  killGraceMs?: number;
}

/**
 * Spawns an isolated `pi --mode json -p` subprocess for each agent task.
 * Every invocation is bounded and returns failures rather than throwing into
 * the orchestrator.
 */
export class PiSubprocessRunner implements AgentRunner {
  constructor(
    private readonly roles: RolesConfig,
    private readonly options: PiSubprocessRunnerOptions = {},
  ) {}

  run(task: AgentTask): Promise<AgentResult> {
    if (task.signal?.aborted) {
      return Promise.resolve(emptyFailedResult("pi subprocess aborted before start"));
    }

    const role = { ...this.roles[task.role], ...(task.roleOverride ?? {}) };
    let prompt: string;
    try {
      prompt = loadAndRenderPrompt(role, task);
    } catch (error) {
      return Promise.resolve(
        emptyFailedResult(
          `Failed to load prompts for ${task.role}/${task.kind}: ${errorMessage(error)}`,
        ),
      );
    }

    let soulPath: string;
    const configuredSoul = role.soul?.trim() || undefined;
    try {
      soulPath = resolveSoulPath(configuredSoul, task);
    } catch (error) {
      return Promise.resolve(
        emptyFailedResult(
          `Failed to load soul "${configuredSoul || `${task.role}/SOUL.md`}": ${errorMessage(error)}`,
        ),
      );
    }

    let traceFile: number | undefined;
    let traceAgentDir: string | undefined;
    let traceEventsPath: string | undefined;
    try {
      const trace = prepareTrace(task, soulPath, prompt);
      traceFile = trace?.file;
      traceAgentDir = trace?.agentDir;
      traceEventsPath = trace?.eventsPath;
      if (trace?.soulPath) soulPath = trace.soulPath;
    } catch (error) {
      return Promise.resolve(emptyFailedResult(`Failed to prepare pi trace: ${errorMessage(error)}`));
    }

    let activityRecorder: ReturnType<typeof createAgentActivityRecorder>;
    try {
      const identity = resolveAgentInvocationIdentity(task, traceEventsPath);
      if (traceAgentDir) writeInvocationSnapshot(traceAgentDir, task, identity);
      activityRecorder = createAgentActivityRecorder(
        task.stateDir,
        identity,
        task.activityObserver,
      );
      // This durable start precedes spawn, the first externally visible child action.
      activityRecorder.start();
    } catch (error) {
      if (traceFile !== undefined) fs.closeSync(traceFile);
      return Promise.resolve(
        emptyFailedResult(`Failed to record pi invocation: ${errorMessage(error)}`),
      );
    }

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
      role.model,
    ];
    if (role.thinking !== undefined) args.push("--thinking", role.thinking);
    const configuredTools = task.tools ?? role.tools;
    if (configuredTools !== undefined) {
      const tools = configuredTools.map((tool) => tool.trim()).filter(Boolean);
      if (tools.length > 0) args.push("--tools", tools.join(","));
      else args.push("--no-tools");
    }
    args.push("--append-system-prompt", soulPath);
    args.push(prompt);

    return new Promise((resolve) => {
      const assistantText: string[] = [];
      const filesWritten = new Set<string>();
      let lastAssistantText = "";
      let stderr = "";
      let stdoutBuffer = "";
      let parseError: string | undefined;
      let stopReason: string | undefined;
      let agentError: string | undefined;
      let cost = 0;
      let turns = 0;
      const tokens = emptyAgentTokenUsage(true);
      let settled = false;
      let terminationError: string | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;

      const failedResult = (error: string): AgentResult => ({
        ok: false,
        output: assistantText.join(""),
        filesWritten: [...filesWritten].sort(),
        usage: currentUsage(cost, turns, tokens),
        error,
      });

      let proc: ReturnType<typeof spawn>;
      try {
        const invocation = resolvePiInvocation(args);
        proc = spawn(invocation.command, invocation.args, {
          cwd: task.cwd,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        if (traceFile !== undefined) {
          fs.closeSync(traceFile);
          traceFile = undefined;
        }
        const result = failedResult(`Failed to start pi: ${errorMessage(error)}`);
        try {
          activityRecorder.terminal("failed", result.usage!, result.error);
        } catch (recordError) {
          result.error += `; Failed to record terminal agent activity: ${errorMessage(recordError)}`;
        }
        resolve(result);
        return;
      }

      const signalProcess = (signal: NodeJS.Signals): void => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        if (process.platform !== "win32" && proc.pid !== undefined) {
          try {
            process.kill(-proc.pid, signal);
            return;
          } catch {
            // Fall through to signaling the direct child.
          }
        }
        try {
          proc.kill(signal);
        } catch {
          // The close/error event will settle the result.
        }
      };

      const terminate = (error: string): void => {
        if (terminationError !== undefined || settled) return;
        terminationError = error;
        signalProcess("SIGTERM");
        const graceMs = Math.max(0, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        killHandle = setTimeout(() => signalProcess("SIGKILL"), graceMs);
      };

      const onAbort = (): void => terminate("pi subprocess aborted");

      const cleanup = (): void => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        task.signal?.removeEventListener("abort", onAbort);
        if (traceFile !== undefined) {
          fs.closeSync(traceFile);
          traceFile = undefined;
        }
      };

      const finish = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const status =
          result.ok
            ? "complete"
            : terminationError !== undefined
              ? "interrupted"
              : "failed";
        try {
          activityRecorder.terminal(
            status,
            result.usage ?? currentUsage(cost, turns, tokens),
            result.error,
          );
        } catch (error) {
          result = {
            ...result,
            ok: false,
            error: `${result.error ? `${result.error}; ` : ""}Failed to record terminal agent activity: ${errorMessage(error)}`,
          };
        }
        resolve(result);
      };

      const processLine = (line: string): void => {
        if (!line.trim() || parseError) return;

        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch (error) {
          parseError = `Invalid JSON event from pi: ${errorMessage(error)}`;
          return;
        }

        if (!isRecord(event)) return;
        recordWrittenToolPath(event, task.cwd, filesWritten);
        const activity = activityFromPiEvent(event);
        if (activity) {
          try {
            activityRecorder.activity(activity);
          } catch (error) {
            terminate(`Failed to record agent activity: ${errorMessage(error)}`);
            return;
          }
        }
        if (event.type !== "message_end" || !isRecord(event.message)) return;
        const message = event.message;
        if (message.role !== "assistant") return;

        const text = extractAssistantText(message.content);
        assistantText.push(text);
        lastAssistantText = text;
        turns++;
        if (typeof message.stopReason === "string") stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") agentError = message.errorMessage;

        if (isRecord(message.usage)) {
          const eventCost = isRecord(message.usage.cost)
            ? message.usage.cost.total
            : undefined;
          if (finiteNonNegative(eventCost)) cost += eventCost;
          accumulateTokenUsage(tokens, message.usage);
        } else {
          tokens.complete = false;
        }
        try {
          activityRecorder.usage(currentUsage(cost, turns, tokens));
        } catch (error) {
          terminate(`Failed to record agent usage: ${errorMessage(error)}`);
        }
      };

      proc.stdout!.on("data", (data: Buffer | string) => {
        if (traceFile !== undefined) {
          if (typeof data === "string") fs.writeSync(traceFile, data);
          else fs.writeSync(traceFile, data);
        }
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr!.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });

      proc.on("error", (error) => {
        finish(failedResult(terminationError ?? `Failed to start pi: ${error.message}`));
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          const finalLine = stdoutBuffer;
          stdoutBuffer = "";
          processLine(finalLine);
        }

        if (terminationError) {
          finish(failedResult(terminationError));
          return;
        }

        if (parseError) {
          finish(failedResult(parseError));
          return;
        }

        if (code !== 0) {
          const detail = stderr.trim();
          finish(failedResult(`pi exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
          return;
        }

        if (stopReason === "error" || stopReason === "aborted") {
          finish(failedResult(agentError ?? `pi agent stopped with reason "${stopReason}"`));
          return;
        }

        const structured = parseTrailingStructuredPayload(lastAssistantText);
        if (structured.error) {
          finish(failedResult(structured.error));
          return;
        }

        finish({
          ok: true,
          output: assistantText.join(""),
          ...(structured.value ? { structured: structured.value } : {}),
          filesWritten: [...filesWritten].sort(),
          usage: currentUsage(cost, turns, tokens),
        });
      });

      if (task.signal) {
        task.signal.addEventListener("abort", onAbort, { once: true });
        if (task.signal.aborted) onAbort();
      }
      if (terminationError === undefined) {
        const timeoutMs = Math.max(1, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        timeoutHandle = setTimeout(() => terminate(`pi subprocess timed out after ${timeoutMs}ms`), timeoutMs);
      }
    });
  }
}

function recordWrittenToolPath(
  event: Record<string, unknown>,
  cwd: string,
  filesWritten: Set<string>,
): void {
  if (
    event.type !== "tool_execution_start" ||
    (event.toolName !== "write" && event.toolName !== "edit") ||
    !isRecord(event.args)
  ) {
    return;
  }
  const configuredPath =
    typeof event.args.path === "string"
      ? event.args.path
      : typeof event.args.filePath === "string"
        ? event.args.filePath
        : undefined;
  if (!configuredPath?.trim() || configuredPath.includes("\0")) return;
  filesWritten.add(
    path.isAbsolute(configuredPath)
      ? path.normalize(configuredPath)
      : path.resolve(cwd, configuredPath),
  );
}

function activityFromPiEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    const detail = isRecord(event.args) ? conciseToolArgs(event.args) : "";
    return detail ? `${event.toolName} ${detail}` : event.toolName;
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    return `${event.toolName} ${event.isError === true ? "failed" : "finished"}`;
  }
  if (event.type === "message_end" && isRecord(event.message)) {
    if (event.message.role !== "assistant") return undefined;
    const text = extractAssistantText(event.message.content).replace(/\s+/g, " ").trim();
    if (text) return text;
    if (typeof event.message.stopReason === "string") {
      return `assistant ${event.message.stopReason}`;
    }
  }
  return undefined;
}

function conciseToolArgs(args: Record<string, unknown>): string {
  for (const key of ["path", "filePath", "command", "cmd", "query", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const compact = value.replace(/\s+/g, " ").trim();
      return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
    }
  }
  return "";
}

function accumulateTokenUsage(
  aggregate: AgentTokenUsage,
  usage: Record<string, unknown>,
): void {
  const input = tokenField(usage, "input", "inputTokens", "input_tokens");
  const output = tokenField(usage, "output", "outputTokens", "output_tokens");
  const cacheRead = tokenField(
    usage,
    "cacheRead",
    "cacheReadTokens",
    "cache_read_tokens",
  );
  const cacheWrite = tokenField(
    usage,
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write_tokens",
  );
  const values = [input, output, cacheRead, cacheWrite];
  if (values.some((value) => value === undefined)) aggregate.complete = false;
  aggregate.input += input ?? 0;
  aggregate.output += output ?? 0;
  aggregate.cacheRead += cacheRead ?? 0;
  aggregate.cacheWrite += cacheWrite ?? 0;
  aggregate.total =
    aggregate.input +
    aggregate.output +
    aggregate.cacheRead +
    aggregate.cacheWrite;
}

function tokenField(
  usage: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (finiteNonNegative(value)) return value;
  }
  return undefined;
}

function currentUsage(
  cost: number,
  turns: number,
  tokens: AgentTokenUsage,
): AgentUsage {
  return {
    cost,
    turns,
    tokens: { ...tokens },
  };
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function emptyFailedResult(error: string): AgentResult {
  return {
    ok: false,
    output: "",
    filesWritten: [],
    usage: { cost: 0, turns: 0, tokens: emptyAgentTokenUsage(false) },
    error,
  };
}

function loadAndRenderPrompt(role: RoleSpec, task: AgentTask): string {
  const configuredPath = role.prompt?.trim() || `${task.role}.md`;
  const rolePromptPath = resolveRolePromptPath(configuredPath, task.stateDir);
  const taskPromptPath = resolveTaskPromptPath(task.kind, task.stateDir);
  const roleTemplate = fs.readFileSync(rolePromptPath, "utf8").trimEnd();
  const taskTemplate = taskPromptPath
    ? fs.readFileSync(taskPromptPath, "utf8").trimStart()
    : "";
  const template = taskTemplate
    ? `${roleTemplate}\n\n---\n\n${taskTemplate}`
    : roleTemplate;
  return renderPrompt(template, {
    ...task.input,
    role: task.role,
    kind: task.kind,
    cwd: task.cwd,
    stateDir: task.stateDir,
  });
}

function resolveRolePromptPath(configuredPath: string, stateDir: string): string {
  if (path.basename(configuredPath) === configuredPath) {
    return path.join(BUNDLED_PROMPTS_DIR, configuredPath);
  }
  if (path.isAbsolute(configuredPath)) {
    throw new Error("repo-relative prompt paths cannot be absolute");
  }

  const repoRoot = path.dirname(stateDir);
  const resolved = path.resolve(repoRoot, configuredPath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("repo-relative prompt path escapes the challenge repo");
  }
  return resolved;
}

function resolveTaskPromptPath(kind: TaskKind, stateDir: string): string | undefined {
  const filename = TASK_PROMPT_FILES[kind];
  if (!filename) return undefined;
  const customPath = path.join(stateDir, "prompts", "tasks", filename);
  return fs.existsSync(customPath) ? customPath : path.join(BUNDLED_TASK_PROMPTS_DIR, filename);
}

function resolveSoulPath(configuredPath: string | undefined, task: AgentTask): string {
  const soulPath =
    configuredPath === undefined
      ? path.join(BUNDLED_AGENTS_DIR, task.role, "SOUL.md")
      : resolveRoleFilePath(configuredPath, task.stateDir, path.join(BUNDLED_AGENTS_DIR, task.role));
  fs.accessSync(soulPath, fs.constants.R_OK);
  return soulPath;
}

function resolveRoleFilePath(configuredPath: string, stateDir: string, bundledDir: string): string {
  if (path.basename(configuredPath) === configuredPath) {
    return path.join(bundledDir, configuredPath);
  }
  if (path.isAbsolute(configuredPath)) {
    throw new Error("repo-relative role paths cannot be absolute");
  }

  const repoRoot = path.dirname(stateDir);
  const resolved = path.resolve(repoRoot, configuredPath);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("repo-relative role path escapes the challenge repo");
  }
  return resolved;
}

function prepareTrace(
  task: AgentTask,
  sourceSoulPath: string,
  renderedPrompt: string,
): {
  file: number;
  soulPath: string;
  agentDir: string;
  eventsPath: string;
} | undefined {
  const traceDir = optionalInputPath(task.input, "traceDir");
  const explicitTracePath =
    optionalInputPath(task.input, "tracePath") ??
    optionalInputPath(task.input, "runTracePath") ??
    task.invocation?.tracePath;
  if (traceDir === undefined && explicitTracePath === undefined) return undefined;

  const eventsPath =
    explicitTracePath === undefined
      ? path.join(resolveTracePath(traceDir!, task.stateDir), "events.ndjson")
      : resolveTracePath(explicitTracePath, task.stateDir);
  const agentDir =
    traceDir === undefined ? path.dirname(eventsPath) : resolveTracePath(traceDir, task.stateDir);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const soulSnapshotPath = path.join(agentDir, "soul.md");
  if (path.resolve(sourceSoulPath) !== path.resolve(soulSnapshotPath)) {
    fs.copyFileSync(sourceSoulPath, soulSnapshotPath);
  }
  fs.writeFileSync(path.join(agentDir, "context.md"), renderedPrompt);
  return {
    file: fs.openSync(eventsPath, "a"),
    soulPath: soulSnapshotPath,
    agentDir,
    eventsPath,
  };
}

function writeInvocationSnapshot(
  agentDir: string,
  task: AgentTask,
  invocation: ReturnType<typeof resolveAgentInvocationIdentity>,
): void {
  fs.writeFileSync(
    path.join(agentDir, "invocation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        invocation,
        role: task.role,
        kind: task.kind,
        cwd: task.cwd,
        stateDir: task.stateDir,
        taskTools: task.tools,
        roleOverride: task.roleOverride,
        input: task.input,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function optionalInputPath(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`task input ${key} must be a non-empty path string`);
  }
  return value.trim();
}

function resolveTracePath(configuredPath: string, stateDir: string): string {
  return resolveAgentTracePath(configuredPath, stateDir);
}

/**
 * Mirrors Pi's official subagent launcher: reuse the script or compiled
 * executable that started this process, and fall back to PATH for generic
 * runtimes where no usable Pi entry script is available.
 */
function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (
    currentScript &&
    !isBunVirtualScript &&
    isPiEntryScript(currentScript) &&
    fs.existsSync(currentScript)
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function isPiEntryScript(scriptPath: string): boolean {
  const basename = path.basename(scriptPath).toLowerCase();
  if (/^pi(?:\.(?:js|cjs|mjs|ts))?$/.test(basename)) return true;
  if (!/^cli\.(?:js|cjs|mjs|ts)$/.test(basename)) return false;

  const normalized = scriptPath.replaceAll(path.sep, "/").toLowerCase();
  return normalized.includes("/pi-coding-agent/") || normalized.includes("/packages/coding-agent/");
}

function renderPrompt(template: string, context: Record<string, unknown>): string {
  let rendered = template;
  const sectionPattern = /{{#([A-Za-z0-9_.-]+)}}([\s\S]*?){{\/\1}}/g;

  // Repeat so nested sections are fully rendered.
  while (sectionPattern.test(rendered)) {
    sectionPattern.lastIndex = 0;
    rendered = rendered.replace(sectionPattern, (_match, key: string, body: string) =>
      promptTruthy(readContextValue(context, key)) ? body : "",
    );
  }

  return rendered.replace(/{{([A-Za-z0-9_.-]+)}}/g, (_match, key: string) =>
    formatPromptValue(readContextValue(context, key)),
  );
}

function readContextValue(context: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), context);
}

function promptTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && (!Array.isArray(value) || value.length > 0);
}

function formatPromptValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value, null, 2);
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseTrailingStructuredPayload(
  finalMessage: string,
): { value?: Record<string, unknown>; error?: string } {
  const match = finalMessage.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  if (!match) return {};

  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!isRecord(value)) {
      return { error: "Trailing JSON payload from pi must be an object" };
    }
    return { value };
  } catch (error) {
    return { error: `Invalid trailing JSON payload from pi: ${errorMessage(error)}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
