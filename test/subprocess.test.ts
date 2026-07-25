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
      args: expect.arrayContaining([
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        DEFAULT_CONFIG.roles.professor.model,
      ]),
      cwd: fs.realpathSync(tmpDir),
    });
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    const prompt = invocation.args.at(-1);
    expect(prompt).toContain("## Your job (loop 2)");
    expect(prompt).toContain("Current best score: 100 (direction -)");
    expect(prompt).toContain(`${task.stateDir}/knowledge-base.md`);
    expect(prompt).not.toContain("{{");
  });

  it("resolves a configured bare prompt filename from the bundled prompt directory", async () => {
    const recordPath = path.join(tmpDir, "bundled-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.prompt = "god.md";

    await new PiSubprocessRunner(roles).run(
      makeTask(tmpDir, {
        input: { streak: 4, notePath: "/tmp/hope.md" },
      }),
    );

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    expect(invocation.args.at(-1)).toContain("after 4 consecutive loops");
    expect(invocation.args.at(-1)).toContain("to `/tmp/hope.md`");
  });

  it("renders the task-specific note section of the bundled PhD prompt", async () => {
    const recordPath = path.join(tmpDir, "phd-note-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();

    await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(
      makeTask(tmpDir, {
        role: "phd",
        kind: "write-note",
        input: {
          notePath: "/tmp/hypothesis.md",
          ideaTitle: "Ancilla reuse",
          status: "done-no-improvement",
          localScore: 120,
          bestScore: 100,
        },
      }),
    );

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    const prompt = invocation.args.at(-1);
    expect(prompt).toContain("recording what was learned");
    expect(prompt).toContain("Idea: Ancilla reuse");
    expect(prompt).toContain("Write the note to the requested path");
    expect(prompt).not.toContain("implementing one research idea");
    expect(prompt).not.toContain("{{");
  });

  it("resolves and renders repo-relative prompts from the main challenge repo", async () => {
    const repoRoot = path.join(tmpDir, "challenge");
    const worktree = path.join(tmpDir, "worktree");
    const stateDir = path.join(repoRoot, ".autoresearch");
    fs.mkdirSync(path.join(stateDir, "prompts"), { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(stateDir, "prompts", "custom.md"),
      [
        "Loop {{loop}} in {{cwd}}.",
        "Payload: {{payload}}",
        "{{#lastVerifyError}}Previous failure: {{lastVerifyError}}{{/lastVerifyError}}",
        "",
      ].join("\n"),
    );
    const recordPath = path.join(tmpDir, "custom-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.prompt = ".autoresearch/prompts/custom.md";

    const result = await new PiSubprocessRunner(roles).run(
      makeTask(worktree, {
        stateDir,
        input: { loop: 7, payload: { score: 42 }, lastVerifyError: "bad proof" },
      }),
    );

    expect(result.ok).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[]; cwd: string };
    expect(invocation.cwd).toBe(fs.realpathSync(worktree));
    expect(invocation.args.at(-1)).toBe(
      [
        `Loop 7 in ${worktree}.`,
        'Payload: {\n  "score": 42\n}',
        "Previous failure: bad proof",
        "",
      ].join("\n"),
    );
  });

  it("returns a failed result when the configured prompt cannot be read", async () => {
    const invokedPath = path.join(tmpDir, "unexpected-invocation");
    process.env.FAKE_PI_RECORD = invokedPath;
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, "invoked");
process.exitCode = 99;
`);
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.prompt = ".autoresearch/prompts/missing.md";

    await expect(new PiSubprocessRunner(roles).run(makeTask(tmpDir))).resolves.toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: expect.stringMatching(/prompt.*missing\.md/i),
    });
    expect(fs.existsSync(invokedPath)).toBe(false);
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

  function writeRecordingFakePi(): void {
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
}));
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
}) + "\\n");
`);
  }
});

function makeTask(cwd: string, overrides: Partial<AgentTask> = {}): AgentTask {
  const task: AgentTask = {
    role: "professor",
    kind: "propose",
    cwd,
    stateDir: path.join(cwd, ".autoresearch"),
    input: {
      loop: 2,
      maxIdeasPerLoop: 3,
      bestScore: 100,
      direction: "-",
      dryLoopStreak: 1,
    },
  };
  return { ...task, ...overrides };
}
