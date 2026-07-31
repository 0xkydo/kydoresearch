import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorTraceEvent } from "./trace-view.ts";

export type AgentMonitorMode = "overview" | "focus";

/**
 * Narrow structural input for the monitor. The durable activity projection can
 * supply richer records; the monitor deliberately owns no persistence types.
 */
export interface MonitorAgent {
  invocationId: string;
  role: string;
  status: string;
  activity?: string;
  stage?: string;
  progress?: string;
  candidateId?: string;
  invocationGroup?: string;
  attempt?: number;
  maxAttempts?: number;
  startedAt?: number | string;
  updatedAt?: number | string;
  tokens?: number;
  tokensComplete?: boolean;
  durationMs?: number;
  trace?: readonly MonitorTraceEvent[];
}

export interface AgentMonitorSnapshot {
  mode: AgentMonitorMode;
  navigationActive: boolean;
  selectedInvocationId?: string;
  orderedInvocationIds: readonly string[];
  followLatest: boolean;
  traceScrollTop: number;
}

export interface RenderAgentMonitorOptions {
  /** Total frame height, including top and bottom borders. */
  height?: number;
}

export class AgentMonitorModel {
  private agentsById = new Map<string, MonitorAgent>();
  private order: string[] = [];
  private frozenOrder: string[] | undefined;
  private selectedId: string | undefined;
  private viewMode: AgentMonitorMode = "overview";
  private navigation = false;
  private follow = true;
  private traceTop = 0;

  constructor(agents: readonly MonitorAgent[] = []) {
    this.updateAgents(agents);
  }

  get mode(): AgentMonitorMode {
    return this.viewMode;
  }

  get navigationActive(): boolean {
    return this.navigation;
  }

  get selectedInvocationId(): string | undefined {
    return this.selectedId;
  }

  get selectedAgent(): MonitorAgent | undefined {
    return this.selectedId ? this.agentsById.get(this.selectedId) : undefined;
  }

  get orderedAgents(): readonly MonitorAgent[] {
    return this.order
      .map((id) => this.agentsById.get(id))
      .filter((agent): agent is MonitorAgent => agent !== undefined);
  }

  get followLatest(): boolean {
    return this.follow;
  }

  get traceScrollTop(): number {
    return this.traceTop;
  }

  snapshot(): AgentMonitorSnapshot {
    return {
      mode: this.viewMode,
      navigationActive: this.navigation,
      ...(this.selectedId ? { selectedInvocationId: this.selectedId } : {}),
      orderedInvocationIds: [...this.order],
      followLatest: this.follow,
      traceScrollTop: this.traceTop,
    };
  }

  updateAgents(agents: readonly MonitorAgent[]): void {
    const next = new Map<string, MonitorAgent>();
    for (const agent of agents) {
      if (
        !agent.invocationId.trim() ||
        next.has(agent.invocationId) ||
        !isActive(agent.status)
      ) {
        continue;
      }
      next.set(agent.invocationId, agent);
    }

    const previousIndex = this.selectedId ? this.order.indexOf(this.selectedId) : 0;
    this.agentsById = next;
    if (this.frozenOrder) {
      const retained = this.frozenOrder.filter((id) => next.has(id));
      const known = new Set(retained);
      const appended = sortAgents([...next.values()].filter((agent) => !known.has(agent.invocationId)))
        .map((agent) => agent.invocationId);
      this.frozenOrder = [...retained, ...appended];
      this.order = [...this.frozenOrder];
    } else {
      this.order = sortAgents([...next.values()]).map((agent) => agent.invocationId);
    }

    if (!this.selectedId || !next.has(this.selectedId)) {
      const fallbackIndex = clamp(previousIndex, 0, Math.max(0, this.order.length - 1));
      this.selectedId = firstLiveId(this.order, next) ?? this.order[fallbackIndex];
      this.resetTracePosition();
    } else {
      this.clampTracePosition();
    }
    if (this.order.length === 0) {
      this.selectedId = undefined;
      this.viewMode = "overview";
    }
  }

  setNavigationActive(active: boolean): void {
    if (active === this.navigation) return;
    this.navigation = active;
    if (active) {
      this.frozenOrder = [...this.order];
    } else {
      this.frozenOrder = undefined;
      this.order = sortAgents([...this.agentsById.values()])
        .map((agent) => agent.invocationId);
    }
  }

  selectInvocation(invocationId: string): boolean {
    if (!this.agentsById.has(invocationId)) return false;
    if (this.selectedId !== invocationId) {
      this.selectedId = invocationId;
      this.resetTracePosition();
    }
    return true;
  }

  selectBy(delta: number): boolean {
    if (this.order.length === 0 || delta === 0) return false;
    const current = this.selectedId ? this.order.indexOf(this.selectedId) : -1;
    const target = clamp(current < 0 ? 0 : current + delta, 0, this.order.length - 1);
    return this.selectInvocation(this.order[target]!);
  }

  selectFirst(): boolean {
    return this.order[0] ? this.selectInvocation(this.order[0]) : false;
  }

  selectLast(): boolean {
    const id = this.order.at(-1);
    return id ? this.selectInvocation(id) : false;
  }

  selectFirstLive(): boolean {
    const id = firstLiveId(this.order, this.agentsById);
    return id ? this.selectInvocation(id) : this.selectFirst();
  }

  enterFocus(): boolean {
    if (!this.selectedAgent) return false;
    this.viewMode = "focus";
    this.resetTracePosition();
    return true;
  }

  exitFocus(): void {
    this.viewMode = "overview";
  }

  switchInvocation(delta: -1 | 1): boolean {
    const selected = this.selectedAgent;
    if (!selected) return false;
    const family = invocationFamily(selected);
    const related = [...this.agentsById.values()]
      .filter((agent) => invocationFamily(agent) === family)
      .sort((left, right) =>
        timeValue(left.startedAt) - timeValue(right.startedAt) ||
        left.invocationId.localeCompare(right.invocationId)
      );
    const current = related.findIndex((agent) => agent.invocationId === selected.invocationId);
    const target = related[current + delta];
    return target ? this.selectInvocation(target.invocationId) : false;
  }

  scrollTrace(delta: number, viewportLines: number): void {
    const maxTop = this.maxTraceTop(viewportLines);
    const currentTop = this.follow ? maxTop : clamp(this.traceTop, 0, maxTop);
    this.traceTop = clamp(currentTop + delta, 0, maxTop);
    this.follow = this.traceTop === maxTop;
  }

  pageTrace(direction: -1 | 1, viewportLines: number): void {
    this.scrollTrace(direction * Math.max(1, viewportLines - 1), viewportLines);
  }

  traceHome(): void {
    this.traceTop = 0;
    this.follow = false;
  }

  traceEnd(): void {
    this.follow = true;
    this.traceTop = Number.MAX_SAFE_INTEGER;
  }

  visibleTrace(viewportLines: number): readonly MonitorTraceEvent[] {
    const trace = this.selectedAgent?.trace ?? [];
    const capacity = Math.max(0, viewportLines);
    if (capacity === 0) return [];
    const maxTop = Math.max(0, trace.length - capacity);
    const top = this.follow ? maxTop : clamp(this.traceTop, 0, maxTop);
    return trace.slice(top, top + capacity);
  }

  private maxTraceTop(viewportLines: number): number {
    return Math.max(0, (this.selectedAgent?.trace?.length ?? 0) - Math.max(0, viewportLines));
  }

  private resetTracePosition(): void {
    this.follow = true;
    this.traceTop = Number.MAX_SAFE_INTEGER;
  }

  private clampTracePosition(): void {
    if (!this.follow) {
      this.traceTop = clamp(
        this.traceTop,
        0,
        Math.max(0, (this.selectedAgent?.trace?.length ?? 0) - 1),
      );
    }
  }
}

export function renderAgentMonitor(
  model: AgentMonitorModel,
  requestedWidth: number,
  options: RenderAgentMonitorOptions = {},
): string[] {
  const width = Math.max(12, Math.floor(requestedWidth));
  const requestedHeight = options.height ?? 8;
  const minimumHeight = model.mode === "focus" ? 5 : 3;
  const height = Math.max(minimumHeight, Math.floor(requestedHeight));
  return model.mode === "focus"
    ? renderFocus(model, width, height)
    : renderOverview(model, width, height);
}

function renderOverview(
  model: AgentMonitorModel,
  width: number,
  height: number,
): string[] {
  const agents = model.orderedAgents;
  const running = agents.filter((agent) => isLive(agent.status)).length;
  const waiting = agents.filter((agent) => agent.status.toLowerCase() === "waiting").length;
  const suffix = agents.length === 0
    ? "no agents"
    : [
        running > 0 ? `${running} running` : "",
        waiting > 0 ? `${waiting} waiting` : "",
      ].filter(Boolean).join(" · ") || `${agents.length} agents`;
  const lines = [topBorder(`Agent Monitor · Overview · ${suffix}`, width)];
  const interior = height - 2;
  const entries = rosterWindow(
    agents,
    model.selectedInvocationId,
    interior,
  );
  if (entries.length === 0) {
    lines.push(contentLine("No active agents", width));
  } else {
    for (const entry of entries) {
      if ("omitted" in entry) {
        lines.push(contentLine(`… ${entry.omitted} ${entry.side}`, width));
      } else {
        lines.push(contentLine(renderAgentRow(entry, model.selectedInvocationId, width - 4), width));
      }
    }
  }
  while (lines.length < height - 1) lines.push(contentLine("", width));
  lines.push(bottomBorder(width));
  return lines;
}

function renderFocus(
  model: AgentMonitorModel,
  width: number,
  height: number,
): string[] {
  const agent = model.selectedAgent;
  if (!agent) {
    model.exitFocus();
    return renderOverview(model, width, height);
  }
  const state = agent.progress || agent.stage || agent.status;
  const live = isLive(agent.status) ? " · LIVE" : "";
  const title = `Agent Monitor · Focus · ${agent.role} ${agentLabel(agent)} · ${state}${live}`;
  const traceCapacity = Math.max(1, height - 4);
  const trace = model.visibleTrace(traceCapacity);
  const lines = [topBorder(title, width)];
  if (trace.length === 0) {
    lines.push(contentLine("Waiting for trace events…", width));
  } else {
    for (const event of trace) {
      lines.push(contentLine(renderTraceEvent(event, width - 4), width));
    }
  }
  while (lines.length < height - 3) lines.push(contentLine("", width));
  lines.push(separatorLine(focusStats(agent, model.followLatest), width));
  lines.push(contentLine("PgUp/PgDn scroll · ←→ invocation · Esc overview", width));
  lines.push(bottomBorder(width));
  return lines;
}

type RosterEntry =
  | MonitorAgent
  | { omitted: number; side: "earlier" | "later" };

function rosterWindow(
  agents: readonly MonitorAgent[],
  selectedId: string | undefined,
  capacity: number,
): RosterEntry[] {
  if (capacity <= 0 || agents.length === 0) return [];
  if (agents.length <= capacity) return [...agents];
  const selected = Math.max(0, agents.findIndex((agent) => agent.invocationId === selectedId));
  if (capacity === 1) return [agents[selected]!];

  let realCapacity = Math.max(1, capacity - 2);
  let start = clamp(selected - Math.floor(realCapacity / 2), 0, agents.length - realCapacity);
  let end = start + realCapacity;
  if (start === 0) {
    realCapacity = capacity - 1;
    end = realCapacity;
  } else if (end === agents.length) {
    realCapacity = capacity - 1;
    start = agents.length - realCapacity;
    end = agents.length;
  }

  const entries: RosterEntry[] = [];
  if (start > 0) entries.push({ omitted: start, side: "earlier" });
  entries.push(...agents.slice(start, end));
  if (end < agents.length) entries.push({ omitted: agents.length - end, side: "later" });
  return entries.slice(0, capacity);
}

function renderAgentRow(
  agent: MonitorAgent,
  selectedId: string | undefined,
  width: number,
): string {
  const cursor = agent.invocationId === selectedId ? "▸" : " ";
  const glyph = isLive(agent.status) ? "●" : "◌";
  const state = agent.progress || agent.stage || agent.status;
  const attempt = agent.attempt !== undefined
    ? ` ${agent.attempt}${agent.maxAttempts !== undefined ? `/${agent.maxAttempts}` : ""}`
    : "";
  const activity = compact(agent.activity ?? "");
  const label = agentLabel(agent);
  const variants = [
    `${cursor} ${glyph} ${agent.role} ${label}  ${state}${attempt}${activity ? `  ${activity}` : ""}`,
    `${cursor} ${glyph} ${label}  ${state}${attempt}${activity ? `  ${activity}` : ""}`,
    `${cursor}${glyph} ${label} ${state}${activity ? ` ${activity}` : ""}`,
  ];
  const selected = variants.find((variant) => visibleWidth(variant) <= width) ?? variants.at(-1)!;
  return truncateToWidth(selected, width);
}

function agentLabel(agent: MonitorAgent): string {
  if (agent.candidateId) return agent.candidateId;
  return agent.invocationId.length <= 18
    ? agent.invocationId
    : `${agent.invocationId.slice(0, 15)}…`;
}

function renderTraceEvent(event: MonitorTraceEvent, width: number): string {
  const time = formatTime(event.timestamp);
  const full = `${time ? `${time}  ` : ""}${event.label.padEnd(9)} ${compact(event.summary)}`;
  if (visibleWidth(full) <= width) return full;
  const withoutTime = `${event.label.padEnd(9)} ${compact(event.summary)}`;
  return truncateToWidth(visibleWidth(withoutTime) <= width ? withoutTime : withoutTime, width);
}

function focusStats(agent: MonitorAgent, following: boolean): string {
  const attempt = agent.attempt !== undefined
    ? `attempt ${agent.attempt}${agent.maxAttempts !== undefined ? `/${agent.maxAttempts}` : ""}`
    : "";
  const tokens = agent.tokens !== undefined
    ? `${agent.tokensComplete === false ? "≥" : ""}${formatCount(agent.tokens)} tokens`
    : "";
  const duration = agent.durationMs !== undefined ? formatDuration(agent.durationMs) : "";
  return [
    attempt,
    tokens,
    duration,
    following ? "following latest" : "history",
  ].filter(Boolean).join(" · ");
}

function topBorder(title: string, width: number): string {
  if (width <= 2) return "─".repeat(width);
  const available = Math.max(0, width - 5);
  const label = truncateToWidth(title, available);
  const fill = "─".repeat(Math.max(0, width - visibleWidth(label) - 5));
  return `╭─${label ? ` ${label} ` : ""}${fill}╮`;
}

function bottomBorder(width: number): string {
  return width <= 1 ? "─".repeat(width) : `╰${"─".repeat(width - 2)}╯`;
}

function separatorLine(label: string, width: number): string {
  if (width <= 2) return "─".repeat(width);
  const available = Math.max(0, width - 5);
  const clipped = truncateToWidth(label, available);
  const fill = "─".repeat(Math.max(0, width - visibleWidth(clipped) - 5));
  return `├─${clipped ? ` ${clipped} ` : ""}${fill}┤`;
}

function contentLine(content: string, width: number): string {
  if (width <= 2) return " ".repeat(width);
  const innerWidth = Math.max(0, width - 4);
  const clipped = truncateToWidth(content, innerWidth);
  return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} │`;
}

function sortAgents(agents: MonitorAgent[]): MonitorAgent[] {
  return agents.sort((left, right) =>
    statusRank(left.status) - statusRank(right.status) ||
    timeValue(right.updatedAt ?? right.startedAt) - timeValue(left.updatedAt ?? left.startedAt) ||
    left.invocationId.localeCompare(right.invocationId)
  );
}

function invocationFamily(agent: MonitorAgent): string {
  return agent.invocationGroup ??
    `${agent.role}:${agent.candidateId ?? ""}`;
}

function firstLiveId(
  order: readonly string[],
  agents: ReadonlyMap<string, MonitorAgent>,
): string | undefined {
  return order.find((id) => {
    const agent = agents.get(id);
    return agent ? isLive(agent.status) : false;
  });
}

function statusRank(status: string): number {
  const normalized = status.toLowerCase();
  if (isLive(normalized)) return 0;
  if (normalized === "waiting" || normalized === "queued") return 1;
  if (normalized === "failed" || normalized === "interrupted") return 2;
  return 3;
}

function isLive(status: string): boolean {
  return ["running", "starting", "retrying", "implementing", "verifying", "benchmarking"]
    .includes(status.toLowerCase());
}

function isActive(status: string): boolean {
  const normalized = status.toLowerCase();
  return isLive(normalized) || normalized === "waiting" || normalized === "queued";
}

function timeValue(value: number | string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function formatTime(value: number | string | undefined): string {
  const milliseconds = timeValue(value);
  if (milliseconds <= 0) return "";
  return new Date(milliseconds).toISOString().slice(11, 19);
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}k`;
  return Math.max(0, Math.round(value)).toString();
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m${remainingSeconds}s` : `${remainingSeconds}s`;
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
