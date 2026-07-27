import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentInvocations } from "../src/agent-activity.ts";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { AgentActivityEvent, AgentTask } from "../src/agents/types.ts";

describe("MockAgentRunner activity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes a visible invocation and synthetic trace for a scripted role", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mock-agent-activity-"));
    roots.push(root);
    const stateDir = path.join(root, ".autoresearch");
    const traceDir = path.join(stateDir, "loops", "loop-001", "professor-agent");
    const observed: AgentActivityEvent[] = [];
    const task: AgentTask = {
      role: "professor",
      kind: "propose",
      cwd: root,
      stateDir,
      input: {
        loop: 1,
        maxIdeasPerLoop: 5,
        traceDir,
      },
      activityObserver: (event) => observed.push(event),
    };

    const pending = new MockAgentRunner({ activityDelayMs: 25 }).run(task);

    expect(loadAgentInvocations(stateDir)).toEqual([
      expect.objectContaining({
        role: "professor",
        kind: "propose",
        loop: 1,
        status: "running",
        activity: "forming evidence-backed experiment proposals",
        tracePath: path.join(traceDir, "events.ndjson"),
      }),
    ]);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      structured: { ideas: expect.any(Array) },
    });
    expect(observed.map((event) => event.type)).toEqual([
      "started",
      "activity",
      "terminal",
    ]);
    expect(loadAgentInvocations(stateDir)).toEqual([
      expect.objectContaining({
        role: "professor",
        status: "complete",
      }),
    ]);

    const trace = fs
      .readFileSync(path.join(traceDir, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(trace.map((event) => event.type)).toEqual([
      "agent_start",
      "message_end",
      "agent_end",
    ]);
  });

  it("marks a delayed mock invocation interrupted when the run is stopped", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mock-agent-abort-"));
    roots.push(root);
    const stateDir = path.join(root, ".autoresearch");
    const controller = new AbortController();
    const pending = new MockAgentRunner({ activityDelayMs: 10_000 }).run({
      role: "professor",
      kind: "propose",
      cwd: root,
      stateDir,
      input: { loop: 1, maxIdeasPerLoop: 1 },
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "mock agent aborted",
    });
    expect(loadAgentInvocations(stateDir)).toEqual([
      expect.objectContaining({
        status: "interrupted",
        activity: "mock agent aborted",
      }),
    ]);
  });
});
