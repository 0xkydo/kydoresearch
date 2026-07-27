import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  AgentMonitorModel,
  renderAgentMonitor,
  type MonitorAgent,
} from "../extensions/autoresearch/agent-monitor.ts";
import type { MonitorTraceEvent } from "../extensions/autoresearch/trace-view.ts";

describe("AgentMonitorModel", () => {
  it("preserves selection by invocation ID and freezes row order during navigation", () => {
    const model = new AgentMonitorModel([
      agent("old", "complete", 1),
      agent("live", "running", 2),
    ]);
    expect(model.snapshot().orderedInvocationIds).toEqual(["live", "old"]);
    model.selectInvocation("old");
    model.setNavigationActive(true);

    model.updateAgents([
      agent("old", "running", 20),
      agent("live", "complete", 2),
      agent("new", "running", 30),
    ]);

    expect(model.snapshot().orderedInvocationIds).toEqual(["live", "old", "new"]);
    expect(model.selectedInvocationId).toBe("old");

    model.setNavigationActive(false);
    expect(model.snapshot().orderedInvocationIds).toEqual(["new", "old", "live"]);
    expect(model.selectedInvocationId).toBe("old");
  });

  it("supports overview/focus transitions and adjacent invocations in one family", () => {
    const model = new AgentMonitorModel([
      agent("phd-1", "complete", 1, { candidateId: "candidate-a" }),
      agent("phd-2", "running", 2, { candidateId: "candidate-a" }),
      agent("phd-other", "running", 3, { candidateId: "candidate-b" }),
    ]);
    model.selectInvocation("phd-1");

    expect(model.enterFocus()).toBe(true);
    expect(model.mode).toBe("focus");
    expect(model.switchInvocation(1)).toBe(true);
    expect(model.selectedInvocationId).toBe("phd-2");
    expect(model.switchInvocation(1)).toBe(false);

    model.exitFocus();
    expect(model.mode).toBe("overview");
  });

  it("follows the trace tail until the operator scrolls into history", () => {
    const model = new AgentMonitorModel([
      agent("phd-1", "running", 1, { trace: trace(7) }),
    ]);
    model.enterFocus();

    expect(model.visibleTrace(3).map((event) => event.summary)).toEqual(["event 4", "event 5", "event 6"]);
    model.scrollTrace(-2, 3);
    expect(model.followLatest).toBe(false);
    expect(model.visibleTrace(3).map((event) => event.summary)).toEqual(["event 2", "event 3", "event 4"]);

    model.updateAgents([
      agent("phd-1", "running", 2, { trace: trace(8) }),
    ]);
    expect(model.visibleTrace(3).map((event) => event.summary)).toEqual(["event 2", "event 3", "event 4"]);

    model.traceEnd();
    expect(model.followLatest).toBe(true);
    expect(model.visibleTrace(3).map((event) => event.summary)).toEqual(["event 5", "event 6", "event 7"]);
  });

  it("falls back to another live invocation when the selected ID disappears", () => {
    const model = new AgentMonitorModel([
      agent("first", "complete", 1),
      agent("second", "running", 2),
    ]);
    model.selectInvocation("first");
    model.updateAgents([agent("second", "running", 3)]);
    expect(model.selectedInvocationId).toBe("second");
  });
});

describe("renderAgentMonitor", () => {
  it("renders a compact one-frame overview and keeps the selected overflow row visible", () => {
    const agents = Array.from({ length: 9 }, (_, index) =>
      agent(`agent-${index}`, "running", index, {
        activity: `working on item ${index}`,
      })
    );
    const model = new AgentMonitorModel(agents);
    model.setNavigationActive(true);
    model.selectInvocation("agent-4");

    const lines = renderAgentMonitor(model, 56, { height: 7 });
    const rendered = lines.join("\n");
    expect(lines).toHaveLength(7);
    expect(lines.every((line) => visibleWidth(line) === 56)).toBe(true);
    expect(rendered).toContain("▸ ● PhD agent-4");
    expect(rendered).toContain("earlier");
    expect(rendered).toContain("later");
    expect(rendered.match(/^╭/gm)).toHaveLength(1);
    expect(rendered.match(/^╰/gm)).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("│ "))).toBe(true);
  });

  it("renders Focus in the same bounded frame at narrow widths", () => {
    const model = new AgentMonitorModel([
      agent("phd-loop-4-idea-1", "running", 1, {
        attempt: 2,
        maxAttempts: 3,
        tokens: 67_000,
        durationMs: 192_000,
        trace: [
          {
            id: "trace-1",
            kind: "tool",
            label: "Read",
            summary: "src/cache.ts",
            timestamp: "2026-07-26T14:31:08.000Z",
          },
          {
            id: "trace-2",
            kind: "thought",
            label: "Thought",
            summary: "The cache key omits the device capability.",
          },
        ],
      }),
    ]);
    model.enterFocus();

    const lines = renderAgentMonitor(model, 42, { height: 7 });
    const rendered = lines.join("\n");
    expect(lines).toHaveLength(7);
    expect(lines.every((line) => visibleWidth(line) === 42)).toBe(true);
    expect(rendered).toContain("Focus");
    expect(rendered).toContain("Read");
    expect(rendered).toContain("Thought");
    expect(rendered).toContain("67k tokens");
    expect(rendered).toContain("PgUp/PgDn");
  });

  it("renders an empty monitor without changing frame density", () => {
    const lines = renderAgentMonitor(new AgentMonitorModel(), 36, { height: 4 });
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("No agent activity yet");
    expect(lines.every((line) => visibleWidth(line) === 36)).toBe(true);
  });
});

function agent(
  invocationId: string,
  status: string,
  updatedAt: number,
  overrides: Partial<MonitorAgent> = {},
): MonitorAgent {
  return {
    invocationId,
    role: "PhD",
    status,
    updatedAt,
    ...overrides,
  };
}

function trace(length: number): MonitorTraceEvent[] {
  return Array.from({ length }, (_, index) => ({
    id: `trace-${index}`,
    kind: "assistant",
    label: "Assistant",
    summary: `event ${index}`,
  }));
}
