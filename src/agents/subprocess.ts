import { spawn } from "node:child_process";
import type { RolesConfig } from "../config.ts";
import type { AgentResult, AgentRunner, AgentTask } from "./types.ts";

/**
 * Spawns an isolated `pi --mode json -p` subprocess for each agent task.
 * Prompt-file resolution, thinking levels, tool allowlists, and cancellation
 * are layered onto this core process/event mapping separately.
 */
export class PiSubprocessRunner implements AgentRunner {
  constructor(private readonly roles: RolesConfig) {}

  run(task: AgentTask): Promise<AgentResult> {
    const role = this.roles[task.role];
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      role.model,
      JSON.stringify(task.input),
    ];

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

      const finish = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const failedResult = (error: string): AgentResult => ({
        ok: false,
        output: assistantText.join(""),
        filesWritten: [],
        usage: { cost, turns },
        error,
      });

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

      const proc = spawn("pi", args, {
        cwd: task.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout.on("data", (data: Buffer | string) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });

      proc.on("error", (error) => {
        finish(failedResult(`Failed to start pi: ${error.message}`));
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);

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
    });
  }
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
