import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "../src/challenge/detect.ts";
import { nodeExec } from "../src/exec.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("YukonCliAdapter against mockchal", () => {
  let repoRoot: string;
  let cleanup: () => void;
  let adapter: YukonCliAdapter;

  beforeEach(() => {
    ({ repoRoot, cleanup } = makeTmpChallenge());
    const manifest = readManifest(repoRoot);
    adapter = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: detectCli(repoRoot, manifest),
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      exec: nodeExec,
    });
  });

  afterEach(() => cleanup());

  it("detects manifest and repo-local CLI", () => {
    const manifest = readManifest(repoRoot);
    expect(manifest.name).toBe("mock-challenge");
    expect(manifest.direction).toBe("-");
    expect(detectCli(repoRoot, manifest)).toBe("./bin/mockchal");
  });

  it("handles the ecdsafail argv-command manifest and ecadd challenge name", () => {
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

    const manifest = readManifest(repoRoot);
    expect(manifest).toMatchObject({
      name: "ecadd-challenge-test",
      direction: "-",
      editablePaths: ["src/point_add"],
      setupCommand: "bash -lc ./setup.sh",
      benchmarkCommand: "bash -lc ./benchmark.sh",
      scorePath: "score.json",
    });
    expect(detectCli(repoRoot, manifest)).toBe("ecdsafail");
  });

  it("editablePaths guard works", () => {
    expect(isInsideEditablePaths(".autoresearch", ["src/solution/"])).toBe(false);
    expect(isInsideEditablePaths("src/solution/params.json", ["src/solution/"])).toBe(true);
    expect(isInsideEditablePaths("src/solution", ["src/solution/"])).toBe(true);
  });

  it("setup → verify → bench round trip", async () => {
    expect((await adapter.setup()).ok).toBe(true);
    expect((await adapter.verify()).ok).toBe(true);
    const bench = await adapter.bench();
    expect(bench.ok).toBe(true);
    expect(bench.score).toBe(10); // baseline (0,0)
  });

  it("verify fails before setup (marker missing)", async () => {
    const result = await adapter.verify();
    expect(result.ok).toBe(false);
    expect(result.raw).toContain("setup has not been run");
  });

  it("submit requires note file and records submission; leaderboard parses", async () => {
    await adapter.setup();
    await adapter.bench();

    const badSubmit = await adapter.submit({ noteFile: path.join(repoRoot, "nonexistent.md") });
    expect(badSubmit.ok).toBe(false);

    const noteFile = path.join(repoRoot, ".autoresearch", "note.md");
    fs.mkdirSync(path.dirname(noteFile), { recursive: true });
    fs.writeFileSync(noteFile, "Baseline submission.");
    const submit = await adapter.submit({ noteFile });
    expect(submit.ok).toBe(true);
    expect(submit.submissionId).toMatch(/^sub-/);
    expect(submit.promoted).toBe(true); // 10 beats seeded best of 18

    const all = await adapter.listSubmissions(true);
    expect(all.length).toBe(3); // 2 seeds + ours
    const mine = await adapter.listSubmissions(false);
    expect(mine.length).toBe(1);
    expect(mine[0]!.score).toBe(10);

    expect((await adapter.sync()).ok).toBe(true);
  });
});
