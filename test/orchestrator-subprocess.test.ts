import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import { PiSubprocessRunner } from "../src/agents/subprocess.ts";
import { candidateRunPaths } from "../src/archive.ts";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../src/challenge/detect.ts";
import type { HarnessConfig } from "../src/config.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import type { OrchestratorEvent } from "../src/orchestrator.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { loadState, statePaths } from "../src/state.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

type Scenario =
  | "phd-crash"
  | "zero-ideas"
  | "bench-failure"
  | "parallel-blocker"
  | "resume-improve"
  | "resume-god";

interface SubprocessHarness {
  stateDir: string;
  events: OrchestratorEvent[];
  orchestrator: Orchestrator;
  makeOrchestrator: (
    signal?: AbortSignal,
    observe?: (event: OrchestratorEvent) => void,
  ) => Orchestrator;
}

describe("Orchestrator with PiSubprocessRunner failures", () => {
  let repoRoot: string;
  let cleanupChallenge: () => void;
  let shimDir: string;
  let recordPath: string;
  let originalPath: string | undefined;
  let originalScenario: string | undefined;
  let originalRecord: string | undefined;
  let originalHoldImplement: string | undefined;

  beforeEach(() => {
    ({ repoRoot, cleanup: cleanupChallenge } = makeTmpChallenge());
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-fake-pi-"));
    recordPath = path.join(shimDir, "events.ndjson");
    originalPath = process.env.PATH;
    originalScenario = process.env.FAKE_PI_SCENARIO;
    originalRecord = process.env.FAKE_PI_RECORD;
    originalHoldImplement = process.env.FAKE_PI_HOLD_IMPLEMENT;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.FAKE_PI_RECORD = recordPath;
    writeScenarioPi(path.join(shimDir, "pi"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    restoreEnv("FAKE_PI_SCENARIO", originalScenario);
    restoreEnv("FAKE_PI_RECORD", originalRecord);
    restoreEnv("FAKE_PI_HOLD_IMPLEMENT", originalHoldImplement);
    cleanupChallenge();
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  it("contains a PhD crash mid-implement while the parallel idea completes", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "phd-crash", {
      maxVerifyAttempts: 2,
    });

    const summary = await harness.orchestrator.runLoop();
    const byId = Object.fromEntries(summary!.ideas.map((idea) => [idea.id, idea]));

    expect(byId["L001-I1"]?.status).toBe("failed");
    expect(byId["L001-I2"]?.status).toBe("done-no-improvement");
    expect(loadState(harness.stateDir)).toMatchObject({
      bestScore: 10,
      dryLoopStreak: 1,
      history: [{ improved: false }],
    });
    expect(mySubmissions(repoRoot)).toEqual([]);
    expect(fs.existsSync(path.join(harness.stateDir, "worktrees", "L001-I1"))).toBe(true);
    expect(fs.existsSync(path.join(harness.stateDir, "worktrees", "L001-I2"))).toBe(false);

    const records = readRecords(recordPath);
    expect(records.filter((record) => record.event === "crash" && record.idea === "L001-I1"))
      .toHaveLength(2);
    expect(records).toContainEqual(
      expect.objectContaining({ event: "end", idea: "L001-I2" }),
    );
  });

  it("rejects a professor response with zero ideas before creating worktrees", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "zero-ideas");

    await expect(harness.orchestrator.runLoop()).rejects.toThrow(
      "Professor proposed zero ideas; cannot continue the loop.",
    );

    expect(loadState(harness.stateDir)).toMatchObject({
      phase: "loop.proposing",
      loop: 1,
      ideas: [],
      history: [],
      bestScore: 10,
    });
    expect(fs.readdirSync(path.join(harness.stateDir, "worktrees"))).toEqual([]);
    expect(mySubmissions(repoRoot)).toEqual([]);
  });

  it("marks ideas failed when the benchmark script exits nonzero", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "bench-failure");
    fs.writeFileSync(
      path.join(repoRoot, "benchmark.sh"),
      "#!/usr/bin/env bash\necho intentional benchmark failure >&2\nexit 19\n",
    );
    fs.chmodSync(path.join(repoRoot, "benchmark.sh"), 0o755);
    commitFixtureChange(repoRoot, "benchmark.sh", "break benchmark");

    const summary = await harness.orchestrator.runLoop();

    expect(summary!.improved).toBe(false);
    expect(summary!.ideas.map((idea) => idea.status)).toEqual(["failed", "failed"]);
    expect(loadState(harness.stateDir)).toMatchObject({
      bestScore: 10,
      bestSubmittedScore: null,
      dryLoopStreak: 1,
    });
    expect(mySubmissions(repoRoot)).toEqual([]);
    expect(
      fs.readFileSync(
        candidateRunPaths(harness.stateDir, "L001-I1").benchmarkLog,
        "utf8",
      ),
    ).toContain("intentional benchmark failure");
  });

  it("runs idea implementations concurrently and then honors an advisor blocker", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "parallel-blocker");

    const summary = await harness.orchestrator.runLoop();
    const state = loadState(harness.stateDir)!;

    expect(summary!.ideas).toHaveLength(2);
    expect(state).toMatchObject({
      phase: "paused",
      loop: 1,
      history: [{ advisorNotes: ["[blocker] Human review required after parallel work."] }],
    });
    expect(
      harness.events.some(
        (event) =>
          event.type === "advice" &&
          event.notes.some((note) => note.severity === "blocker"),
      ),
    ).toBe(true);

    const implementationRecords = readRecords(recordPath).filter(
      (record) => record.event === "start" || record.event === "end",
    );
    const starts = implementationRecords.filter((record) => record.event === "start");
    const ends = implementationRecords.filter((record) => record.event === "end");
    expect(starts.map((record) => record.idea).sort()).toEqual(["L001-I1", "L001-I2"]);
    expect(ends.map((record) => record.idea).sort()).toEqual(["L001-I1", "L001-I2"]);
    expect(Math.max(...starts.map((record) => record.at as number))).toBeLessThan(
      Math.min(...ends.map((record) => record.at as number)),
    );
  });

  it.each([
    "loop.syncing",
    "loop.proposing",
    "loop.ideas",
    "loop.finalizing",
    "loop.end",
  ] as const)("resumes the same loop after aborting in %s", async (phase) => {
    const harness = await makeSubprocessHarness(repoRoot, "resume-improve", {
      maxVerifyAttempts: 1,
      advisor: { enabled: false, watchdogFile: "WATCHDOG.md" },
    });
    const controller = new AbortController();
    const interrupted = harness.makeOrchestrator(controller.signal, (event) => {
      if (event.type === "phase" && event.phase === phase) controller.abort();
    });

    await expect(interrupted.runLoop()).resolves.toBeNull();
    expect(loadState(harness.stateDir)).toMatchObject({ phase: "paused", loop: 1 });

    const summary = await harness.makeOrchestrator().runLoop();
    expect(summary).toMatchObject({ loop: 1, improved: true });
    const completed = loadState(harness.stateDir)!;
    expect(completed).toMatchObject({
      loop: 1,
      bestScore: 0,
      bestSubmittedScore: 0,
      history: [{ loop: 1, improved: true }],
    });
    expect(completed.resumePhase).toBeUndefined();
    expect(completed.pendingSummary).toBeUndefined();
    expect(mySubmissions(repoRoot).map((submission) => submission.score)).toEqual([0]);
    expect(fs.readdirSync(path.join(harness.stateDir, "worktrees"))).toEqual([]);
  });

  it("does not submit twice when aborted immediately after submission", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "resume-improve", {
      maxVerifyAttempts: 1,
      advisor: { enabled: false, watchdogFile: "WATCHDOG.md" },
    });
    const controller = new AbortController();
    const interrupted = harness.makeOrchestrator(controller.signal, (event) => {
      if (event.type === "submitted") controller.abort();
    });

    await expect(interrupted.runLoop()).resolves.toBeNull();
    expect(mySubmissions(repoRoot).map((submission) => submission.score)).toEqual([0]);

    // Simulate a paused v1 state written before resumePhase existed.
    const stateFile = statePaths(harness.stateDir).state;
    const legacyState = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      resumePhase?: string;
    };
    delete legacyState.resumePhase;
    fs.writeFileSync(stateFile, JSON.stringify(legacyState, null, 2) + "\n");

    const summary = await harness.makeOrchestrator().runLoop();
    expect(summary).toMatchObject({ loop: 1, improved: true });
    expect(mySubmissions(repoRoot).map((submission) => submission.score)).toEqual([0]);
    const completed = loadState(harness.stateDir)!;
    expect(completed).toMatchObject({
      history: [{ loop: 1, improved: true }],
    });
    expect(completed.pendingSummary).toBeUndefined();
    expect(fs.readdirSync(path.join(harness.stateDir, "worktrees"))).toEqual([]);
  });

  it("resumes a killed implementation without consuming an attempt or orphaning its worktree", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "resume-improve", {
      maxVerifyAttempts: 1,
      advisor: { enabled: false, watchdogFile: "WATCHDOG.md" },
    });
    process.env.FAKE_PI_HOLD_IMPLEMENT = "1";
    const controller = new AbortController();
    const running = harness.makeOrchestrator(controller.signal).runLoop();

    await waitForRecord(
      recordPath,
      (record) => record.event === "start" && record.idea === "L001-I1",
    );
    delete process.env.FAKE_PI_HOLD_IMPLEMENT;
    controller.abort();

    await expect(running).resolves.toBeNull();
    const paused = loadState(harness.stateDir)!;
    expect(paused).toMatchObject({
      phase: "paused",
      resumePhase: "loop.ideas",
      ideas: [{ id: "L001-I1", verifyAttempts: 0 }],
    });
    expect(paused.ideas[0]?.worktreePath).toBeDefined();
    expect(fs.existsSync(paused.ideas[0]!.worktreePath!)).toBe(true);

    const summary = await harness.makeOrchestrator().runLoop();
    expect(summary).toMatchObject({ loop: 1, improved: true });
    expect(mySubmissions(repoRoot).map((submission) => submission.score)).toEqual([0]);
    expect(fs.readdirSync(path.join(harness.stateDir, "worktrees"))).toEqual([]);
  });

  it("resumes an interrupted God turn without replaying loop bookkeeping", async () => {
    const harness = await makeSubprocessHarness(repoRoot, "resume-god", {
      maxVerifyAttempts: 1,
      godTriggerThreshold: 1,
      advisor: { enabled: false, watchdogFile: "WATCHDOG.md" },
    });
    const controller = new AbortController();
    const interrupted = harness.makeOrchestrator(controller.signal, (event) => {
      if (event.type === "phase" && event.phase === "god") controller.abort();
    });

    await expect(interrupted.runLoop()).resolves.toBeNull();
    expect(loadState(harness.stateDir)).toMatchObject({ phase: "paused", loop: 1 });

    const summary = await harness.makeOrchestrator().runLoop();
    expect(summary).toMatchObject({
      loop: 1,
      improved: false,
      godConversation: "notes/god-001.md",
    });
    expect(loadState(harness.stateDir)).toMatchObject({
      loop: 1,
      dryLoopStreak: 0,
      history: [{ loop: 1, improved: false }],
    });
    expect(loadState(harness.stateDir)!.pendingSummary).toBeUndefined();
    expect(mySubmissions(repoRoot)).toEqual([]);
    expect(fs.readdirSync(path.join(harness.stateDir, "worktrees"))).toEqual([]);
  });

  async function makeSubprocessHarness(
    root: string,
    scenario: Scenario,
    patch: Partial<HarnessConfig> = {},
  ): Promise<SubprocessHarness> {
    process.env.FAKE_PI_SCENARIO = scenario;
    const { stateDir, config } = await initChallenge({
      repoRoot: root,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });
    Object.assign(config, {
      runner: "subprocess",
      godTriggerThreshold: 0,
    }, patch);
    writeTestPrompts(stateDir);
    config.roles.professor.prompt = ".autoresearch/prompts/test-professor.md";
    config.roles.phd.prompt = ".autoresearch/prompts/test-phd.md";
    config.roles.advisor.prompt = ".autoresearch/prompts/test-advisor.md";
    config.roles.god.prompt = ".autoresearch/prompts/test-god.md";

    const events: OrchestratorEvent[] = [];
    const makeOrchestrator = (
      signal?: AbortSignal,
      observe?: (event: OrchestratorEvent) => void,
    ) => {
      const manifest = readManifest(root);
      return new Orchestrator(root, stateDir, config, {
        runner: new PiSubprocessRunner(config.roles, {
          timeoutMs: 5_000,
          killGraceMs: 50,
        }),
        adapter: new YukonCliAdapter({
          repoRoot: root,
          manifest,
          cli: detectCli(root, manifest),
          verifyCommand: "./verify.sh",
          benchCommand: "./benchmark.sh",
          execution: config.execution,
          logDir: statePaths(stateDir).logsDir,
          exec: nodeExec,
        }),
        exec: nodeExec,
        emit: (event) => {
          events.push(event);
          observe?.(event);
        },
        signal,
      });
    };
    return {
      stateDir,
      events,
      orchestrator: makeOrchestrator(),
      makeOrchestrator,
    };
  }
});

function writeTestPrompts(stateDir: string): void {
  const promptDir = path.join(stateDir, "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "test-professor.md"),
    ["KIND={{kind}}", "LOOP={{loop}}", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(promptDir, "test-phd.md"),
    [
      "KIND={{kind}}",
      "IDEA={{ideaId}}",
      "ATTEMPT={{attempt}}",
      "NOTE={{notePath}}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(promptDir, "test-advisor.md"),
    ["KIND={{kind}}", "SUMMARY={{summary}}", ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(promptDir, "test-god.md"),
    ["KIND={{kind}}", "NOTE={{notePath}}", ""].join("\n"),
  );
}

function writeScenarioPi(shimPath: string): void {
  fs.writeFileSync(
    shimPath,
    String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const scenario = process.env.FAKE_PI_SCENARIO;
const recordPath = process.env.FAKE_PI_RECORD;
const prompt = process.argv.at(-1) || "";
const field = (name) => prompt.match(new RegExp("^" + name + "=(.*)$", "m"))?.[1] || "";
const kind = field("KIND");
const idea = field("IDEA");
const fence = String.fromCharCode(96).repeat(3);

function record(event, extra = {}) {
  fs.appendFileSync(recordPath, JSON.stringify({ event, at: Date.now(), ...extra }) + "\n");
}

function respond(text, structured) {
  const output = structured === undefined
    ? text
    : text + "\n" + fence + "json\n" + JSON.stringify(structured) + "\n" + fence;
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: output }],
      usage: { cost: { total: 0 } },
    },
  }) + "\n");
}

if (kind === "propose") {
  const ideas = scenario === "zero-ideas"
    ? []
    : scenario === "resume-improve" || scenario === "resume-god"
      ? [{ title: "Resume candidate", spec: "Exercise phase-safe resume." }]
      : [
        { title: "Candidate A", spec: "Try a valid but worse point." },
        { title: "Candidate B", spec: "Replay the baseline." },
      ];
  respond("Proposed " + ideas.length + " ideas.", { ideas });
} else if (kind === "implement") {
  record("start", { idea });
  if (process.env.FAKE_PI_HOLD_IMPLEMENT === "1") {
    const until = Date.now() + 5000;
    while (Date.now() < until) {}
  }
  if (scenario === "phd-crash" && idea === "L001-I1") {
    const until = Date.now() + 75;
    while (Date.now() < until) {}
    record("crash", { idea });
    process.stderr.write("simulated provider crash during implementation\n");
    process.exit(7);
  }
  if (scenario === "parallel-blocker") {
    const barrierDeadline = Date.now() + 3000;
    while (Date.now() < barrierDeadline) {
      const records = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, "utf8") : "";
      if ((records.match(/"event":"start"/g) || []).length >= 2) break;
    }
    const overlapWindow = Date.now() + 25;
    while (Date.now() < overlapWindow) {}
  }
  const params = scenario === "resume-improve"
    ? { algorithm: "resume-optimum", x: 3, y: -1 }
    : scenario === "resume-god"
      ? { algorithm: "resume-baseline", x: 0, y: 0 }
      : idea === "L001-I1"
        ? { algorithm: "candidate-a", x: -2, y: 2 }
        : { algorithm: "candidate-b", x: 0, y: 0 };
  const paramsPath = path.join(process.cwd(), "src", "solution", "params.json");
  fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2) + "\n");
  record("end", { idea });
  respond("Implemented " + idea + ".");
} else if (kind === "write-note") {
  const notePath = field("NOTE");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, "# Fake hypothesis note\n");
  respond("Recorded a hypothesis note.");
} else if (kind === "advise") {
  const notes = scenario === "parallel-blocker"
    ? [{ severity: "blocker", text: "Human review required after parallel work." }]
    : [];
  respond("Advisor reviewed the loop.", { notes });
} else if (kind === "god-conversation") {
  const notePath = field("NOTE");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, "# Resumed God conversation\n");
  respond("God restored the research direction.");
} else {
  process.stderr.write("unexpected fake pi prompt:\n" + prompt + "\n");
  process.exit(64);
}
`,
  );
  fs.chmodSync(shimPath, 0o755);
}

function commitFixtureChange(repoRoot: string, file: string, message: string): void {
  execFileSync("git", ["add", file], { cwd: repoRoot, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message, "--no-gpg-sign"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function mySubmissions(repoRoot: string): { score: number }[] {
  const file = path.join(repoRoot, ".mockchal", "submissions.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    submissions: Array<{ author: string; score: number }>;
  };
  return parsed.submissions.filter((submission) => submission.author === "me");
}

function readRecords(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForRecord(
  filePath: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readRecords(filePath).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fake Pi record in ${filePath}`);
}

function restoreEnv(
  name: "FAKE_PI_SCENARIO" | "FAKE_PI_RECORD" | "FAKE_PI_HOLD_IMPLEMENT",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
