import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeExec } from "../src/exec.ts";
import { auditCandidateIntegrity } from "../src/integrity.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("auditCandidateIntegrity", () => {
  let repoRoot: string;
  let candidateWorktree: string;
  let worktreeContainer: string;
  let cleanupRepo: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup: cleanupRepo } = makeTmpChallenge());
    worktreeContainer = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-worktree-"));
    candidateWorktree = path.join(worktreeContainer, "candidate");
    execFileSync("git", ["worktree", "add", "--detach", candidateWorktree], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", candidateWorktree], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch {
      /* The assertion may have removed or damaged the worktree. */
    }
    fs.rmSync(worktreeContainer, { recursive: true, force: true });
    cleanupRepo();
  });

  const audit = () =>
    auditCandidateIntegrity({
      repoRoot,
      candidateWorktree,
      editablePaths: ["src/solution"],
      exec: nodeExec,
    });

  it("allows tracked and untracked edits beneath an editable path", async () => {
    fs.writeFileSync(
      path.join(candidateWorktree, "src/solution/params.json"),
      '{"algorithm":"candidate"}\n',
    );
    fs.writeFileSync(path.join(candidateWorktree, "src/solution/research notes.txt"), "notes\n");

    await expect(audit()).resolves.toEqual({
      changedPaths: ["src/solution/params.json", "src/solution/research notes.txt"],
      allowedPaths: ["src/solution/params.json", "src/solution/research notes.txt"],
      violations: [],
      ok: true,
    });
  });

  it("rejects a tracked evaluator mutation", async () => {
    fs.appendFileSync(path.join(candidateWorktree, "verify.sh"), "\n# candidate tampering\n");

    const result = await audit();

    expect(result.ok).toBe(false);
    expect(result.allowedPaths).toEqual([]);
    expect(result.violations).toEqual([
      {
        path: "verify.sh",
        status: " M",
        reason: "outside-editable-path",
      },
    ]);
  });

  it("rejects a new untracked path outside the editable surface", async () => {
    fs.writeFileSync(path.join(candidateWorktree, "candidate notes.txt"), "not seeded\n");

    const result = await audit();

    expect(result.changedPaths).toEqual(["candidate notes.txt"]);
    expect(result.violations).toEqual([
      {
        path: "candidate notes.txt",
        status: "??",
        reason: "outside-editable-path",
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("allows an unchanged untracked setup artifact copied from the main repository", async () => {
    const relativeArtifact = "generated/setup marker.txt";
    const repoArtifact = path.join(repoRoot, relativeArtifact);
    const candidateArtifact = path.join(candidateWorktree, relativeArtifact);
    fs.mkdirSync(path.dirname(repoArtifact), { recursive: true });
    fs.mkdirSync(path.dirname(candidateArtifact), { recursive: true });
    fs.writeFileSync(repoArtifact, "setup-complete\n");
    fs.copyFileSync(repoArtifact, candidateArtifact);

    await expect(audit()).resolves.toEqual({
      changedPaths: [relativeArtifact],
      allowedPaths: [relativeArtifact],
      violations: [],
      ok: true,
    });
  });

  it("rejects a modified copy of an untracked setup artifact", async () => {
    const relativeArtifact = "generated/setup marker.txt";
    const repoArtifact = path.join(repoRoot, relativeArtifact);
    const candidateArtifact = path.join(candidateWorktree, relativeArtifact);
    fs.mkdirSync(path.dirname(repoArtifact), { recursive: true });
    fs.mkdirSync(path.dirname(candidateArtifact), { recursive: true });
    fs.writeFileSync(repoArtifact, "setup-complete\n");
    fs.writeFileSync(candidateArtifact, "candidate-modified\n");

    const result = await audit();

    expect(result.violations).toEqual([
      {
        path: relativeArtifact,
        status: "??",
        reason: "seed-artifact-mismatch",
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("checks both paths in a tracked rename, including paths containing spaces", async () => {
    const original = "grading rules.txt";
    fs.writeFileSync(path.join(repoRoot, original), "do not change\n");
    execFileSync("git", ["add", original], { cwd: repoRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add grading rules", "--no-gpg-sign"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    // Refresh the candidate after the new main commit so Git can represent
    // this as one rename rather than an unrelated delete/add pair.
    execFileSync("git", ["worktree", "remove", "--force", candidateWorktree], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync("git", ["worktree", "add", "--detach", candidateWorktree, "HEAD"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    fs.renameSync(
      path.join(candidateWorktree, original),
      path.join(candidateWorktree, "src/solution/grading rules.txt"),
    );
    execFileSync("git", ["add", "-A"], { cwd: candidateWorktree, stdio: "pipe" });

    const result = await audit();

    expect(result.changedPaths).toEqual([
      "grading rules.txt",
      "src/solution/grading rules.txt",
    ]);
    expect(result.allowedPaths).toEqual(["src/solution/grading rules.txt"]);
    expect(result.violations).toEqual([
      {
        path: original,
        status: "R ",
        reason: "outside-editable-path",
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it.each(["../outside", "src/../../outside", "/absolute", ".", "   "])(
    "rejects an invalid editable path: %j",
    async (editablePath) => {
      await expect(
        auditCandidateIntegrity({
          repoRoot,
          candidateWorktree,
          editablePaths: [editablePath],
          exec: nodeExec,
        }),
      ).rejects.toThrow(/Editable path/);
    },
  );
});
