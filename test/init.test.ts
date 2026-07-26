import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
import type { AgentRunner } from "../src/agents/types.ts";
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
    expect(fs.existsSync(path.join(stateDir, "telemetry.ndjson"))).toBe(true);
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
    const telemetry = fs.readFileSync(path.join(stateDir, "telemetry.ndjson"), "utf8");
    expect(telemetry).toContain('"flow":"init.setup"');
    expect(telemetry).toContain('"flow":"setup.explore"');
    expect(telemetry).toContain('"flow":"challenge.benchmark"');
  });

  it("persists the successful setup invocation as evidence for Setup", async () => {
    const baseRunner = new MockAgentRunner();
    let setupInput: Record<string, unknown> | undefined;
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "init.explore") setupInput = { ...task.input };
        return baseRunner.run(task);
      },
    };

    const { stateDir } = await initChallenge({ repoRoot, runner, exec: nodeExec });
    const setupLogPath = path.join(stateDir, "logs", "setup.log");

    expect(setupInput).toMatchObject({
      setupCommand: "./setup.sh",
      setupLogPath,
      setupSucceeded: true,
    });
    const setupTask = JSON.parse(
      fs.readFileSync(path.join(stateDir, "loops", "init", "setup-task.json"), "utf8"),
    ) as { input: Record<string, unknown> };
    expect(setupTask.input).toMatchObject({
      setupCommand: "./setup.sh",
      setupLogPath,
      setupSucceeded: true,
    });
    expect(fs.readFileSync(setupLogPath, "utf8")).toMatch(
      /\$ \.\/setup\.sh[\s\S]*end · exit=0/,
    );
  });

  it("uses Setup's hardware-aware commands for baseline and persisted state", async () => {
    const stateDir = path.join(repoRoot, ".autoresearch");
    const setupLogPath = path.join(stateDir, "logs", "setup.log");
    const shellCommands: string[] = [];
    const exec: ExecPort = (cmd, args, opts) => {
      if (cmd === "/bin/bash") shellCommands.push(args[1] ?? "");
      return nodeExec(cmd, args, opts);
    };
    const runner: AgentRunner = {
      run: (task) => {
        const hasSetupEvidence =
          task.input.setupCommand === "./setup.sh" &&
          task.input.setupLogPath === setupLogPath &&
          task.input.setupSucceeded === true;
        return Promise.resolve({
          ok: true,
          output: hasSetupEvidence ? "Selected documented local mode." : "Setup evidence missing.",
          structured: hasSetupEvidence
            ? {
                status: "ready",
                subjectArea: "hardware-aware fixture",
                verifyCommand: "FIXTURE_MODE=local ./verify.sh",
                benchCommand: "FIXTURE_MODE=local ./benchmark.sh",
              }
            : {
                status: "needs-user-action",
                userAction: { reason: "Setup evidence missing." },
              },
          filesWritten: [],
        });
      },
    };

    const { state } = await initChallenge({ repoRoot, runner, exec });

    expect(state.challenge.verifyCommand).toBe("FIXTURE_MODE=local ./verify.sh");
    expect(state.challenge.benchCommand).toBe("FIXTURE_MODE=local ./benchmark.sh");
    expect(shellCommands).toContain("FIXTURE_MODE=local ./benchmark.sh");
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

  it("recognizes spaced MLX Fast challenge names as requiring model attribution", async () => {
    const manifestPath = path.join(repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.name = "MLX Fast Challenge";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const { state } = await initChallenge({
      repoRoot,
      runner: new MockAgentRunner(),
      exec: nodeExec,
      delay: async () => {},
    });

    expect(state.challenge.cli).toBe("mlxfast");
    expect(state.challenge.submitNeedsModel).toBe(true);
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

  it("recovers from transient setup, setup-agent, and baseline failures", async () => {
    let setupCalls = 0;
    let baselineCalls = 0;
    const exec: ExecPort = (cmd, args, opts) => {
      const command = cmd === "/bin/bash" ? args[1] : undefined;
      if (command === "./setup.sh" && ++setupCalls === 1) {
        return Promise.resolve({ stdout: "", stderr: "temporary setup failure", code: 1 });
      }
      if (command === "./benchmark.sh" && ++baselineCalls === 1) {
        return Promise.resolve({ stdout: "", stderr: "temporary benchmark failure", code: 1 });
      }
      return nodeExec(cmd, args, opts);
    };
    const baseRunner = new MockAgentRunner();
    let exploreCalls = 0;
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "init.explore" && ++exploreCalls === 1) {
          return Promise.resolve({
            ok: false,
            output: "",
            error: "temporary provider failure",
            filesWritten: [],
          });
        }
        return baseRunner.run(task);
      },
    };

    const result = await initChallenge({
      repoRoot,
      runner,
      exec,
      delay: async () => {},
    });

    expect(result.state.phase).toBe("ready");
    expect(setupCalls).toBe(2);
    expect(exploreCalls).toBe(2);
    expect(baselineCalls).toBe(2);
  });

  it("asks Setup to review baseline failure evidence before the bounded retry", async () => {
    const stateDir = path.join(repoRoot, ".autoresearch");
    const benchmarkLogPath = path.join(stateDir, "logs", "benchmark.log");
    const shellCommands: string[] = [];
    let baselineCalls = 0;
    const exec: ExecPort = (cmd, args, opts) => {
      const command = cmd === "/bin/bash" ? args[1] : undefined;
      if (command) shellCommands.push(command);
      if (command === "./benchmark.sh" && ++baselineCalls === 1) {
        return Promise.resolve({
          stdout: "",
          stderr:
            "documented local hardware mismatch; rerun with FIXTURE_LOCAL_MODE=1",
          code: 1,
        });
      }
      return nodeExec(cmd, args, opts);
    };
    const baseRunner = new MockAgentRunner();
    let reviewInput: Record<string, unknown> | undefined;
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "init.review") {
          reviewInput = { ...task.input };
          return Promise.resolve({
            ok: true,
            output: "Selected the repository-supported local mode.",
            structured: {
              status: "ready",
              subjectArea: "fixture",
              verifyCommand: "./verify.sh",
              benchCommand: "FIXTURE_LOCAL_MODE=1 ./benchmark.sh",
            },
            filesWritten: [],
          });
        }
        return baseRunner.run(task);
      },
    };

    const result = await initChallenge({
      repoRoot,
      runner,
      exec,
      delay: async () => {},
    });

    expect(reviewInput).toMatchObject({
      previousVerifyCommand: "./verify.sh",
      previousBenchCommand: "./benchmark.sh",
      benchmarkLogPath,
      scorePath: path.join(repoRoot, "score.json"),
      benchmarkExitCode: 1,
    });
    expect(String(reviewInput?.benchmarkFailureTail)).toContain(
      "FIXTURE_LOCAL_MODE=1",
    );
    expect(shellCommands).toContain("FIXTURE_LOCAL_MODE=1 ./benchmark.sh");
    expect(result.state.challenge.benchCommand).toBe(
      "FIXTURE_LOCAL_MODE=1 ./benchmark.sh",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(stateDir, "loops", "init", "setup-result.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      kind: "init.explore.result",
      ok: true,
      verifyCommand: "./verify.sh",
      benchCommand: "FIXTURE_LOCAL_MODE=1 ./benchmark.sh",
      reviewCount: 1,
    });
  });

  it("reuses a durable Setup result after an interrupted baseline", async () => {
    const stateDir = path.join(repoRoot, ".autoresearch");
    let setupCalls = 0;
    let exploreCalls = 0;
    let reviewCalls = 0;
    let allowBenchmark = false;
    const exec: ExecPort = (cmd, args, opts) => {
      const command = cmd === "/bin/bash" ? args[1] : undefined;
      if (command === "./setup.sh") setupCalls++;
      if (command === "./benchmark.sh" && !allowBenchmark) {
        return Promise.resolve({ stdout: "", stderr: "persistent failure", code: 1 });
      }
      return nodeExec(cmd, args, opts);
    };
    const baseRunner = new MockAgentRunner();
    const runner: AgentRunner = {
      run: (task) => {
        if (task.kind === "init.explore") exploreCalls++;
        if (task.kind === "init.review") {
          reviewCalls++;
          return Promise.resolve({
            ok: true,
            output: "No safe command revision is documented.",
            structured: {
              status: "ready",
              verifyCommand: "./verify.sh",
              benchCommand: "./benchmark.sh",
            },
            filesWritten: [],
          });
        }
        return baseRunner.run(task);
      },
    };

    await expect(
      initChallenge({ repoRoot, runner, exec, delay: async () => {} }),
    ).rejects.toThrow(/Baseline benchmark failed/);
    expect(fs.existsSync(path.join(stateDir, "loops", "init", "setup-result.json"))).toBe(
      true,
    );

    allowBenchmark = true;
    const resumed = await initChallenge({
      repoRoot,
      runner,
      exec,
      delay: async () => {},
    });

    expect(resumed.state.phase).toBe("ready");
    expect(setupCalls).toBe(1);
    expect(exploreCalls).toBe(1);
    expect(reviewCalls).toBe(1);
  });

  it("pauses initialization when Setup requires work elsewhere", async () => {
    const runner: AgentRunner = {
      run: () =>
        Promise.resolve({
          ok: true,
          output: "The required dependency is not available.",
          structured: {
            status: "needs-user-action",
            userAction: {
              reason: "Rust toolchain 1.90 is missing.",
              location: repoRoot,
              instructions: [
                "Install Rust 1.90 with rustup.",
                "Run ./setup.sh and confirm it succeeds.",
              ],
              suggestedOwner: "user",
            },
          },
          filesWritten: [],
        }),
    };

    await expect(
      initChallenge({
        repoRoot,
        runner,
        exec: nodeExec,
        delay: async () => {},
      }),
    ).rejects.toThrow(
      /Initialization paused.*Rust toolchain 1\.90 is missing.*Install Rust 1\.90 with rustup.*retry \/autoresearch/s,
    );
    expect(fs.existsSync(path.join(repoRoot, ".autoresearch", "state.json"))).toBe(false);
  });

  it("aborts when .autoresearch would fall inside editablePaths", async () => {
    const manifestPath = path.join(repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.editablePaths = ["./"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      initChallenge({
        repoRoot,
        runner: new MockAgentRunner(),
        exec: nodeExec,
        delay: async () => {},
      }),
    ).rejects.toThrow(/editablePaths/);
  });

  it("fails loudly when setup fails", async () => {
    fs.writeFileSync(path.join(repoRoot, "setup.sh"), "#!/usr/bin/env bash\nexit 7\n");
    await expect(
      initChallenge({
        repoRoot,
        runner: new MockAgentRunner(),
        exec: nodeExec,
        delay: async () => {},
      }),
    ).rejects.toThrow(
      /Dependency setup failed.*Run "\.\/setup\.sh" manually, fix the reported error, then retry \/autoresearch/s,
    );
  });

  it("requires a benchmark.json", async () => {
    fs.rmSync(path.join(repoRoot, "benchmark.json"));
    await expect(
      initChallenge({
        repoRoot,
        runner: new MockAgentRunner(),
        exec: nodeExec,
        delay: async () => {},
      }),
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
      initChallenge({
        repoRoot,
        runner: new MockAgentRunner(),
        exec: nodeExec,
        delay: async () => {},
      }),
    ).rejects.toThrow(
      /Benchmark command "\.\/missing-benchmark\.sh" was not found.*fix benchmarkCommand in benchmark\.json, then retry \/autoresearch/s,
    );
  });
});
