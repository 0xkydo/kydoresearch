import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSubprocessRunner } from "../src/agents/subprocess.ts";
import type { AgentTask } from "../src/agents/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

describe("PiSubprocessRunner", () => {
  let tmpDir: string;
  let originalPath: string | undefined;
  let originalRecordPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
    originalPath = process.env.PATH;
    originalRecordPath = process.env.FAKE_PI_RECORD;
    process.env.PATH = `${tmpDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalRecordPath === undefined) delete process.env.FAKE_PI_RECORD;
    else process.env.FAKE_PI_RECORD = originalRecordPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs pi in the task cwd and maps assistant events to AgentResult", async () => {
    const recordPath = path.join(tmpDir, "invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
}));
const events = [
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I inspected the challenge. " }],
      usage: { cost: { total: 0.125 } },
    },
  },
  {
    type: "tool_result_end",
    message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Found two ideas.\\n" },
        { type: "text", text: "\\\`\\\`\\\`json\\n{\\\"ideas\\\":[{\\\"title\\\":\\\"A\\\",\\\"spec\\\":\\\"Try A\\\"}]}\\n\\\`\\\`\\\`" },
      ],
      usage: { cost: { total: 0.25 } },
    },
  },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`);

    const task = makeTask(tmpDir);
    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(task);

    expect(result).toEqual({
      ok: true,
      output:
        "I inspected the challenge. Found two ideas.\n" +
        '```json\n{"ideas":[{"title":"A","spec":"Try A"}]}\n```',
      structured: { ideas: [{ title: "A", spec: "Try A" }] },
      filesWritten: [],
      usage: { cost: 0.375, turns: 2 },
    });

    expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toEqual({
      args: [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        DEFAULT_CONFIG.roles.professor.model,
        JSON.stringify(task.input),
      ],
      cwd: fs.realpathSync(tmpDir),
    });
  });

  it("returns a failed result for malformed JSON events", async () => {
    writeFakePi(`
process.stdout.write("{ definitely not json }\\n");
`);

    await expect(
      new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(makeTask(tmpDir)),
    ).resolves.toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: expect.stringMatching(/invalid JSON event/i),
    });
  });

  it("returns a failed result with captured output when pi exits nonzero", async () => {
    writeFakePi(`
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
}) + "\\n");
process.stderr.write("provider unavailable\\n");
process.exitCode = 7;
`);

    await expect(
      new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(makeTask(tmpDir)),
    ).resolves.toEqual({
      ok: false,
      output: "Partial answer",
      filesWritten: [],
      usage: { cost: 0, turns: 1 },
      error: "pi exited with code 7: provider unavailable",
    });
  });

  function writeFakePi(body: string): void {
    const shimPath = path.join(tmpDir, "pi");
    fs.writeFileSync(shimPath, `#!/usr/bin/env node\n${body}`);
    fs.chmodSync(shimPath, 0o755);
  }
});

function makeTask(cwd: string): AgentTask {
  return {
    role: "professor",
    kind: "propose",
    cwd,
    stateDir: path.join(cwd, ".autoresearch"),
    input: { loop: 2, maxIdeasPerLoop: 3 },
  };
}
