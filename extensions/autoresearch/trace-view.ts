import * as fs from "node:fs";

export type TraceEventKind =
  | "assistant"
  | "thought"
  | "tool"
  | "result"
  | "error"
  | "system";

export interface MonitorTraceEvent {
  id: string;
  kind: TraceEventKind;
  label: string;
  summary: string;
  timestamp?: number | string;
  toolCallId?: string;
}

export interface ParsePiTraceOptions {
  idPrefix?: string;
  sequence?: number;
}

export interface TraceTailPoll {
  events: readonly MonitorTraceEvent[];
  /** Replace the caller's prior event list before applying these events. */
  reloaded: boolean;
  /** Next unread byte offset in the current file. */
  offset: number;
  missing?: boolean;
}

/**
 * Converts one Pi JSON event into compact semantic trace entries. Streaming
 * deltas are intentionally ignored because message_end is the authoritative
 * complete message in Pi's JSON protocol.
 */
export function parsePiTraceEvent(
  value: unknown,
  options: ParsePiTraceOptions = {},
): MonitorTraceEvent[] {
  if (!isRecord(value) || typeof value.type !== "string") return [];
  const idPrefix = options.idPrefix ?? "trace";
  let sequence = options.sequence ?? 0;
  const event = (entry: Omit<MonitorTraceEvent, "id">): MonitorTraceEvent => ({
    id: `${idPrefix}-${sequence++}`,
    ...entry,
  });
  const timestamp = traceTimestamp(value);

  switch (value.type) {
    case "agent_start":
      return [event({ kind: "system", label: "Agent", summary: "started", timestamp })];
    case "agent_end":
    case "agent_settled":
      return [event({ kind: "system", label: "Agent", summary: "finished", timestamp })];
    case "turn_start":
      return typeof value.turnIndex === "number"
        ? [event({
            kind: "system",
            label: "Turn",
            summary: `${value.turnIndex + 1} started`,
            timestamp,
          })]
        : [];
    case "tool_execution_start": {
      const toolName = stringValue(value.toolName) ?? "tool";
      const args = isRecord(value.args)
        ? value.args
        : isRecord(value.toolArgs)
          ? value.toolArgs
          : {};
      return [event({
        kind: "tool",
        label: titleCase(toolName),
        summary: summarizeToolArgs(toolName, args),
        timestamp,
        ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
      })];
    }
    case "tool_execution_end": {
      const toolName = stringValue(value.toolName) ?? "tool";
      const failed = value.isError === true;
      return [event({
        kind: failed ? "error" : "result",
        label: failed ? "Error" : "Result",
        summary: summarizeToolResult(value.result, toolName, failed),
        timestamp,
        ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
      })];
    }
    case "tool_result_end": {
      const summary = summarizeMessage(value.message);
      return summary
        ? [event({ kind: "result", label: "Result", summary, timestamp })]
        : [];
    }
    case "message_end":
      return parseCompletedMessage(value.message).map((entry) =>
        event({ ...entry, timestamp: entry.timestamp ?? timestamp })
      );
    case "message_update":
    case "message_start":
    case "tool_execution_update":
    case "turn_end":
      return [];
    default:
      return [];
  }
}

/**
 * Incremental complete-line-only JSONL decoder. Callers may feed arbitrary
 * chunks; a trailing partial line is retained until the next push.
 */
export class PiTraceDecoder {
  private pending = "";
  private sequence = 0;
  private textDecoder = new TextDecoder();

  constructor(private readonly idPrefix = "trace") {}

  push(chunk: string | Uint8Array): MonitorTraceEvent[] {
    this.pending += typeof chunk === "string"
      ? chunk
      : this.textDecoder.decode(chunk, { stream: true });
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return this.decodeLines(lines);
  }

  finish(): MonitorTraceEvent[] {
    const pending = this.pending + this.textDecoder.decode();
    this.pending = "";
    return pending.trim() ? this.decodeLines([pending]) : [];
  }

  reset(): void {
    this.pending = "";
    this.sequence = 0;
    this.textDecoder = new TextDecoder();
  }

  get pendingText(): string {
    return this.pending;
  }

  private decodeLines(lines: readonly string[]): MonitorTraceEvent[] {
    const events: MonitorTraceEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        events.push({
          id: `${this.idPrefix}-${this.sequence++}`,
          kind: "error",
          label: "Trace",
          summary: "malformed JSONL event",
        });
        continue;
      }
      const parsed = parsePiTraceEvent(value, {
        idPrefix: this.idPrefix,
        sequence: this.sequence,
      });
      this.sequence += parsed.length;
      events.push(...parsed);
    }
    return events;
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface FileSample {
  offset: number;
  bytes: Buffer;
}

/**
 * Read-only incremental tailer for a persisted Pi JSONL trace.
 *
 * It remembers a byte offset and lets PiTraceDecoder retain an incomplete
 * trailing line. File replacement, truncation, or mutation of already-read
 * bytes resets decoding and returns reloaded=true so a UI can replace its
 * cached history safely.
 */
export class PiTraceFileTailer {
  private readonly decoder: PiTraceDecoder;
  private identity: FileIdentity | undefined;
  private byteOffset = 0;
  private samples: FileSample[] = [];
  private modifiedAtMs: number | undefined;

  constructor(
    readonly filePath: string,
    idPrefix = "trace",
  ) {
    this.decoder = new PiTraceDecoder(idPrefix);
  }

  get offset(): number {
    return this.byteOffset;
  }

  poll(): TraceTailPoll {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const reloaded = this.identity !== undefined || this.byteOffset !== 0;
      this.reset();
      return { events: [], reloaded, offset: 0, missing: true };
    }
    if (!stat.isFile()) {
      throw new Error(`Pi trace is not a regular file: ${this.filePath}`);
    }

    const nextIdentity = { dev: stat.dev, ino: stat.ino };
    const reload =
      this.identity === undefined ||
      !sameIdentity(this.identity, nextIdentity) ||
      stat.size < this.byteOffset ||
      (stat.size === this.byteOffset &&
        this.modifiedAtMs !== undefined &&
        stat.mtimeMs !== this.modifiedAtMs) ||
      !this.samplesMatch(stat.size);
    if (reload) {
      this.decoder.reset();
      this.byteOffset = 0;
      this.samples = [];
    }
    this.identity = nextIdentity;
    this.modifiedAtMs = stat.mtimeMs;

    const available = Math.max(0, stat.size - this.byteOffset);
    const bytes = available > 0
      ? readFileRange(this.filePath, this.byteOffset, available)
      : Buffer.alloc(0);
    this.byteOffset += bytes.length;
    const events = bytes.length > 0 ? this.decoder.push(bytes) : [];
    this.samples = captureSamples(this.filePath, this.byteOffset);
    return {
      events,
      reloaded: reload,
      offset: this.byteOffset,
    };
  }

  reset(): void {
    this.decoder.reset();
    this.identity = undefined;
    this.byteOffset = 0;
    this.samples = [];
    this.modifiedAtMs = undefined;
  }

  private samplesMatch(fileSize: number): boolean {
    for (const sample of this.samples) {
      if (sample.offset + sample.bytes.length > fileSize) return false;
      const current = readFileRange(this.filePath, sample.offset, sample.bytes.length);
      if (!current.equals(sample.bytes)) return false;
    }
    return true;
  }
}

function parseCompletedMessage(
  value: unknown,
): Array<Omit<MonitorTraceEvent, "id">> {
  if (!isRecord(value) || typeof value.role !== "string") return [];
  if (value.role !== "assistant") return [];
  const timestamp = traceTimestamp(value);
  const blocks = Array.isArray(value.content) ? value.content : [];
  const entries: Array<Omit<MonitorTraceEvent, "id">> = [];

  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const summary = compactText(block.thinking);
      if (summary) entries.push({ kind: "thought", label: "Thought", summary, timestamp });
    } else if (block.type === "text" && typeof block.text === "string") {
      const summary = compactText(block.text);
      if (!summary) continue;
      entries.push({
        kind: "assistant",
        label: "Assistant",
        summary,
        timestamp,
      });
    }
  }

  if (entries.length === 0 && typeof value.errorMessage === "string") {
    entries.push({
      kind: "error",
      label: "Error",
      summary: compactText(value.errorMessage),
      timestamp,
    });
  }
  return entries;
}

function summarizeMessage(value: unknown): string {
  if (!isRecord(value)) return "";
  if (Array.isArray(value.content)) {
    const text = value.content
      .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
      .filter(Boolean)
      .join(" ");
    if (text) return compactText(text);
  }
  return typeof value.errorMessage === "string" ? compactText(value.errorMessage) : "";
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const normalized = toolName.toLowerCase();
  const preferredKeys = normalized === "bash"
    ? ["command", "cmd"]
    : normalized === "read" || normalized === "write" || normalized === "edit"
      ? ["path", "filePath"]
      : normalized.includes("search")
        ? ["query", "pattern", "path"]
        : ["path", "filePath", "query", "command", "cmd", "pattern"];
  for (const key of preferredKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return compactText(value);
  }
  const fields = Object.entries(args)
    .filter(([, value]) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
    .slice(0, 2)
    .map(([key, value]) => `${key}=${String(value)}`);
  return fields.length > 0 ? compactText(fields.join(" · ")) : "started";
}

function summarizeToolResult(value: unknown, toolName: string, failed: boolean): string {
  const prefix = failed ? `${titleCase(toolName)} failed` : `${titleCase(toolName)} complete`;
  const detail = extractText(value);
  return detail ? `${prefix} · ${compactText(detail)}` : prefix;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(" ");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) return extractText(value.content);
  if (typeof value.output === "string") return value.output;
  if (typeof value.error === "string") return value.error;
  return "";
}

function traceTimestamp(value: Record<string, unknown>): number | string | undefined {
  const timestamp = value.timestamp;
  if (typeof timestamp === "number" || typeof timestamp === "string") return timestamp;
  return undefined;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureSamples(filePath: string, byteOffset: number): FileSample[] {
  const sampleLength = Math.min(64, byteOffset);
  if (sampleLength <= 0) return [];
  const maximumStart = byteOffset - sampleLength;
  const starts = new Set([
    0,
    Math.floor(maximumStart / 4),
    Math.floor(maximumStart / 2),
    Math.floor(maximumStart * 3 / 4),
    maximumStart,
  ]);
  return [...starts]
    .sort((left, right) => left - right)
    .map((offset) => ({
      offset,
      bytes: readFileRange(filePath, offset, sampleLength),
    }));
}

function readFileRange(filePath: string, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const file = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(file, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(file);
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
