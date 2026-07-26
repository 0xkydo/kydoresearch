import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RolesConfig, RoleSpec } from "../config.ts";
import type { AgentResult, AgentRunner, AgentTask, TaskKind } from "./types.ts";

const BUNDLED_PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/autoresearch/prompts",
);
const BUNDLED_ROLE_PROMPTS_DIR = path.join(BUNDLED_PROMPTS_DIR, "roles");
const BUNDLED_TASK_PROMPTS_DIR = path.join(BUNDLED_PROMPTS_DIR, "tasks");
const TASK_PROMPT_FILES: Record<TaskKind, string> = {
  "init.explore": "init-explore.md",
  propose: "propose.md",
  implement: "implement.md",
  "write-note": "write-note.md",
  church: "church.md",
  advise: "advise.md",
};
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

    const role = this.roles[task.role];
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

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      role.model,
    ];
    if (role.thinking !== undefined) args.push("--thinking", role.thinking);
    if (role.tools !== undefined) {
      const tools = role.tools.map((tool) => tool.trim()).filter(Boolean);
      if (tools.length > 0) args.push("--tools", tools.join(","));
      else args.push("--no-tools");
    }
    args.push(prompt);

    return new Promise((resolve) => {
      const assistantText: string[] = [];
      let lastAssistantText = "";
      let stderr = "";
      let stdoutBuffer = "";
      let parseError: string | undefined;
      let stopReason: string | undefined;
      let agentError: string | undefined;
      let cost = 0;
      let turns = 0;
      let settled = false;
      let terminationError: string | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;

      const failedResult = (error: string): AgentResult => ({
        ok: false,
        output: assistantText.join(""),
        filesWritten: [],
        usage: { cost, turns },
        error,
      });

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("pi", args, {
          cwd: task.cwd,
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve(failedResult(`Failed to start pi: ${errorMessage(error)}`));
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
      };

      const finish = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
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

        if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return;
        const message = event.message;
        if (message.role !== "assistant") return;

        const text = extractAssistantText(message.content);
        assistantText.push(text);
        lastAssistantText = text;
        turns++;
        if (typeof message.stopReason === "string") stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") agentError = message.errorMessage;

        if (isRecord(message.usage) && isRecord(message.usage.cost)) {
          const eventCost = message.usage.cost.total;
          if (typeof eventCost === "number" && Number.isFinite(eventCost)) cost += eventCost;
        }
      };

      proc.stdout!.on("data", (data: Buffer | string) => {
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
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

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
          filesWritten: [],
          usage: { cost, turns },
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

function emptyFailedResult(error: string): AgentResult {
  return {
    ok: false,
    output: "",
    filesWritten: [],
    usage: { cost: 0, turns: 0 },
    error,
  };
}

function loadAndRenderPrompt(role: RoleSpec, task: AgentTask): string {
  const configuredPath = role.prompt?.trim() || `${task.role}.md`;
  const rolePromptPath = resolveRolePromptPath(configuredPath, task.stateDir);
  const taskPromptPath = resolveTaskPromptPath(task.kind, task.stateDir);
  const roleTemplate = fs.readFileSync(rolePromptPath, "utf8").trimEnd();
  const taskTemplate = fs.readFileSync(taskPromptPath, "utf8").trimStart();
  const template = `${roleTemplate}\n\n---\n\n${taskTemplate}`;
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
    return path.join(BUNDLED_ROLE_PROMPTS_DIR, configuredPath);
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

function resolveTaskPromptPath(kind: TaskKind, stateDir: string): string {
  const filename = TASK_PROMPT_FILES[kind];
  const customPath = path.join(stateDir, "prompts", "tasks", filename);
  return fs.existsSync(customPath) ? customPath : path.join(BUNDLED_TASK_PROMPTS_DIR, filename);
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
