import * as fs from "node:fs";
import * as path from "node:path";

export type TelemetryOutcome = "ok" | "error" | "aborted";

export interface TelemetryContext {
  loop?: number;
  ideaId?: string;
  attempt?: number;
  scope?: "init" | "idea" | "main" | "loop";
}

export interface TelemetrySpan extends TelemetryContext {
  version: 1;
  flow: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: TelemetryOutcome;
}

export interface TelemetryAggregate {
  flow: string;
  count: number;
  ok: number;
  errors: number;
  aborted: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
}

/**
 * Append-only, local-only timing telemetry. Records deliberately contain no
 * prompts, command output, paths, environment values, or model responses.
 */
export class LocalTelemetry {
  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async measure<T>(
    flow: string,
    context: TelemetryContext,
    task: () => Promise<T>,
    classify: (result: T) => TelemetryOutcome = () => "ok",
  ): Promise<T> {
    const startedMs = this.now();
    let outcome: TelemetryOutcome = "error";
    try {
      const result = await task();
      outcome = classify(result);
      return result;
    } finally {
      const endedMs = this.now();
      this.append({
        version: 1,
        flow,
        ...context,
        startedAt: new Date(startedMs).toISOString(),
        endedAt: new Date(endedMs).toISOString(),
        durationMs: Math.max(0, endedMs - startedMs),
        outcome,
      });
    }
  }

  private append(span: TelemetrySpan): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(span)}\n`);
  }
}

export function readTelemetry(filePath: string): TelemetrySpan[] {
  if (!fs.existsSync(filePath)) return [];
  const spans: TelemetrySpan[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const span = JSON.parse(line) as Partial<TelemetrySpan>;
      if (
        span.version === 1 &&
        typeof span.flow === "string" &&
        typeof span.startedAt === "string" &&
        typeof span.endedAt === "string" &&
        typeof span.durationMs === "number" &&
        Number.isFinite(span.durationMs) &&
        (span.outcome === "ok" || span.outcome === "error" || span.outcome === "aborted")
      ) {
        spans.push(span as TelemetrySpan);
      }
    } catch {
      // An interrupted final append must not hide earlier valid telemetry.
    }
  }
  return spans;
}

export function aggregateTelemetry(spans: TelemetrySpan[]): TelemetryAggregate[] {
  const byFlow = new Map<string, TelemetryAggregate>();
  for (const span of spans) {
    const aggregate = byFlow.get(span.flow) ?? {
      flow: span.flow,
      count: 0,
      ok: 0,
      errors: 0,
      aborted: 0,
      totalMs: 0,
      averageMs: 0,
      maxMs: 0,
    };
    aggregate.count += 1;
    aggregate[span.outcome === "error" ? "errors" : span.outcome] += 1;
    aggregate.totalMs += span.durationMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, span.durationMs);
    byFlow.set(span.flow, aggregate);
  }
  return [...byFlow.values()]
    .map((aggregate) => ({
      ...aggregate,
      averageMs: aggregate.count === 0 ? 0 : aggregate.totalMs / aggregate.count,
    }))
    .sort((left, right) => right.totalMs - left.totalMs || left.flow.localeCompare(right.flow));
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  if (durationMs < 3_600_000) {
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.round((durationMs % 60_000) / 1_000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.round((durationMs % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function renderTelemetryReport(spans: TelemetrySpan[]): string {
  if (spans.length === 0) {
    return "local telemetry · no completed flows recorded yet\nRun /autoresearch to start collecting timings.";
  }
  const aggregates = aggregateTelemetry(spans);
  const rows = aggregates.map((aggregate) => {
    const failures = aggregate.errors + aggregate.aborted;
    return `${aggregate.flow.padEnd(20)} ${String(aggregate.count).padStart(4)}  ${formatDuration(aggregate.totalMs).padStart(8)}  ${formatDuration(aggregate.averageMs).padStart(8)}  ${formatDuration(aggregate.maxMs).padStart(8)}  ${String(failures).padStart(4)}`;
  });
  return [
    `local telemetry · ${spans.length} completed flow(s)`,
    "flow                 runs     total       avg       max  fail",
    ...rows,
    "",
    "Totals can overlap because PhD flows run in parallel; loop.total is wall-clock time.",
    "Stored only in .autoresearch/telemetry.ndjson.",
  ].join("\n");
}
