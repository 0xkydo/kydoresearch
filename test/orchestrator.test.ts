import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { AgentRunner, AgentTask } from "../src/agents/types.ts";
import { candidateRunPaths, readLedger, readRunRecord } from "../src/archive.ts";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../src/challenge/detect.ts";
import type { HarnessConfig } from "../src/config.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import type { OrchestratorEvent } from "../src/orchestrator.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import type { Idea } from "../src/state.ts";
import { loadState, saveState } from "../src/state.ts";
import { setOperatorSteering } from "../src/steering.ts";
import { readTelemetry } from "../src/telemetry.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

interface Harness {
  repoRoot: string;
  stateDir: string;
  config: HarnessConfig;
  events: OrchestratorEvent[];
  makeOrchestrator: (
    signal?: AbortSignal,
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) => Orchestrator;
}

async function makeHarness(
  repoRoot: string,
  configPatch: Partial<HarnessConfig> = {},
  runner: AgentRunner = new MockAgentRunner(),
): Promise<Harness> {
  const { stateDir, config } = await initChallenge({ repoRoot, runner, exec: nodeExec });
  Object.assign(config, configPatch);
  const manifest = readManifest(repoRoot);
  const events: OrchestratorEvent[] = [];
  const makeOrchestrator = (
    signal?: AbortSignal,
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) =>
    new Orchestrator(repoRoot, stateDir, config, {
      runner,
      adapter: new YukonCliAdapter({
        repoRoot,
        manifest,
        cli: detectCli(repoRoot, manifest),
        verifyCommand: "./verify.sh",
        benchCommand: "./benchmark.sh",
        exec: nodeExec,
      }),
      exec: nodeExec,
      emit: (ev) => events.push(ev),
      signal,
      delay: delay ?? (async () => {}),
    });
  return { repoRoot, stateDir, config, events, makeOrchestrator };
}

function mySubmissions(repoRoot: string): { score: number; note: string }[] {
  const file = path.join(repoRoot, ".mockchal", "submissions.json");
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { submissions: { author: string; score: number; note: string }[] };
  return data.submissions.filter((s) => s.author === "me");
}

const mockExamplesRoot = path.resolve(
  fileURLToPath(import.meta.url),
  "../../examples/mock-challenges",
);

describe("Orchestrator scenario matrix", () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = makeTmpChallenge()));
  afterEach(() => cleanup());

  it("loop 1: parallel ideas isolated in worktrees; fail-3x and no-improvement paths", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    const summary = await orchestrator.runLoop();

    expect(summary).not.toBeNull();
    expect(summary!.improved).toBe(false);
    const byId = Object.fromEntries(summary!.ideas.map((i) => [i.id, i]));

    // I1: out-of-bounds edit -> verify failed 3x -> failed.
    expect(byId["L001-I1"]!.status).toBe("failed");
    // I2: valid but worse (34 vs baseline 10) -> no improvement.
    expect(byId["L001-I2"]!.status).toBe("done-no-improvement");

    const state = loadState(h.stateDir)!;
    expect(state.bestScore).toBe(10); // baseline from init
    expect(state.dryLoopStreak).toBe(1);
    expect(mySubmissions(repoRoot).length).toBe(0);

    // Isolation: PhD edits stayed in worktrees; main repo params untouched.
    const params = JSON.parse(fs.readFileSync(path.join(repoRoot, "src/solution/params.json"), "utf8"));
    expect(params.algorithm).toBe("baseline-guess");

    // Failed idea's worktree kept for debugging; the other pruned.
    expect(fs.existsSync(path.join(h.stateDir, "worktrees", "L001-I1"))).toBe(true);
    expect(fs.existsSync(path.join(h.stateDir, "worktrees", "L001-I2"))).toBe(false);

    // Hypothesis notes exist for both non-winning ideas.
    expect(fs.existsSync(path.join(h.stateDir, "notes", "loop-001-L001-I1.md"))).toBe(true);
    expect(fs.existsSync(path.join(h.stateDir, "notes", "loop-001-L001-I2.md"))).toBe(true);

    // Every terminal candidate is sealed with evidence before successful
    // worktrees are pruned.
    for (const ideaId of ["L001-I1", "L001-I2"]) {
      const run = candidateRunPaths(h.stateDir, ideaId);
      expect(readRunRecord(h.stateDir, ideaId).status).toBe("sealed");
      for (const artifact of [
        run.task,
        run.proposal,
        run.parent,
        run.source,
        run.diff,
        run.metrics,
        run.integrity,
        run.postmortem,
        run.verifyLog,
        run.benchmarkLog,
      ]) {
        expect(fs.existsSync(artifact), artifact).toBe(true);
      }
    }
    expect(readLedger(h.stateDir).map((entry) => entry.candidateId)).toEqual([
      "L001-I1",
      "L001-I2",
    ]);
  });

  it("loop 2: verify-retry-then-pass, best-of-two winner submits, loser superseded", async () => {
    const h = await makeHarness(repoRoot);
    const initialized = loadState(h.stateDir)!;
    initialized.challenge.localEvaluation = {
      fidelity: "reduced",
      decision: "Use the documented reduced local regression mode.",
      limitations: ["The official evaluator path is not exercised locally."],
      officialValidationRequired: true,
    };
    saveState(h.stateDir, initialized);
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runLoop(); // loop 1 (dry)
    const summary = await orchestrator.runLoop(); // loop 2

    const byId = Object.fromEntries(summary!.ideas.map((i) => [i.id, i]));
    // I1 fails verify on attempt 1 (missing algorithm key), passes on attempt 2, scores 2.
    expect(byId["L002-I1"]!.status).toBe("done-improved");
    expect(byId["L002-I1"]!.localScore).toBe(2);
    // I2 also improves (4 < baseline 10) but loses to I1.
    expect(byId["L002-I2"]!.status).toBe("done-superseded");

    const state = loadState(h.stateDir)!;
    expect(state.bestScore).toBe(2);
    expect(state.dryLoopStreak).toBe(0);

    // Only the loop-2 winner submitted.
    const subs = mySubmissions(repoRoot);
    expect(subs.map((s) => s.score)).toEqual([2]);
    expect(subs[0]!.note).toContain("# Submission:");
    for (const heading of [
      "## Attribution",
      "## Goal and starting point",
      "## Hypothesis and approach",
      "## Implementation",
      "## Verification and measured results",
      "## Reproduction",
      "## Failures and course corrections",
      "## Caveats",
      "## Next step",
    ]) {
      expect(subs[0]!.note).toContain(heading);
    }
    expect(subs[0]!.note).toContain("reduced local validation command");
    expect(subs[0]!.note).toContain(
      "The official challenge evaluator remains required for correctness and acceptance.",
    );
    expect(subs[0]!.note).not.toContain("The candidate passed the first harness verification");

    // Retry was real: journal contains a verify-failed line for L002-I1.
    const journal = fs.readFileSync(path.join(h.stateDir, "journal.ndjson"), "utf8");
    expect(journal).toContain("L002-I1");
    expect(journal).toMatch(/verify failed \(attempt 1/);

    const flows = new Set(
      readTelemetry(path.join(h.stateDir, "telemetry.ndjson")).map((span) => span.flow),
    );
    for (const flow of [
      "loop.total",
      "challenge.sync",
      "professor.propose",
      "phd.implement",
      "challenge.verify",
      "challenge.benchmark",
      "challenge.submit",
      "advisor.review",
    ]) {
      expect(flows).toContain(flow);
    }
  });

  it("maximization applies minImprovement and selects the highest qualifying score", async () => {
    const manifestPath = path.join(repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { direction: string };
    manifest.direction = "+";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(repoRoot, "benchmark.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./verify.sh
node - <<'EOF'
const fs = require("fs");
const params = JSON.parse(fs.readFileSync("src/solution/params.json", "utf8"));
const scores = new Map([
  ["0,0", 100],
  ["-2,2", 90],
  ["2,0", 106],
  ["1,-1", 104],
]);
const score = scores.get(\`\${params.x},\${params.y}\`) ?? 100;
fs.writeFileSync("score.json", JSON.stringify({ score }) + "\\n");
EOF
`,
    );
    execFileSync("git", ["add", "benchmark.json", "benchmark.sh"], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "maximize fixture", "--no-gpg-sign"], {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

    const h = await makeHarness(repoRoot, { minImprovement: 0.05 });
    const orchestrator = h.makeOrchestrator();
    expect((await orchestrator.runLoop())!.improved).toBe(false); // 90 is worse than baseline 100
    const summary = await orchestrator.runLoop();
    const byId = Object.fromEntries(summary!.ideas.map((idea) => [idea.id, idea]));

    expect(summary!.improved).toBe(true);
    expect(byId["L002-I1"]).toMatchObject({ status: "done-improved", localScore: 106 });
    expect(byId["L002-I2"]).toMatchObject({ status: "done-no-improvement", localScore: 104 });
    const state = loadState(h.stateDir)!;
    expect(state.challenge.direction).toBe("+");
    expect(state.bestScore).toBe(106);
    expect(state.bestSubmittedScore).toBe(106);
  });

  it("three dry loops send the Professor to church; streak resets; the next loop improves", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    for (let i = 0; i < 5; i++) await orchestrator.runLoop(); // loops 1-5

    let state = loadState(h.stateDir)!;
    // Loops 3,4,5 are baseline replays (score 10 vs best 2): dry x3 -> church after loop 5.
    const churchNote = path.join(h.stateDir, "notes", "church-005.md");
    expect(fs.existsSync(churchNote)).toBe(true);
    expect(fs.readFileSync(churchNote, "utf8")).toContain("**God:**");
    expect(state.dryLoopStreak).toBe(0); // reset by the conversation
    expect(h.events.some((e) => e.type === "church")).toBe(true);

    // Loop 6 converges to the optimum after church.
    const summary = await orchestrator.runLoop();
    expect(summary!.improved).toBe(true);
    state = loadState(h.stateDir)!;
    expect(state.bestScore).toBe(0);
    expect(mySubmissions(repoRoot).some((s) => s.score === 0)).toBe(true);
  });

  it("uses the sealed winning candidate as the explicit parent in later loops", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runLoop();
    await orchestrator.runLoop();

    expect(loadState(h.stateDir)!.bestCandidateId).toBe("L002-I1");
    const winningSource = candidateRunPaths(h.stateDir, "L002-I1").source;
    expect(
      JSON.parse(
        fs.readFileSync(path.join(winningSource, "src", "solution", "params.json"), "utf8"),
      ),
    ).toMatchObject({ algorithm: "coord-descent-x", x: 2, y: 0 });

    await orchestrator.runLoop();
    const loop3 = readLedger(h.stateDir).filter((entry) => entry.candidateId.startsWith("L003-"));
    expect(loop3).not.toHaveLength(0);
    expect(loop3.every((entry) => entry.parentCandidateId === "L002-I1")).toBe(true);
    for (const entry of loop3) {
      expect(
        JSON.parse(
          fs.readFileSync(candidateRunPaths(h.stateDir, entry.candidateId).parent, "utf8"),
        ),
      ).toMatchObject({
        candidateId: entry.candidateId,
        parentCandidateId: "L002-I1",
        parentSourcePath: winningSource,
      });
    }
  });

  it("replays a persisted professor result without conflicting partial runs", async () => {
    const h = await makeHarness(repoRoot);
    const state = loadState(h.stateDir)!;
    state.loop = 1;
    saveState(h.stateDir, state);

    const first = h.makeOrchestrator() as unknown as {
      propose(): Promise<void>;
    };
    await first.propose();
    const materialized = loadState(h.stateDir)!.ideas;
    expect(materialized).toHaveLength(2);
    expect(
      fs.existsSync(path.join(h.stateDir, "loops", "loop-001", "professor-result.json")),
    ).toBe(true);

    // Simulate a process loss after immutable run files were created but
    // before state.ideas became durable.
    const interrupted = loadState(h.stateDir)!;
    interrupted.ideas = [];
    saveState(h.stateDir, interrupted);

    const resumed = h.makeOrchestrator() as unknown as {
      propose(): Promise<void>;
    };
    await expect(resumed.propose()).resolves.toBeUndefined();
    expect(loadState(h.stateDir)!.ideas).toMatchObject(
      materialized.map((idea) => ({
        id: idea.id,
        title: idea.title,
        parentCandidateId: idea.parentCandidateId,
        proposalFile: idea.proposalFile,
      })),
    );
  });

  it("snapshots operator steering into the immutable Professor task", async () => {
    const h = await makeHarness(repoRoot);
    const state = loadState(h.stateDir)!;
    state.loop = 1;
    saveState(h.stateDir, state);
    setOperatorSteering(
      h.stateDir,
      "Prioritize a cache-local representation experiment.",
      "2026-07-26T10:00:00.000Z",
    );

    const first = h.makeOrchestrator() as unknown as {
      propose(): Promise<void>;
    };
    await first.propose();
    const taskPath = path.join(
      h.stateDir,
      "loops",
      "loop-001",
      "professor-task.json",
    );
    expect(JSON.parse(fs.readFileSync(taskPath, "utf8")).input.operatorSteering).toEqual({
      text: "Prioritize a cache-local representation experiment.",
      updatedAt: "2026-07-26T10:00:00.000Z",
    });

    setOperatorSteering(
      h.stateDir,
      "Replace the current direction after the task already exists.",
      "2026-07-26T11:00:00.000Z",
    );
    const interrupted = loadState(h.stateDir)!;
    interrupted.ideas = [];
    saveState(h.stateDir, interrupted);

    const resumed = h.makeOrchestrator() as unknown as {
      propose(): Promise<void>;
    };
    await resumed.propose();
    expect(JSON.parse(fs.readFileSync(taskPath, "utf8")).input.operatorSteering).toEqual({
      text: "Prioritize a cache-local representation experiment.",
      updatedAt: "2026-07-26T10:00:00.000Z",
    });
  });

  it("repairs a missing ledger append for an already sealed candidate", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    const summary = await orchestrator.runLoop();
    const candidate = summary!.ideas[1]!;
    const remaining = readLedger(h.stateDir).filter(
      (entry) => entry.candidateId !== candidate.id,
    );
    fs.writeFileSync(
      path.join(h.stateDir, "ledger.ndjson"),
      remaining.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    const idea: Idea = {
      id: candidate.id,
      loop: 1,
      title: candidate.title,
      parentCandidateId: "baseline",
      specFile: "ideas/loop-001/idea-2.md",
      status: candidate.status,
      verifyAttempts: 1,
      localScore: candidate.localScore,
      comparisonScore: 10,
    };
    const internal = h.makeOrchestrator() as unknown as {
      archiveIdea(candidateIdea: Idea): Promise<void>;
    };
    await internal.archiveIdea(idea);

    expect(
      readLedger(h.stateDir).filter((entry) => entry.candidateId === candidate.id),
    ).toHaveLength(1);
    expect(idea.archivedAt).toBeTruthy();
  });

  it("snapshots repository instructions and makes postmortems read-only", async () => {
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "Only edit declared candidate paths.\n");
    fs.writeFileSync(
      path.join(repoRoot, "src", "solution", "AGENTS.md"),
      "Solution changes must retain the JSON schema.\n",
    );
    fs.mkdirSync(path.join(repoRoot, "src", "solution", "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "src", "solution", "nested", "CLAUDE.md"),
      "Nested solution evidence must remain reproducible.\n",
    );
    class RecordingRunner implements AgentRunner {
      readonly tasks: AgentTask[] = [];
      private readonly delegate = new MockAgentRunner();

      run(task: AgentTask) {
        this.tasks.push(task);
        return this.delegate.run(task);
      }
    }
    const runner = new RecordingRunner();
    const h = await makeHarness(repoRoot, {}, runner);
    await h.makeOrchestrator().runLoop();

    const implementations = runner.tasks.filter((task) => task.kind === "implement");
    expect(implementations.length).toBeGreaterThan(0);
    for (const task of implementations) {
      const instructions = task.input.repositoryInstructionPaths as string[];
      expect(instructions).toHaveLength(3);
      expect(instructions).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /\.autoresearch\/runs\/L001-I[12]\/agent\/repository-instructions\/AGENTS\.md$/,
          ),
          expect.stringMatching(
            /repository-instructions\/src\/solution\/AGENTS\.md$/,
          ),
          expect.stringMatching(
            /repository-instructions\/src\/solution\/nested\/CLAUDE\.md$/,
          ),
        ]),
      );
      expect(instructions.map((instruction) => fs.readFileSync(instruction, "utf8")).join("\n"))
        .toContain("Only edit declared");
    }

    const postmortems = runner.tasks.filter((task) => task.kind === "write-note");
    expect(postmortems).toHaveLength(2);
    for (const task of postmortems) {
      expect(task.tools).toEqual(["read"]);
      expect(task.cwd).toMatch(/\.autoresearch\/runs\/L001-I[12]$/);
      expect(task.cwd).not.toBe(repoRoot);
    }
  });

  it("church trigger disabled when threshold is 0", async () => {
    const h = await makeHarness(repoRoot, { churchTriggerThreshold: 0 });
    const orchestrator = h.makeOrchestrator();
    for (let i = 0; i < 5; i++) await orchestrator.runLoop();
    expect(fs.existsSync(path.join(h.stateDir, "notes", "church-005.md"))).toBe(false);
    expect(loadState(h.stateDir)!.dryLoopStreak).toBe(3);
  });

  it("advisor fires WATCHDOG rules and writes notes", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runLoop(); // loop 1: failed idea
    await orchestrator.runLoop(); // loop 2: submission

    const adviceEvents = h.events.filter((e) => e.type === "advice") as Extract<
      OrchestratorEvent,
      { type: "advice" }
    >[];
    expect(adviceEvents.length).toBe(2);
    const loop1Texts = adviceEvents[0]!.notes.map((n) => n.text);
    expect(loop1Texts.some((t) => t.includes("Verify failures"))).toBe(true); // ideaFailed rule
    const loop2Texts = adviceEvents[1]!.notes.map((n) => n.text);
    expect(loop2Texts.some((t) => t.includes("leaderboard reflects"))).toBe(true); // submitted rule
    expect(fs.existsSync(path.join(h.stateDir, "notes", "advisor-001.md"))).toBe(true);
    expect(fs.existsSync(path.join(h.stateDir, "notes", "advisor-002.md"))).toBe(true);
  });

  it("advisor blocker pauses the loop", async () => {
    fs.writeFileSync(
      path.join(repoRoot, "WATCHDOG.md"),
      ["severity-threshold: nit", "rules:", "- if: submitted", "  severity: blocker", '  text: "Stop and review every submission manually."'].join("\n"),
    );
    const h = await makeHarness(repoRoot, { maxLoops: 10 });
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runUntilDone();
    const state = loadState(h.stateDir)!;
    expect(state.phase).toBe("paused"); // blocker on loop 2's submission stopped the run
    expect(state.loop).toBe(2);
  });

  it("maxLoops terminates the run as done", async () => {
    const h = await makeHarness(repoRoot, { maxLoops: 2, advisor: { enabled: false, watchdogFile: "WATCHDOG.md" } });
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runUntilDone();
    const state = loadState(h.stateDir)!;
    expect(state.phase).toBe("done");
    expect(state.loop).toBe(2);
    expect(state.history.length).toBe(2);
  });

  it("applies the configured delay after each completed mock loop", async () => {
    const h = await makeHarness(
      repoRoot,
      { maxLoops: 1, mockLoopDelayMs: 1_234 } as Partial<HarnessConfig>,
    );
    h.config.resilience.retryBaseDelayMs = 0;
    h.config.resilience.retryMaxDelayMs = 0;
    const delays: number[] = [];
    const orchestrator = h.makeOrchestrator(undefined, async (ms) => {
      delays.push(ms);
    });

    await orchestrator.runUntilDone();

    expect(delays.filter((ms) => ms > 0)).toEqual([1_234]);
    expect(loadState(h.stateDir)!.phase).toBe("done");
  });

  it("aborts a long mock-loop delay promptly and persists paused state", async () => {
    const h = await makeHarness(
      repoRoot,
      { maxLoops: 2, mockLoopDelayMs: 60_000 } as Partial<HarnessConfig>,
    );
    const controller = new AbortController();
    h.events.push = ((orig) =>
      function (this: OrchestratorEvent[], ev: OrchestratorEvent) {
        if (ev.type === "log" && ev.message.startsWith("mock demo: waiting")) {
          controller.abort();
        }
        return orig.call(this, ev);
      })(h.events.push) as typeof h.events.push;
    const orchestrator = h.makeOrchestrator(controller.signal);

    await orchestrator.runUntilDone();

    expect(loadState(h.stateDir)).toMatchObject({ phase: "paused", loop: 1 });
  });

  it("abort mid-loop pauses; resume completes without duplicate submissions", async () => {
    const h = await makeHarness(repoRoot);

    // Abort as soon as the professor has proposed (ideas in flight).
    const controller = new AbortController();
    const orchestrator = h.makeOrchestrator(controller.signal);
    const unsub = (ev: OrchestratorEvent) => {
      if (ev.type === "phase" && ev.phase === "loop.ideas") controller.abort();
    };
    h.events.push = ((orig) =>
      function (this: OrchestratorEvent[], ev: OrchestratorEvent) {
        unsub(ev);
        return orig.call(this, ev);
      })(h.events.push) as typeof h.events.push;

    await orchestrator.runLoop();
    let state = loadState(h.stateDir)!;
    expect(state.phase).toBe("paused");
    expect(state.loop).toBe(1);
    expect(mySubmissions(repoRoot).length).toBe(0);

    // Resume with a fresh orchestrator (fresh process semantics).
    const resumed = h.makeOrchestrator();
    let summary = await resumed.runLoop();
    expect(summary).not.toBeNull();
    expect(summary!.loop).toBe(1); // resumed, not restarted
    state = loadState(h.stateDir)!;
    expect(state.history.length).toBe(1);
    expect(mySubmissions(repoRoot).length).toBe(0); // loop 1 is dry

    // Loop 2 then proceeds normally and submits exactly once.
    summary = await resumed.runLoop();
    expect(summary!.loop).toBe(2);
    expect(mySubmissions(repoRoot).length).toBe(1);
  });

  it("status report reflects state for the dashboard", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runLoop();
    const report = orchestrator.status();
    expect(report.loop).toBe(1);
    expect(report.bestScore).toBe(10); // baseline; loop 1 is dry
    expect(report.churchTriggerThreshold).toBe(3);
    expect(report.lastAdvisorNotes.length).toBeGreaterThan(0);
  });

  it("knowledge base accrues leaderboard digests, idea outcomes, and advisor notes", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    await orchestrator.runLoop();
    await orchestrator.runLoop();
    const kb = fs.readFileSync(path.join(h.stateDir, "knowledge-base.md"), "utf8");
    expect(kb).toContain("Loop 1 leaderboard");
    expect(kb).toContain("competitor"); // seeded entries ingested
    expect(kb).toContain("Loop 2 submission");
    expect(kb).toContain("Advisor, loop 1");
  });
});

describe("declarative mock challenge examples", () => {
  it("offers a one-command launcher with aliases and a selected-only preparation mode", () => {
    const destination = fs.mkdtempSync(
      path.join(os.tmpdir(), "kydoresearch-mock-launcher-"),
    );
    const fakePi = path.join(destination, "fake-pi");
    fs.writeFileSync(fakePi, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(fakePi, 0o755);
    try {
      const output = execFileSync(
        "bash",
        [
          path.resolve(mockExamplesRoot, "../../scripts/mock-demo.sh"),
          "ranking",
          "--prepare-only",
          "--destination",
          destination,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, KYDORESEARCH_PI: fakePi },
        },
      );

      expect(output).toContain("Selected: ranking-quality");
      expect(output).toContain(`Pi: ${fakePi}`);
      expect(output).toContain("/autoresearch");
      expect(fs.existsSync(path.join(destination, "ranking-quality", ".git"))).toBe(true);
      expect(fs.existsSync(path.join(destination, "latency-lab"))).toBe(false);
      expect(readManifest(path.join(destination, "ranking-quality")).direction).toBe("+");
    } finally {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "latency-lab",
      baseline: 320,
      loopTwoBest: 232,
      direction: "-",
    },
    {
      name: "ranking-quality",
      baseline: 0.905,
      loopTwoBest: 0.995,
      direction: "+",
    },
    {
      name: "memory-packer",
      baseline: 468,
      loopTwoBest: 324,
      direction: "-",
    },
  ])(
    "prepares and runs the first two $name loops without a model call",
    async ({ name, baseline, loopTwoBest, direction }) => {
      const destination = fs.mkdtempSync(
        path.join(os.tmpdir(), "kydoresearch-mock-examples-"),
      );
      try {
        execFileSync(
          "bash",
          [path.join(mockExamplesRoot, "prepare.sh"), destination],
          { stdio: "pipe" },
        );
        const repoRoot = path.join(destination, name);
        const manifest = readManifest(repoRoot);
        expect(manifest.direction).toBe(direction);
        expect(detectCli(repoRoot, manifest)).toBe("./bin/mockchal");

        const h = await makeHarness(repoRoot);
        expect(loadState(h.stateDir)!.bestScore).toBe(baseline);
        const orchestrator = h.makeOrchestrator();
        const first = await orchestrator.runLoop();
        expect(first).toMatchObject({ improved: false });
        expect(first!.ideas.map((idea) => idea.status)).toEqual([
          "failed",
          "done-no-improvement",
        ]);

        const second = await orchestrator.runLoop();
        expect(second).toMatchObject({ improved: true });
        expect(loadState(h.stateDir)).toMatchObject({
          bestScore: loopTwoBest,
          bestSubmittedScore: loopTwoBest,
        });
        expect(second!.ideas.map((idea) => idea.status)).toEqual([
          "done-improved",
          "done-superseded",
        ]);
        expect(mySubmissions(repoRoot).map((entry) => entry.score)).toEqual([
          loopTwoBest,
        ]);

        if (name === "latency-lab") {
          await orchestrator.runLoop();
          await orchestrator.runLoop();
          await orchestrator.runLoop();
          const churchNote = path.join(
            h.stateDir,
            "notes",
            "church-005.md",
          );
          expect(fs.readFileSync(churchNote, "utf8")).toContain(
            "cache size and batch size",
          );
          const sixth = await orchestrator.runLoop();
          expect(sixth).toMatchObject({ improved: true, bestScoreAfter: 168 });
          expect(mySubmissions(repoRoot).map((entry) => entry.score)).toEqual([
            232,
            168,
          ]);
        }
      } finally {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    },
  );
});
