import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgentRunner } from "../src/agents/mock.ts";
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
    ).rejects.toThrow(/Dependency setup failed/);
  });

  it("requires a benchmark.json", async () => {
    fs.rmSync(path.join(repoRoot, "benchmark.json"));
    await expect(
      initChallenge({ repoRoot, runner: new MockAgentRunner(), exec: nodeExec }),
    ).rejects.toThrow(/No benchmark.json/);
  });
});
