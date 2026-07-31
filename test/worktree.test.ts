import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeExec } from "../src/exec.ts";
import { WorktreePool } from "../src/worktree.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("WorktreePool parent materialization", () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = makeTmpChallenge()));
  afterEach(() => cleanup());

  it("starts a candidate from an archived uncommitted parent instead of Git HEAD", async () => {
    const editablePath = "src/solution";
    const paramsPath = path.join(repoRoot, editablePath, "params.json");
    const obsoletePath = path.join(repoRoot, editablePath, "obsolete.txt");
    fs.writeFileSync(obsoletePath, "present in Git HEAD\n");
    execFileSync("git", ["add", obsoletePath], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add obsolete parent file", "--no-gpg-sign"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const currentBest = {
      algorithm: "uncommitted-current-best",
      x: 7,
      y: 11,
    };
    fs.writeFileSync(paramsPath, `${JSON.stringify(currentBest, null, 2)}\n`);
    fs.rmSync(obsoletePath);

    const artifactDir = path.join(repoRoot, ".autoresearch", "runs", "current-best", "source");
    fs.mkdirSync(path.dirname(path.join(artifactDir, editablePath)), { recursive: true });
    fs.cpSync(path.join(repoRoot, editablePath), path.join(artifactDir, editablePath), {
      recursive: true,
    });

    expect(
      JSON.parse(execFileSync("git", ["show", "HEAD:src/solution/params.json"], { cwd: repoRoot, encoding: "utf8" })),
    ).toMatchObject({ algorithm: "baseline-guess" });

    const worktreesDir = path.join(repoRoot, ".autoresearch", "worktrees");
    const pool = new WorktreePool(repoRoot, worktreesDir, nodeExec);
    const worktree = await pool.create("L002-I1", {
      parentArtifactDir: artifactDir,
      editablePaths: [editablePath],
    });

    expect(JSON.parse(fs.readFileSync(path.join(worktree, editablePath, "params.json"), "utf8"))).toEqual(
      currentBest,
    );
    expect(fs.existsSync(path.join(worktree, editablePath, "obsolete.txt"))).toBe(false);

    await pool.remove("L002-I1");
  });

  it.each(["../outside", "src/../../outside", "/absolute", ".", "   "])(
    "rejects an out-of-bounds editable path before creating a worktree: %j",
    async (editablePath) => {
      const artifactDir = path.join(repoRoot, ".autoresearch", "runs", "parent", "source");
      fs.mkdirSync(artifactDir, { recursive: true });
      const worktreesDir = path.join(repoRoot, ".autoresearch", "worktrees");
      const pool = new WorktreePool(repoRoot, worktreesDir, nodeExec);

      await expect(
        pool.create("invalid-parent", {
          parentArtifactDir: artifactDir,
          editablePaths: [editablePath],
        }),
      ).rejects.toThrow(/Editable path/);
      expect(fs.existsSync(path.join(worktreesDir, "invalid-parent"))).toBe(false);
    },
  );

  it("seeds individual untracked files without recursively copying nested worktrees", async () => {
    const markerPath = path.join(repoRoot, "generated", "setup-marker.txt");
    const nestedWeight = path.join(
      repoRoot,
      ".worktrees",
      "old-experiment",
      "weights",
      "model.safetensors",
    );
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "ready\n");
    fs.mkdirSync(path.dirname(nestedWeight), { recursive: true });
    fs.writeFileSync(nestedWeight, "large runtime artifact\n");

    const worktreesDir = path.join(repoRoot, ".autoresearch", "worktrees");
    const pool = new WorktreePool(repoRoot, worktreesDir, nodeExec);
    const worktree = await pool.create("seed-safe");

    await pool.seedUntracked("seed-safe");

    expect(fs.readFileSync(path.join(worktree, "generated", "setup-marker.txt"), "utf8"))
      .toBe("ready\n");
    expect(fs.existsSync(path.join(worktree, ".worktrees"))).toBe(false);

    await pool.remove("seed-safe");
  });

  it("rejects an oversized untracked seed before copying it", async () => {
    const oversized = path.join(repoRoot, "generated", "oversized.bin");
    fs.mkdirSync(path.dirname(oversized), { recursive: true });
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);

    const worktreesDir = path.join(repoRoot, ".autoresearch", "worktrees");
    const pool = new WorktreePool(repoRoot, worktreesDir, nodeExec);
    const worktree = await pool.create("seed-budget");

    await expect(pool.seedUntracked("seed-budget")).rejects.toThrow(
      /untracked seed exceeds the 64 MiB limit/i,
    );
    expect(fs.existsSync(path.join(worktree, "generated", "oversized.bin"))).toBe(false);

    await pool.remove("seed-budget");
  });
});
