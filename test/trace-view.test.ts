import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parsePiTraceEvent,
  PiTraceDecoder,
  PiTraceFileTailer,
} from "../extensions/autoresearch/trace-view.ts";

describe("Pi trace semantic rendering", () => {
  it("converts known tool, assistant, thought, and error events", () => {
    expect(parsePiTraceEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "src/cache.ts" },
      timestamp: "2026-07-26T14:31:08.000Z",
    })).toEqual([expect.objectContaining({
      kind: "tool",
      label: "Read",
      summary: "src/cache.ts",
      toolCallId: "tool-1",
    })]);

    expect(parsePiTraceEvent({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1_753_540_279_000,
        content: [
          { type: "thinking", thinking: "The cache key\nneeds a device field." },
          { type: "text", text: "I will update it." },
        ],
      },
    })).toEqual([
      expect.objectContaining({
        kind: "thought",
        label: "Thought",
        summary: "The cache key needs a device field.",
      }),
      expect.objectContaining({
        kind: "assistant",
        label: "Assistant",
        summary: "I will update it.",
      }),
    ]);

    expect(parsePiTraceEvent({
      type: "tool_execution_end",
      toolCallId: "tool-2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "1 failed" }] },
      isError: true,
    })[0]).toEqual(expect.objectContaining({
      kind: "error",
      label: "Error",
      summary: "Bash failed · 1 failed",
    }));
  });

  it("ignores streaming snapshots and unknown protocol events", () => {
    expect(parsePiTraceEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    })).toEqual([]);
    expect(parsePiTraceEvent({ type: "session" })).toEqual([]);
    expect(parsePiTraceEvent(null)).toEqual([]);
  });
});

describe("PiTraceDecoder", () => {
  it("holds partial JSONL until a complete line arrives", () => {
    const decoder = new PiTraceDecoder("agent-1");
    expect(decoder.push('{"type":"tool_execution_start","toolName":"read",')).toEqual([]);
    expect(decoder.pendingText).not.toBe("");

    const events = decoder.push('"args":{"path":"TASK.md"}}\n');
    expect(events).toEqual([
      expect.objectContaining({
        id: "agent-1-0",
        kind: "tool",
        summary: "TASK.md",
      }),
    ]);
    expect(decoder.pendingText).toBe("");
  });

  it("decodes a final unterminated line and surfaces malformed complete lines", () => {
    const decoder = new PiTraceDecoder("agent-2");
    const first = decoder.push(
      "not-json\n" +
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      }),
    );
    expect(first).toEqual([
      expect.objectContaining({
        id: "agent-2-0",
        kind: "error",
        summary: "malformed JSONL event",
      }),
    ]);
    expect(decoder.finish()).toEqual([
      expect.objectContaining({
        id: "agent-2-1",
        kind: "assistant",
        summary: "done",
      }),
    ]);
  });

  it("preserves split UTF-8 characters when chunks are bytes", () => {
    const decoder = new PiTraceDecoder();
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "café" }],
        },
      }) + "\n",
    );
    const split = encoded.indexOf(0xc3) + 1;
    expect(decoder.push(encoded.slice(0, split))).toEqual([]);
    expect(decoder.push(encoded.slice(split))[0]?.summary).toBe("café");
  });
});

describe("PiTraceFileTailer", () => {
  let directory: string;
  let tracePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-trace-"));
    tracePath = path.join(directory, "events.ndjson");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reads only appended bytes and carries a partial trailing line", () => {
    const firstLine = JSON.stringify({
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "TASK.md" },
    });
    const secondLine = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    });
    fs.writeFileSync(tracePath, firstLine.slice(0, 25));
    const tailer = new PiTraceFileTailer(tracePath, "history");

    const initial = tailer.poll();
    expect(initial.reloaded).toBe(true);
    expect(initial.events).toEqual([]);

    fs.appendFileSync(tracePath, `${firstLine.slice(25)}\n${secondLine}\n`);
    const appended = tailer.poll();
    expect(appended.reloaded).toBe(false);
    expect(appended.events).toEqual([
      expect.objectContaining({ id: "history-0", summary: "TASK.md" }),
      expect.objectContaining({ id: "history-1", summary: "done" }),
    ]);
    expect(tailer.poll()).toEqual({
      events: [],
      reloaded: false,
      offset: Buffer.byteLength(`${firstLine}\n${secondLine}\n`),
    });
  });

  it("reloads safely after in-place truncation", () => {
    fs.writeFileSync(tracePath, traceLine("before truncation"));
    const tailer = new PiTraceFileTailer(tracePath, "history");
    expect(tailer.poll().events[0]?.summary).toBe("before truncation");

    fs.truncateSync(tracePath, 0);
    fs.appendFileSync(tracePath, traceLine("new"));
    const poll = tailer.poll();
    expect(poll.reloaded).toBe(true);
    expect(poll.events).toEqual([
      expect.objectContaining({ id: "history-0", summary: "new" }),
    ]);
  });

  it("reloads after atomic file replacement even when the size is unchanged", () => {
    const original = traceLine("version-a");
    const replacement = traceLine("version-b");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    fs.writeFileSync(tracePath, original);
    const tailer = new PiTraceFileTailer(tracePath, "history");
    tailer.poll();

    const replacementPath = path.join(directory, "replacement.ndjson");
    fs.writeFileSync(replacementPath, replacement);
    fs.renameSync(replacementPath, tracePath);

    const poll = tailer.poll();
    expect(poll.reloaded).toBe(true);
    expect(poll.events[0]?.summary).toBe("version-b");
  });

  it("reloads an in-place rewrite that changes already-consumed bytes", () => {
    const original = [
      traceLine("prefix"),
      traceLine("middle-a"),
      traceLine("suffix"),
    ].join("");
    const replacement = original.replace("middle-a", "middle-b");
    fs.writeFileSync(tracePath, original);
    const tailer = new PiTraceFileTailer(tracePath, "history");
    tailer.poll();

    fs.writeFileSync(tracePath, replacement);
    const poll = tailer.poll();
    expect(poll.reloaded).toBe(true);
    expect(poll.events.map((event) => event.summary)).toEqual([
      "prefix",
      "middle-b",
      "suffix",
    ]);
  });

  it("reports a disappearing trace and starts cleanly when it returns", () => {
    fs.writeFileSync(tracePath, traceLine("first"));
    const tailer = new PiTraceFileTailer(tracePath, "history");
    tailer.poll();
    fs.unlinkSync(tracePath);

    expect(tailer.poll()).toEqual({
      events: [],
      reloaded: true,
      offset: 0,
      missing: true,
    });

    fs.writeFileSync(tracePath, traceLine("second"));
    expect(tailer.poll()).toEqual(expect.objectContaining({
      reloaded: true,
      events: [expect.objectContaining({ id: "history-0", summary: "second" })],
    }));
  });
});

function traceLine(summary: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: summary }],
    },
  }) + "\n";
}
