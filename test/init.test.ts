import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { ExecPort } from "../src/exec.ts";
import { nodeExec } from "../src/exec.ts";
import { initChallenge } from "../src/init.ts";
import { loadState } from "../src/state.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("initChallenge", () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = makeTmpChallenge()));
  afterEach(() => cleanup());

  it("scaffolds state dir, runs setup, detects distinct verify/bench commands", async () => {
    const { state, stateDir } = await initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec });

    expect(state.phase).toBe("ready");
    expect(fs.existsSync(path.join(stateDir, "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "knowledge-base.md"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "loops", "init", "setup-task.json"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(stateDir, "runs", "baseline", "source", "src", "solution", "params.json"),
      ),
    ).toBe(true);
    expect(state.bestCandidateId).toBe("baseline");
    expect(fs.existsSync(path.join(repoRoot, ".autoresearch-setup-done"))).toBe(true); // setup ran

    // verify and bench detected as DIFFERENT commands (mlxfast-style split).
    expect(state.challenge.verifyCommand).toBe("./verify.sh");
    expect(state.challenge.benchCommand).toBe("./benchmark.sh");
    expect(state.challenge.cli).toBe("./bin/mockchal");
    expect(state.challenge.direction).toBe("-");

    // .autoresearch hidden from git via info/exclude, not .gitignore.
    const exclude = fs.readFileSync(path.join(repoRoot, ".git/info/exclude"), "utf8");
    expect(exclude).toContain(".autoresearch/");

    // reload round-trips
    expect(loadState(stateDir)?.challenge.name).toBe("mock-challenge");
  });

  it("initializes an ecdsafail-shaped argv manifest and records its baseline", async () => {
    fs.writeFileSync(
      path.join(repoRoot, "benchmark.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          name: "ecadd-challenge-test",
          description: "Optimize reversible elliptic-curve point addition.",
          category: "rust",
          direction: "-",
          editablePaths: ["src/point_add"],
          setupCommand: ["bash", "-lc", "./setup.sh"],
          benchmarkCommand: ["bash", "-lc", "./benchmark.sh"],
          scorePath: "score.json",
        },
        null,
        2,
      ),
    );

    const { state, stateDir } = await initChallenge({
      repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
    });

    expect(state).toMatchObject({
      phase: "ready",
      bestScore: 10,
      challenge: {
        name: "ecadd-challenge-test",
        cli: "ecdsafail",
        direction: "-",
        setupCommand: "bash -lc ./setup.sh",
        verifyCommand: "bash -lc ./benchmark.sh",
        benchCommand: "bash -lc ./benchmark.sh",
        editablePaths: ["src/point_add"],
        scorePath: "score.json",
      },
    });
    expect(loadState(stateDir)).toMatchObject({ phase: "ready", bestScore: 10 });
    expect(fs.readFileSync(path.join(stateDir, "journal.ndjson"), "utf8")).toContain('"phase":"ready"');
  });

  it("uses persisted phase timeouts and logs setup plus baseline output", async () => {
    const stateDir = path.join(repoRoot, ".autoresearch");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        execution: {
          setupTimeoutMs: 1_111,
          verifyTimeoutMs: 2_222,
          benchmarkTimeoutMs: 3_333,
        },
      }),
    );
    const seenTimeouts: number[] = [];
    const exec: ExecPort = (cmd, args, opts) => {
      if (cmd === "/bin/bash") seenTimeouts.push(opts?.timeout ?? -1);
      return nodeExec(cmd, args, opts);
    };

    const result = await initChallenge({
      repoRoot,
      runner: new MockAgentRunner(),
      exec,
    });

    expect(result.config.execution).toEqual({
      setupTimeoutMs: 1_111,
      verifyTimeoutMs: 2_222,
      benchmarkTimeoutMs: 3_333,
    });
    expect(seenTimeouts).toEqual([1_111, 3_333]);
    expect(fs.readFileSync(path.join(stateDir, "logs", "setup.log"), "utf8")).toContain("$ ./setup.sh");
    expect(fs.readFileSync(path.join(stateDir, "logs", "benchmark.log"), "utf8")).toContain("$ ./benchmark.sh");
  });

  it("aborts when .autoresearch would fall inside editablePaths", async () => {
    const manifestPath = path.join(repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.editablePaths = ["./"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(/editablePaths/);
  });

  it("fails loudly when setup fails", async () => {
    fs.writeFileSync(path.join(repoRoot, "setup.sh"), "#!/usr/bin/env bash\nexit 7\n");
    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(
      /Dependency setup failed.*Run "\.\/setup\.sh" manually, fix the reported error, then retry \/autoresearch/s,
    );
  });

  it("requires a benchmark.json", async () => {
    fs.rmSync(path.join(repoRoot, "benchmark.json"));
    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(/No benchmark\.json.*cd into a cloned Yukon challenge repo, then retry \/autoresearch/s);
  });

  it("requires the challenge directory to be a git worktree", async () => {
    fs.rmSync(path.join(repoRoot, ".git"), { recursive: true, force: true });
    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(/Not a git repository.*clone the challenge, cd into it, then retry \/autoresearch/is);
  });

  it("explains how to recover when the benchmark command is missing", async () => {
    const manifestPath = path.join(repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.benchmarkCommand = "./missing-benchmark.sh";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(
      /Benchmark command "\.\/missing-benchmark\.sh" was not found.*fix benchmarkCommand in benchmark\.json, then retry \/autoresearch/s,
    );
  });
});
