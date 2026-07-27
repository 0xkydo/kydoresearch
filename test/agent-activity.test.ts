import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAgentInvocationRecord,
  createAgentActivityRecorder,
  foldAgentInvocationRecords,
  loadInnerLoopAgentUsage,
  loadAgentInvocations,
  readAgentInvocationRecords,
  resolveAgentInvocationIdentity,
} from "../src/agent-activity.ts";
import type {
  AgentActivityEvent,
  AgentInvocationIdentity,
  AgentTask,
} from "../src/agents/types.ts";
import { statePaths } from "../src/state.ts";

describe("agent activity index", () => {
  let root: string;
  let stateDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-"));
    stateDir = path.join(root, ".autoresearch");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("derives attribution while preserving an explicit stable identity", () => {
    const task = makeTask({
      invocation: {
        invocationId: "invoke-17",
        role: "phd",
        kind: "implement",
        loop: 4,
        candidateId: "L004-I2",
        attempt: 2,
      },
    });

    expect(
      resolveAgentInvocationIdentity(
        task,
        path.join(stateDir, "runs", "L004-I2", "agent", "events.ndjson"),
      ),
    ).toEqual({
      invocationId: "invoke-17",
      role: "phd",
      kind: "implement",
      loop: 4,
      candidateId: "L004-I2",
      attempt: 2,
      tracePath: path.join(
        stateDir,
        "runs",
        "L004-I2",
        "agent",
        "events.ndjson",
      ),
    });
  });

  it("rejects mismatched attribution and trace paths outside stateDir", () => {
    expect(() =>
      resolveAgentInvocationIdentity({
        ...makeTask(),
        invocation: {
          invocationId: "wrong-role",
          role: "professor",
          kind: "implement",
        },
      }),
    ).toThrow(/role\/kind does not match/i);

    expect(() =>
      resolveAgentInvocationIdentity(
        makeTask(),
        path.join(root, "outside", "events.ndjson"),
      ),
    ).toThrow(/trace path escapes/i);
  });

  it("appends lifecycle records, publishes after persistence, and folds summaries", () => {
    const observed: AgentActivityEvent[] = [];
    const persistenceVisible: boolean[] = [];
    const identity = makeIdentity();
    const recorder = createAgentActivityRecorder(stateDir, identity, (event) => {
      observed.push(event);
      persistenceVisible.push(fs.existsSync(statePaths(stateDir).agentInvocations));
    });

    recorder.start();
    recorder.activity("  running   focused\n tests ");
    recorder.usage({
      cost: 0.25,
      turns: 1,
      tokens: {
        input: 10,
        output: 4,
        cacheRead: 20,
        cacheWrite: 2,
        total: 36,
        complete: true,
      },
    });
    recorder.terminal("complete", {
      cost: 0.25,
      turns: 1,
      tokens: {
        input: 10,
        output: 4,
        cacheRead: 20,
        cacheWrite: 2,
        total: 36,
        complete: true,
      },
    });

    expect(persistenceVisible).toEqual([true, true, true, true]);
    expect(observed.map((event) => event.type)).toEqual([
      "started",
      "activity",
      "usage",
      "terminal",
    ]);
    expect(loadAgentInvocations(stateDir)).toEqual([
      expect.objectContaining({
        ...identity,
        status: "complete",
        activity: "running focused tests",
        usage: {
          cost: 0.25,
          turns: 1,
          tokens: {
            input: 10,
            output: 4,
            cacheRead: 20,
            cacheWrite: 2,
            total: 36,
            complete: true,
          },
        },
        completedAt: expect.any(String),
      }),
    ]);
  });

  it("deduplicates event IDs and ignores malformed or partial records", () => {
    const identity = makeIdentity();
    const recorder = createAgentActivityRecorder(stateDir, identity);
    recorder.start();
    recorder.activity("editing src/cache.ts");
    const records = readAgentInvocationRecords(stateDir);
    appendAgentInvocationRecord(stateDir, records[1]!);
    fs.appendFileSync(
      statePaths(stateDir).agentInvocations,
      '{"schemaVersion":1,"type":"terminal"',
    );

    expect(readAgentInvocationRecords(stateDir)).toHaveLength(3);
    expect(loadAgentInvocations(stateDir)).toEqual([
      expect.objectContaining({
        invocationId: identity.invocationId,
        status: "running",
        activity: "editing src/cache.ts",
      }),
    ]);
  });

  it("can project unfinished invocations as interrupted during restart recovery", () => {
    const recorder = createAgentActivityRecorder(stateDir, makeIdentity());
    recorder.start();
    recorder.activity("waiting for benchmark lock");

    expect(
      loadAgentInvocations(stateDir, {
        markRunningInterrupted: true,
        interruptedAt: "2026-07-26T12:00:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        status: "interrupted",
        activity: "waiting for benchmark lock",
        completedAt: "2026-07-26T12:00:00.000Z",
      }),
    ]);
  });

  it("aggregates detailed usage for inner-loop invocations", () => {
    const first = createAgentActivityRecorder(stateDir, makeIdentity());
    first.start();
    first.terminal("complete", {
      cost: 0.2,
      turns: 2,
      tokens: {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 1,
        total: 36,
        complete: true,
      },
    });
    const second = createAgentActivityRecorder(stateDir, {
      ...makeIdentity(),
      invocationId: "advisor-loop-4",
      role: "advisor",
      kind: "advise",
    });
    second.start();
    second.terminal("failed", {
      cost: 0.1,
      turns: 1,
      tokens: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 6,
        complete: false,
      },
    });
    const outer = createAgentActivityRecorder(stateDir, {
      ...makeIdentity(),
      invocationId: "outer-loop-4",
      role: "metaharness",
      kind: "evolve-harness",
    });
    outer.start();
    outer.terminal("complete", {
      cost: 2,
      turns: 1,
      tokens: {
        input: 1_000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1_100,
        complete: true,
      },
    });

    expect(loadInnerLoopAgentUsage(stateDir, 4)).toEqual({
      cost: 0.30000000000000004,
      turns: 3,
      invocations: 2,
      tokens: {
        input: 14,
        output: 7,
        cacheRead: 20,
        cacheWrite: 1,
        total: 42,
        complete: false,
      },
    });
  });

  it("ignores duplicate and out-of-order lifecycle updates when folding", () => {
    const identity = makeIdentity();
    const records = [
      {
        schemaVersion: 1 as const,
        type: "started" as const,
        eventId: "start",
        sequence: 0,
        recordedAt: "2026-07-26T10:00:00.000Z",
        invocationId: identity.invocationId,
        invocation: identity,
      },
      {
        schemaVersion: 1 as const,
        type: "activity" as const,
        eventId: "new",
        sequence: 2,
        recordedAt: "2026-07-26T10:02:00.000Z",
        invocationId: identity.invocationId,
        activity: "new activity",
      },
      {
        schemaVersion: 1 as const,
        type: "activity" as const,
        eventId: "old",
        sequence: 1,
        recordedAt: "2026-07-26T10:01:00.000Z",
        invocationId: identity.invocationId,
        activity: "stale activity",
      },
      {
        schemaVersion: 1 as const,
        type: "activity" as const,
        eventId: "new",
        sequence: 2,
        recordedAt: "2026-07-26T10:02:00.000Z",
        invocationId: identity.invocationId,
        activity: "duplicate activity",
      },
    ];

    expect(foldAgentInvocationRecords(records)).toEqual([
      expect.objectContaining({ activity: "new activity" }),
    ]);
  });

  function makeIdentity(): AgentInvocationIdentity {
    return {
      invocationId: "phd-L004-I2-attempt-2",
      role: "phd",
      kind: "implement",
      loop: 4,
      candidateId: "L004-I2",
      attempt: 2,
      tracePath: path.join(
        stateDir,
        "runs",
        "L004-I2",
        "agent",
        "events.ndjson",
      ),
    };
  }

  function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
    return {
      role: "phd",
      kind: "implement",
      cwd: root,
      stateDir,
      input: {
        loop: 4,
        ideaId: "L004-I2",
        attempt: 2,
      },
      ...overrides,
    };
  }
});
