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
  let originalArgv1: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
    originalPath = process.env.PATH;
    originalRecordPath = process.env.FAKE_PI_RECORD;
    originalArgv1 = process.argv[1];
    // Exercise the generic-runtime fallback in most tests. A dedicated test
    // below covers reuse of the script that launched the parent Pi.
    process.argv[1] = "/$bunfs/root/pi";
    process.env.PATH = `${tmpDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = originalArgv1;
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
    expect(prompt).toContain("# Role: Professor");
    expect(prompt).toContain("# Task: Propose the next research portfolio");
    expect(prompt).toContain("Current best local score: 100");
    expect(prompt).toContain("Score direction: `-`");
    expect(prompt).toContain(`${task.stateDir}/knowledge-base.md`);
    expect(prompt).not.toContain("{{");
    const soulFlag = invocation.args.indexOf("--append-system-prompt");
    expect(soulFlag).toBeGreaterThan(-1);
    expect(invocation.args[soulFlag + 1]).toMatch(
      /extensions[/\\]autoresearch[/\\]agents[/\\]professor[/\\]SOUL\.md$/,
    );
    const soul = fs.readFileSync(invocation.args[soulFlag + 1]!, "utf8");
    expect(soul).toContain("research director and evidence-driven search strategist");
    expect(soul).not.toContain("{{");
    expect(soul).not.toContain("loop 2");
  });

  it("composes every bundled role profile with its task prompt", async () => {
    const recordPath = path.join(tmpDir, "profile-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const runner = new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles));
    const manifest = {
      name: "profile-fixture",
      setupCommand: "./setup.sh",
      benchmarkCommand: "./benchmark.sh",
      scorePath: "score.json",
      direction: "-",
      editablePaths: ["src/solution"],
    };
    const cases: Array<{
      task: AgentTask;
      expected: string[];
      absent?: string[];
    }> = [
      {
        task: makeTask(tmpDir, {
          role: "setup",
          kind: "init.explore",
          input: {
            manifest,
            setupCommand: "./setup.sh",
            setupLogPath: "/tmp/project/.autoresearch/logs/setup.log",
            setupSucceeded: true,
          },
        }),
        expected: [
          "# Role: Setup",
          "# Task: Classify setup and confirm readiness",
          "Latest successful setup log: `/tmp/project/.autoresearch/logs/setup.log`",
          "local hardware",
          "repository-supported flags",
          "reduced-fidelity",
          "Do not rerun the setup command",
          "Do not run the performance benchmark",
          "load a large model",
          "expensive verification",
          '"verifyCommand": "existing correctness command"',
          '"status": "needs-user-action"',
        ],
      },
      {
        task: makeTask(tmpDir, {
          role: "setup",
          kind: "init.review",
          input: {
            repoRoot: "/tmp/project",
            manifestPath: "/tmp/project/benchmark.json",
            knowledgeBasePath: "/tmp/project/.autoresearch/knowledge-base.md",
            previousVerifyCommand: "./verify.sh",
            previousBenchCommand: "./benchmark.sh",
            benchmarkLogPath: "/tmp/project/.autoresearch/logs/benchmark.log",
            scorePath: "/tmp/project/score.json",
            benchmarkExitCode: 1,
            benchmarkFailureTail: "documented hardware mismatch",
          },
        }),
        expected: [
          "# Role: Setup",
          "# Task: Review a failed initialization baseline",
          "documented hardware mismatch",
          "Do not turn a correctness failure into success silently",
          '"status": "needs-user-action"',
        ],
      },
      {
        task: makeTask(tmpDir, {
          role: "phd",
          kind: "implement",
          input: {
            loop: 3,
            ideaId: "L003-I2",
            specFile: "/tmp/idea.md",
            attempt: 2,
            maxVerifyAttempts: 3,
            editablePaths: ["src/solution"],
            verifyCommand: "npm test",
            lastVerifyError: "assertion failed",
          },
        }),
        expected: [
          "# Role: PhD",
          "# Task: Implement one research idea",
          "Attempt: 2 of 3",
          "assertion failed",
          "full performance benchmark",
        ],
        absent: ["# Task: Record a completed experiment"],
      },
      {
        task: makeTask(tmpDir, {
          role: "god",
          kind: "church",
          input: { loop: 6, streak: 4, notePath: "/tmp/church.md" },
        }),
        expected: [
          "# Role: God",
          "# Task: Go to church",
          "Dry-loop streak: 4",
          "Write the complete dialogue to `/tmp/church.md`",
        ],
      },
      {
        task: makeTask(tmpDir, {
          role: "advisor",
          kind: "advise",
          input: {
            watchdogFile: "WATCHDOG.md",
            summary: { loop: 4, improved: false },
            stateDiff: { dryLoopStreak: 2, ideaFailed: true },
            rules: [{ if: "dryLoopStreak >= 2", severity: "concern", text: "Change course." }],
          },
        }),
        expected: [
          "# Role: Advisor",
          "# Task: Review the completed loop",
          '"dryLoopStreak": 2',
          "Return at most three concise notes",
          '"severity": "nit|concern|blocker"',
        ],
      },
    ];

    for (const testCase of cases) {
      const result = await runner.run(testCase.task);
      expect(result.ok).toBe(true);
      const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
      const prompt = invocation.args.at(-1) ?? "";
      for (const expected of testCase.expected) expect(prompt).toContain(expected);
      for (const absent of testCase.absent ?? []) expect(prompt).not.toContain(absent);
      expect(prompt).not.toContain("{{");
    }
  });

  it("passes the role thinking level and tool allowlist to pi", async () => {
    const recordPath = path.join(tmpDir, "role-options-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.thinking = "xhigh";
    roles.professor.tools = ["read", "grep", "taskboard"];

    await new PiSubprocessRunner(roles).run(makeTask(tmpDir));

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    expect(invocation.args.slice(0, -1)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--model",
      roles.professor.model,
      "--thinking",
      "xhigh",
      "--tools",
      "read,grep,taskboard",
      "--append-system-prompt",
      expect.stringMatching(
        /extensions[/\\]autoresearch[/\\]agents[/\\]professor[/\\]SOUL\.md$/,
      ),
    ]);
  });

  it("applies a validated harness profile as a per-task role override", async () => {
    const recordPath = path.join(tmpDir, "profile-override-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const stateDir = path.join(tmpDir, ".autoresearch");
    const soulPath = path.join(stateDir, "metaharness", "candidate", "SOUL.md");
    const promptPath = path.join(stateDir, "metaharness", "candidate", "prompt.md");
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    fs.writeFileSync(soulPath, "Evolved professor soul.\n");
    fs.writeFileSync(promptPath, "Evolved prompt for loop {{loop}}.\n");
    const task = makeTask(tmpDir, {
      stateDir,
      roleOverride: {
        soul: path.relative(tmpDir, soulPath),
        prompt: path.relative(tmpDir, promptPath),
        tools: ["read"],
      },
    });

    await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(task);

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      args: string[];
    };
    expect(invocation.args.at(-1)).toContain("Evolved prompt for loop 2.");
    expect(
      fs.readFileSync(
        invocation.args[invocation.args.indexOf("--append-system-prompt") + 1]!,
        "utf8",
      ),
    ).toContain("Evolved professor soul.");
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("read");
  });

  it("allows a task to narrow the role tool allowlist", async () => {
    const recordPath = path.join(tmpDir, "task-tools-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.phd.tools = ["read", "write", "edit", "bash"];
    const task = makeTask(tmpDir, {
      role: "phd",
      kind: "write-note",
      tools: ["read"],
      input: {
        notePath: path.join(tmpDir, ".autoresearch", "note.md"),
        ideaTitle: "Safe postmortem",
      },
    });

    await new PiSubprocessRunner(roles).run(task);

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      args: string[];
    };
    expect(invocation.args).toContain("--tools");
    expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("read");
  });

  it("disables every tool for an explicitly empty role allowlist", async () => {
    const recordPath = path.join(tmpDir, "no-tools-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.thinking = "off";
    roles.professor.tools = [];

    await new PiSubprocessRunner(roles).run(makeTask(tmpDir));

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    expect(invocation.args.slice(0, -1)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--model",
      roles.professor.model,
      "--thinking",
      "off",
      "--no-tools",
      "--append-system-prompt",
      expect.stringMatching(
        /extensions[/\\]autoresearch[/\\]agents[/\\]professor[/\\]SOUL\.md$/,
      ),
    ]);
  });

  it("resolves a configured bare role filename and still appends the current task", async () => {
    const recordPath = path.join(tmpDir, "bundled-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.prompt = "god.md";

    await new PiSubprocessRunner(roles).run(
      makeTask(tmpDir),
    );

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("# Role: God");
    expect(prompt).toContain("# Task: Propose the next research portfolio");
    expect(prompt).not.toContain("# Task: Go to church");
  });

  it("resolves a configured bare soul from the bundled role directory", async () => {
    const recordPath = path.join(tmpDir, "bundled-soul-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.god.soul = "SOUL.md";

    await new PiSubprocessRunner(roles).run(
      makeTask(tmpDir, {
        role: "god",
        kind: "god-conversation",
        input: { streak: 4, notePath: "/tmp/hope.md" },
      }),
    );

    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    const soulPath = invocation.args[invocation.args.indexOf("--append-system-prompt") + 1]!;
    expect(soulPath).toMatch(/extensions[/\\]autoresearch[/\\]agents[/\\]god[/\\]SOUL\.md$/);
    const soul = fs.readFileSync(soulPath, "utf8");
    expect(soul).toContain("warm, candid, patient, and occasionally playful");
    expect(soul).toContain("Hope is not certainty about an outcome");
    expect(soul).toContain("do not offer prophecy, guarantee improvement");
    expect(soul).not.toMatch(/4-8|notePath/);
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
    expect(prompt).toContain("# Role: PhD");
    expect(prompt).toContain("# Task: Record a completed experiment");
    expect(prompt).toContain("Idea: Ancilla reuse");
    expect(prompt).toContain("Return the complete markdown note");
    expect(prompt).not.toContain("implementing one research idea");
    expect(prompt).not.toContain("{{");
  });

  it("resolves and renders repo-relative prompts from the main challenge repo", async () => {
    const repoRoot = path.join(tmpDir, "challenge");
    const worktree = path.join(tmpDir, "worktree");
    const stateDir = path.join(repoRoot, ".autoresearch");
    fs.mkdirSync(path.join(stateDir, "prompts", "roles"), { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(stateDir, "prompts", "roles", "custom.md"),
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
    roles.professor.prompt = ".autoresearch/prompts/roles/custom.md";

    const result = await new PiSubprocessRunner(roles).run(
      makeTask(worktree, {
        stateDir,
        input: { loop: 7, payload: { score: 42 }, lastVerifyError: "bad proof" },
      }),
    );

    expect(result.ok).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[]; cwd: string };
    expect(invocation.cwd).toBe(fs.realpathSync(worktree));
    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain(`Loop 7 in ${worktree}.`);
    expect(prompt).toContain('Payload: {\n  "score": 42\n}');
    expect(prompt).toContain("Previous failure: bad proof");
    expect(prompt).toContain("# Task: Propose the next research portfolio");
  });

  it("uses a challenge-local task override while keeping the role profile", async () => {
    const repoRoot = path.join(tmpDir, "challenge");
    const stateDir = path.join(repoRoot, ".autoresearch");
    fs.mkdirSync(path.join(stateDir, "prompts", "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "prompts", "tasks", "propose.md"),
      "# Task: Custom proposal\n\nCustom loop {{loop}}.\n",
    );
    const recordPath = path.join(tmpDir, "custom-task-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(
      makeTask(repoRoot, { stateDir }),
    );

    expect(result.ok).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("# Role: Professor");
    expect(prompt).toContain("# Task: Custom proposal");
    expect(prompt).toContain("Custom loop 2.");
    expect(prompt).not.toContain("# Task: Propose the next research portfolio");
  });

  it("resolves a configured repo-relative soul from the main challenge repo", async () => {
    const repoRoot = path.join(tmpDir, "challenge");
    const worktree = path.join(tmpDir, "worktree");
    const stateDir = path.join(repoRoot, ".autoresearch");
    const customSoulPath = path.join(stateDir, "agents", "professor", "SOUL.md");
    fs.mkdirSync(path.dirname(customSoulPath), { recursive: true });
    fs.mkdirSync(worktree);
    fs.writeFileSync(customSoulPath, "# Custom Professor\n\nStable custom instructions.\n");
    const recordPath = path.join(tmpDir, "custom-soul-invocation.json");
    process.env.FAKE_PI_RECORD = recordPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.soul = ".autoresearch/agents/professor/SOUL.md";

    const result = await new PiSubprocessRunner(roles).run(makeTask(worktree, { stateDir }));

    expect(result.ok).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[] };
    expect(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1]).toBe(customSoulPath);
    expect(invocation.args.at(-1)).toContain("## Your job (loop 2)");
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
    roles.professor.prompt = ".autoresearch/prompts/roles/missing.md";

    await expect(new PiSubprocessRunner(roles).run(makeTask(tmpDir))).resolves.toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: expect.stringMatching(/prompt.*missing\.md/i),
    });
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("returns a failed result when the configured soul cannot be read", async () => {
    const invokedPath = path.join(tmpDir, "unexpected-soul-invocation");
    process.env.FAKE_PI_RECORD = invokedPath;
    writeRecordingFakePi();
    const roles = structuredClone(DEFAULT_CONFIG.roles);
    roles.professor.soul = ".autoresearch/agents/professor/missing.md";

    await expect(new PiSubprocessRunner(roles).run(makeTask(tmpDir))).resolves.toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: expect.stringMatching(/soul.*missing\.md/i),
    });
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("retains the complete raw JSONL stream and snapshots the effective soul", async () => {
    const traceDir = path.join(tmpDir, ".autoresearch", "run", "agent");
    const rawEvents = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "TASK.md" },
      }),
      JSON.stringify({
        type: "tool_result_end",
        message: { role: "toolResult", content: [{ type: "text", text: "task" }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n") + "\n";
    writeFakePi(`
process.stdout.write(${JSON.stringify(rawEvents)});
`);

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(
      makeTask(tmpDir, {
        input: {
          loop: 2,
          maxIdeasPerLoop: 3,
          bestScore: 100,
          direction: "-",
          dryLoopStreak: 1,
          traceDir,
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, output: "done" });
    expect(fs.readFileSync(path.join(traceDir, "events.ndjson"), "utf8")).toBe(rawEvents);
    expect(fs.readFileSync(path.join(traceDir, "soul.md"), "utf8")).toContain(
      "research director and evidence-driven search strategist",
    );
    expect(fs.readFileSync(path.join(traceDir, "context.md"), "utf8")).toContain(
      "## Your job (loop 2)",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(traceDir, "invocation.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      role: "professor",
      kind: "propose",
      cwd: tmpDir,
      input: { loop: 2 },
    });
  });

  it("uses an explicitly supplied run trace path", async () => {
    const tracePath = path.join(
      tmpDir,
      ".autoresearch",
      "run",
      "agent",
      "worker.ndjson",
    );
    const rawEvent =
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }) + "\n";
    writeFakePi(`
process.stdout.write(${JSON.stringify(rawEvent)});
`);

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(
      makeTask(tmpDir, {
        input: {
          loop: 2,
          maxIdeasPerLoop: 3,
          bestScore: 100,
          direction: "-",
          dryLoopStreak: 1,
          runTracePath: tracePath,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(tracePath, "utf8")).toBe(rawEvent);
    expect(fs.existsSync(path.join(path.dirname(tracePath), "soul.md"))).toBe(true);
  });

  it("rejects trace paths outside the autoresearch state directory", async () => {
    const task = makeTask(tmpDir);
    const result = await new PiSubprocessRunner(
      structuredClone(DEFAULT_CONFIG.roles),
    ).run({
      ...task,
      input: {
        ...task.input,
        traceDir: path.join(tmpDir, "outside-state"),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/trace path escapes/i),
    });
    expect(fs.existsSync(path.join(tmpDir, "outside-state"))).toBe(false);
  });

  it("reuses the script that launched the parent Pi process", async () => {
    const recordPath = path.join(tmpDir, "parent-script-invocation.json");
    const parentScript = path.join(tmpDir, "pi.cjs");
    process.env.FAKE_PI_RECORD = recordPath;
    fs.writeFileSync(
      parentScript,
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stdout.write(JSON.stringify({",
        '  type: "message_end",',
        '  message: { role: "assistant", content: [{ type: "text", text: "done" }] },',
        '}) + "\\n");',
        "",
      ].join("\n"),
    );
    process.argv[1] = parentScript;

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(makeTask(tmpDir));

    expect(result.ok).toBe(true);
    const invocation = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { args: string[]; cwd: string };
    expect(invocation.args).toContain("--append-system-prompt");
    expect(invocation.cwd).toBe(fs.realpathSync(tmpDir));
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

  it("terminates a hung pi process after the configured timeout", async () => {
    const pidPath = path.join(tmpDir, "timeout-pid");
    process.env.FAKE_PI_RECORD = pidPath;
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles), {
      timeoutMs: 1_000,
      killGraceMs: 50,
    }).run(makeTask(tmpDir));

    expect(result).toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: "pi subprocess timed out after 1000ms",
    });
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(processIsRunning(Number(fs.readFileSync(pidPath, "utf8")))).toBe(false);
  });

  it("does not spawn pi when the task signal is already aborted", async () => {
    const invokedPath = path.join(tmpDir, "pre-abort-invocation");
    process.env.FAKE_PI_RECORD = invokedPath;
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, "invoked");
`);
    const controller = new AbortController();
    controller.abort();

    const result = await new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles)).run(
      makeTask(tmpDir, { signal: controller.signal }),
    );

    expect(result).toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: "pi subprocess aborted before start",
    });
    expect(fs.existsSync(invokedPath)).toBe(false);
  });

  it("terminates pi and resolves a failed result when aborted during a run", async () => {
    const pidPath = path.join(tmpDir, "abort-pid");
    process.env.FAKE_PI_RECORD = pidPath;
    writeFakePi(`
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PI_RECORD, String(process.pid));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const running = new PiSubprocessRunner(structuredClone(DEFAULT_CONFIG.roles), {
      timeoutMs: 5_000,
      killGraceMs: 50,
    }).run(makeTask(tmpDir, { signal: controller.signal }));

    await waitForFile(pidPath);
    controller.abort();
    const result = await running;

    expect(result).toMatchObject({
      ok: false,
      output: "",
      filesWritten: [],
      error: "pi subprocess aborted",
    });
    expect(processIsRunning(Number(fs.readFileSync(pidPath, "utf8")))).toBe(false);
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
  const stateDir = path.join(cwd, ".autoresearch");
  const task: AgentTask = {
    role: "professor",
    kind: "propose",
    cwd,
    stateDir,
    input: {
      taskPath: path.join(stateDir, "loops", "loop-002", "professor-task.json"),
      loop: 2,
      maxIdeasPerLoop: 3,
      bestScore: 100,
      direction: "-",
      dryLoopStreak: 1,
      knowledgeBasePath: path.join(stateDir, "knowledge-base.md"),
      ledgerPath: path.join(stateDir, "ledger.ndjson"),
      runsDirectory: path.join(stateDir, "runs"),
      currentBestCandidateId: "L001-I1",
    },
  };
  return { ...task, ...overrides };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
