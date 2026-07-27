import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentActivityEvent,
  AgentActivityObserver,
  AgentActivityStatus,
  AgentInvocationIdentity,
  AgentTask,
  AgentTokenUsage,
  AgentUsage,
} from "./agents/types.ts";
import { statePaths } from "./state.ts";

export interface AgentInvocationRecordBase {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  recordedAt: string;
  invocationId: string;
}

export type AgentInvocationRecord =
  | (AgentInvocationRecordBase & {
      type: "started";
      invocation: AgentInvocationIdentity;
    })
  | (AgentInvocationRecordBase & {
      type: "activity";
      activity: string;
    })
  | (AgentInvocationRecordBase & {
      type: "usage";
      usage: AgentUsage;
    })
  | (AgentInvocationRecordBase & {
      type: "terminal";
      status: Extract<AgentActivityStatus, "complete" | "failed" | "interrupted">;
      usage: AgentUsage;
      error?: string;
    });

export interface AgentInvocationSummary extends AgentInvocationIdentity {
  status: AgentActivityStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  activity?: string;
  usage: AgentUsage;
}

export interface FoldAgentInvocationOptions {
  /**
   * Treat an invocation with no terminal record as interrupted. Use this only
   * during restart recovery, not while polling an active process.
   */
  markRunningInterrupted?: boolean;
  interruptedAt?: string;
}

export interface AgentUsageSummary extends AgentUsage {
  invocations: number;
  tokens: AgentTokenUsage;
}

/**
 * Resolves stable attribution for a run. Legacy tasks receive a generated ID
 * while explicit identities are checked against the actual task.
 */
export function resolveAgentInvocationIdentity(
  task: AgentTask,
  tracePath?: string,
): AgentInvocationIdentity {
  if (
    task.invocation &&
    (task.invocation.role !== task.role || task.invocation.kind !== task.kind)
  ) {
    throw new Error("agent invocation role/kind does not match the task");
  }
  if (
    tracePath !== undefined &&
    task.invocation?.tracePath !== undefined &&
    resolveAgentTracePath(tracePath, task.stateDir) !==
      resolveAgentTracePath(task.invocation.tracePath, task.stateDir)
  ) {
    throw new Error("agent invocation trace path does not match the task trace path");
  }

  const loop = optionalNonNegativeInteger(task.invocation?.loop ?? task.input.loop);
  const candidateId =
    optionalNonEmptyString(task.invocation?.candidateId) ??
    optionalNonEmptyString(task.input.candidateId) ??
    optionalNonEmptyString(task.input.ideaId);
  const attempt = optionalPositiveInteger(task.invocation?.attempt ?? task.input.attempt);

  return {
    invocationId:
      optionalNonEmptyString(task.invocation?.invocationId) ??
      `${task.role}-${task.kind}-${Date.now()}-${randomUUID()}`,
    role: task.role,
    kind: task.kind,
    ...(loop === undefined ? {} : { loop }),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(tracePath === undefined && task.invocation?.tracePath === undefined
      ? {}
      : {
          tracePath: resolveAgentTracePath(
            tracePath ?? task.invocation!.tracePath!,
            task.stateDir,
          ),
        }),
  };
}

/** Resolve and validate a raw trace path without requiring it to exist yet. */
export function resolveAgentTracePath(configuredPath: string, stateDir: string): string {
  const stateRoot = path.resolve(stateDir);
  const resolved = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(stateRoot, configuredPath);
  const relative = path.relative(stateRoot, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("trace path escapes the autoresearch state directory");
  }
  return resolved;
}

/**
 * Appends one complete JSON line. A crash can leave a partial trailing line;
 * readers deliberately ignore that line during recovery.
 */
export function appendAgentInvocationRecord(
  stateDir: string,
  record: AgentInvocationRecord,
): void {
  validateRecord(record, stateDir);
  const filePath = statePaths(stateDir).agentInvocations;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function readAgentInvocationRecords(stateDir: string): AgentInvocationRecord[] {
  const filePath = statePaths(stateDir).agentInvocations;
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const records: AgentInvocationRecord[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isAgentInvocationRecord(value)) {
        validateRecord(value, stateDir);
        records.push(value);
      }
    } catch {
      // A final incomplete append is recoverable. Ignore malformed records as
      // untrusted data so one damaged line cannot hide subsequent invocations.
    }
  }
  return records;
}

export function foldAgentInvocationRecords(
  records: readonly AgentInvocationRecord[],
  options: FoldAgentInvocationOptions = {},
): AgentInvocationSummary[] {
  const summaries = new Map<string, AgentInvocationSummary>();
  const seenEventIds = new Set<string>();

  for (const record of records) {
    if (seenEventIds.has(record.eventId)) continue;
    seenEventIds.add(record.eventId);

    if (record.type === "started") {
      if (!summaries.has(record.invocationId)) {
        summaries.set(record.invocationId, {
          ...record.invocation,
          status: "running",
          startedAt: record.recordedAt,
          updatedAt: record.recordedAt,
          usage: emptyAgentUsage(),
        });
      }
      continue;
    }

    const summary = summaries.get(record.invocationId);
    if (!summary) continue;
    if (record.sequence < latestSequence(summary)) continue;
    setLatestSequence(summary, record.sequence);
    summary.updatedAt = record.recordedAt;

    if (record.type === "activity") {
      summary.activity = record.activity;
    } else if (record.type === "usage") {
      summary.usage = cloneUsage(record.usage);
    } else {
      summary.status = record.status;
      summary.completedAt = record.recordedAt;
      summary.usage = cloneUsage(record.usage);
      if (record.error) summary.activity = record.error;
    }
  }

  const interruptedAt = options.interruptedAt ?? new Date().toISOString();
  for (const summary of summaries.values()) {
    clearLatestSequence(summary);
    if (options.markRunningInterrupted && summary.status === "running") {
      summary.status = "interrupted";
      summary.completedAt = interruptedAt;
      summary.updatedAt = interruptedAt;
      summary.activity = summary.activity ?? "process ended before a terminal record";
    }
  }
  return [...summaries.values()];
}

export function loadAgentInvocations(
  stateDir: string,
  options: FoldAgentInvocationOptions = {},
): AgentInvocationSummary[] {
  return foldAgentInvocationRecords(readAgentInvocationRecords(stateDir), options);
}

export function summarizeAgentUsage(
  invocations: readonly AgentInvocationSummary[],
): AgentUsageSummary {
  const summary: AgentUsageSummary = {
    cost: 0,
    turns: 0,
    invocations: invocations.length,
    tokens: emptyAgentTokenUsage(true),
  };
  for (const invocation of invocations) {
    summary.cost += invocation.usage.cost;
    summary.turns += invocation.usage.turns;
    const tokens = invocation.usage.tokens;
    if (!tokens) {
      summary.tokens.complete = false;
      continue;
    }
    summary.tokens.input += tokens.input;
    summary.tokens.output += tokens.output;
    summary.tokens.cacheRead += tokens.cacheRead;
    summary.tokens.cacheWrite += tokens.cacheWrite;
    summary.tokens.complete &&= tokens.complete;
  }
  summary.tokens.total =
    summary.tokens.input +
    summary.tokens.output +
    summary.tokens.cacheRead +
    summary.tokens.cacheWrite;
  return summary;
}

/** Usage for inner-loop roles only; setup and the outer meta-harness are excluded. */
export function loadInnerLoopAgentUsage(
  stateDir: string,
  loop: number,
): AgentUsageSummary {
  return summarizeAgentUsage(
    loadAgentInvocations(stateDir).filter(
      (invocation) =>
        invocation.loop === loop &&
        invocation.role !== "setup" &&
        invocation.role !== "metaharness",
    ),
  );
}

export function emptyAgentTokenUsage(complete = true): AgentTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    complete,
  };
}

export function emptyAgentUsage(): AgentUsage {
  return { cost: 0, turns: 0, tokens: emptyAgentTokenUsage() };
}

export function createAgentActivityRecorder(
  stateDir: string,
  identity: AgentInvocationIdentity,
  observer?: AgentActivityObserver,
): {
  start(): AgentActivityEvent;
  activity(activity: string): AgentActivityEvent;
  usage(usage: AgentUsage): AgentActivityEvent;
  terminal(
    status: Extract<AgentActivityStatus, "complete" | "failed" | "interrupted">,
    usage: AgentUsage,
    error?: string,
  ): AgentActivityEvent;
} {
  let sequence = 0;
  let started = false;

  const persistAndPublish = (record: AgentInvocationRecord): AgentActivityEvent => {
    appendAgentInvocationRecord(stateDir, record);
    const event = recordToActivityEvent(record);
    if (observer) {
      try {
        observer(event);
      } catch {
        // Observation is advisory and must not terminate an agent invocation.
      }
    }
    return event;
  };

  const base = (type: AgentInvocationRecord["type"]) => {
    const recordedAt = new Date().toISOString();
    const currentSequence = sequence++;
    return {
      schemaVersion: 1 as const,
      eventId: `${identity.invocationId}:${currentSequence}:${type}`,
      sequence: currentSequence,
      recordedAt,
      invocationId: identity.invocationId,
    };
  };

  const assertStarted = (): void => {
    if (!started) throw new Error("agent invocation activity recorded before start");
  };

  return {
    start() {
      if (started) throw new Error("agent invocation start recorded more than once");
      started = true;
      return persistAndPublish({ ...base("started"), type: "started", invocation: identity });
    },
    activity(activity) {
      assertStarted();
      const compact = compactActivity(activity);
      return persistAndPublish({ ...base("activity"), type: "activity", activity: compact });
    },
    usage(usage) {
      assertStarted();
      return persistAndPublish({
        ...base("usage"),
        type: "usage",
        usage: cloneUsage(usage),
      });
    },
    terminal(status, usage, error) {
      assertStarted();
      return persistAndPublish({
        ...base("terminal"),
        type: "terminal",
        status,
        usage: cloneUsage(usage),
        ...(error === undefined ? {} : { error }),
      });
    },
  };
}

function recordToActivityEvent(record: AgentInvocationRecord): AgentActivityEvent {
  if (record.type === "started") {
    return {
      type: "started",
      invocation: record.invocation,
      timestamp: record.recordedAt,
    };
  }
  if (record.type === "activity") {
    return {
      type: "activity",
      invocationId: record.invocationId,
      activity: record.activity,
      timestamp: record.recordedAt,
    };
  }
  if (record.type === "usage") {
    return {
      type: "usage",
      invocationId: record.invocationId,
      usage: cloneUsage(record.usage),
      timestamp: record.recordedAt,
    };
  }
  return {
    type: "terminal",
    invocationId: record.invocationId,
    status: record.status,
    usage: cloneUsage(record.usage),
    ...(record.error === undefined ? {} : { error: record.error }),
    timestamp: record.recordedAt,
  };
}

function validateRecord(record: AgentInvocationRecord, stateDir: string): void {
  if (!record.eventId.trim() || !record.invocationId.trim()) {
    throw new Error("agent invocation records require non-empty IDs");
  }
  if (!Number.isInteger(record.sequence) || record.sequence < 0) {
    throw new Error("agent invocation record sequence must be a non-negative integer");
  }
  if (record.type === "started") {
    if (record.invocation.invocationId !== record.invocationId) {
      throw new Error("agent invocation record identity mismatch");
    }
    if (record.invocation.tracePath) {
      resolveAgentTracePath(record.invocation.tracePath, stateDir);
    }
  }
}

function isAgentInvocationRecord(value: unknown): value is AgentInvocationRecord {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    typeof value.eventId !== "string" ||
    typeof value.invocationId !== "string" ||
    typeof value.sequence !== "number" ||
    typeof value.recordedAt !== "string" ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  if (value.type === "started") {
    return isRecord(value.invocation) &&
      value.invocation.invocationId === value.invocationId &&
      typeof value.invocation.role === "string" &&
      typeof value.invocation.kind === "string";
  }
  if (value.type === "activity") return typeof value.activity === "string";
  if (value.type === "usage") return isAgentUsage(value.usage);
  if (value.type === "terminal") {
    return (
      (value.status === "complete" ||
        value.status === "failed" ||
        value.status === "interrupted") &&
      isAgentUsage(value.usage)
    );
  }
  return false;
}

function isAgentUsage(value: unknown): value is AgentUsage {
  if (!isRecord(value)) return false;
  return (
    finiteNonNegative(value.cost) &&
    Number.isInteger(value.turns) &&
    Number(value.turns) >= 0 &&
    (value.tokens === undefined || isAgentTokenUsage(value.tokens))
  );
}

function isAgentTokenUsage(value: unknown): value is AgentTokenUsage {
  if (!isRecord(value)) return false;
  return (
    finiteNonNegative(value.input) &&
    finiteNonNegative(value.output) &&
    finiteNonNegative(value.cacheRead) &&
    finiteNonNegative(value.cacheWrite) &&
    finiteNonNegative(value.total) &&
    typeof value.complete === "boolean"
  );
}

function compactActivity(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function cloneUsage(usage: AgentUsage): AgentUsage {
  return {
    cost: usage.cost,
    turns: usage.turns,
    ...(usage.tokens === undefined ? {} : { tokens: { ...usage.tokens } }),
  };
}

const LATEST_SEQUENCE = Symbol("latestAgentActivitySequence");
type SummaryWithSequence = AgentInvocationSummary & { [LATEST_SEQUENCE]?: number };

function latestSequence(summary: AgentInvocationSummary): number {
  return (summary as SummaryWithSequence)[LATEST_SEQUENCE] ?? 0;
}

function setLatestSequence(summary: AgentInvocationSummary, sequence: number): void {
  (summary as SummaryWithSequence)[LATEST_SEQUENCE] = sequence;
}

function clearLatestSequence(summary: AgentInvocationSummary): void {
  delete (summary as SummaryWithSequence)[LATEST_SEQUENCE];
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
