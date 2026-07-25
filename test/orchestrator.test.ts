import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../src/challenge/detect.ts";
import type { HarnessConfig } from "../src/config.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import type { OrchestratorEvent } from "../src/orchestrator.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { loadState } from "../src/state.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

interface Harness {
  repoRoot: string;
  stateDir: string;
  config: HarnessConfig;
  events: OrchestratorEvent[];
  makeOrchestrator: (signal?: AbortSignal) => Orchestrator;
}

async function makeHarness(repoRoot: string, configPatch: Partial<HarnessConfig> = {}): Promise<Harness> {
  const runner = new MockAgentRunner();
  const { stateDir, config } = await initChallenge({ repoRoot, runner, exec: nodeExec });
  Object.assign(config, configPatch);
  const manifest = readManifest(repoRoot);
  const events: OrchestratorEvent[] = [];
  const makeOrchestrator = (signal?: AbortSignal) =>
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
    });
  return { repoRoot, stateDir, config, events, makeOrchestrator };
}

function mySubmissions(repoRoot: string): { score: number; note: string }[] {
  const file = path.join(repoRoot, ".mockchal", "submissions.json");
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { submissions: { author: string; score: number; note: string }[] };
  return data.submissions.filter((s) => s.author === "me");
}

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
  });

  it("loop 2: verify-retry-then-pass, best-of-two winner submits, loser superseded", async () => {
    const h = await makeHarness(repoRoot);
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

    // Retry was real: journal contains a verify-failed line for L002-I1.
    const journal = fs.readFileSync(path.join(h.stateDir, "journal.ndjson"), "utf8");
    expect(journal).toContain("L002-I1");
    expect(journal).toMatch(/verify failed \(attempt 1/);
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

  it("three dry loops trigger God; streak resets; post-God loop improves", async () => {
    const h = await makeHarness(repoRoot);
    const orchestrator = h.makeOrchestrator();
    for (let i = 0; i < 5; i++) await orchestrator.runLoop(); // loops 1-5

    let state = loadState(h.stateDir)!;
    // Loops 3,4,5 are baseline replays (score 10 vs best 2): dry x3 -> God fired after loop 5.
    const godNote = path.join(h.stateDir, "notes", "god-005.md");
    expect(fs.existsSync(godNote)).toBe(true);
    expect(fs.readFileSync(godNote, "utf8")).toContain("**God:**");
    expect(state.dryLoopStreak).toBe(0); // reset by the conversation
    expect(h.events.some((e) => e.type === "god")).toBe(true);

    // Loop 6 converges to the optimum: improvement after God.
    const summary = await orchestrator.runLoop();
    expect(summary!.improved).toBe(true);
    state = loadState(h.stateDir)!;
    expect(state.bestScore).toBe(0);
    expect(mySubmissions(repoRoot).some((s) => s.score === 0)).toBe(true);
  });

  it("god trigger disabled when threshold is 0", async () => {
    const h = await makeHarness(repoRoot, { godTriggerThreshold: 0 });
    const orchestrator = h.makeOrchestrator();
    for (let i = 0; i < 5; i++) await orchestrator.runLoop();
    expect(fs.existsSync(path.join(h.stateDir, "notes", "god-005.md"))).toBe(false);
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
    expect(report.godTriggerThreshold).toBe(3);
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
