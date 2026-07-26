import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecPort } from "./exec.ts";
import { Mutex } from "./util.ts";

export interface ParentArtifact {
  /** Directory containing a snapshot rooted by each editable path. */
  parentArtifactDir: string;
  editablePaths: readonly string[];
}

/**
 * Per-idea git worktrees under .autoresearch/worktrees/<ideaId>/, so parallel
 * PhDs edit isolated checkouts. Requires the challenge repo to be a git repo
 * (yukon clones always are).
 */
export class WorktreePool {
  private readonly registryLock = new Mutex();

  constructor(
    private readonly repoRoot: string,
    private readonly worktreesDir: string,
    private readonly exec: ExecPort,
  ) {}

  private git(args: string[], cwd = this.repoRoot) {
    return this.exec("git", args, { cwd });
  }

  /**
   * Create a detached worktree at the current HEAD for an idea. When a parent
   * artifact is supplied, replace every editable path with its archived
   * counterpart before returning the worktree.
   */
  async create(ideaId: string, parent?: ParentArtifact): Promise<string> {
    if (parent) this.validateParentArtifact(parent);
    return this.registryLock.runExclusive(() => this.createUnlocked(ideaId, parent));
  }

  private async createUnlocked(ideaId: string, parent?: ParentArtifact): Promise<string> {
    const wtPath = path.join(this.worktreesDir, ideaId);
    if (fs.existsSync(wtPath)) await this.removeUnlocked(ideaId); // stale from a previous crash
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    const result = await this.git(["worktree", "add", "--detach", wtPath]);
    if (result.code !== 0) {
      throw new Error(`git worktree add failed for ${ideaId}: ${result.stderr.trim()}`);
    }
    if (parent) {
      try {
        this.materializeParent(wtPath, parent);
      } catch (error) {
        await this.removeUnlocked(ideaId).catch(() => {});
        throw error;
      }
    }
    // Untracked, uncommitted setup artifacts (markers, weights symlinks, build
    // dirs) don't travel with worktrees. Copy untracked non-ignored… is risky;
    // instead copy known setup markers and rely on setup being idempotent.
    return wtPath;
  }

  private validateParentArtifact(parent: ParentArtifact): void {
    const artifactDir = path.resolve(parent.parentArtifactDir);
    if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
      throw new Error(`Parent artifact directory does not exist: ${parent.parentArtifactDir}`);
    }
    if (parent.editablePaths.length === 0) {
      throw new Error("Parent artifact requires at least one editable path");
    }
    for (const editablePath of parent.editablePaths) {
      this.resolveEditablePath(artifactDir, editablePath, "parent artifact");
      // Validate against the eventual worktree root as well. Both calls are
      // intentional: path rules can differ across roots on some platforms.
      this.resolveEditablePath(path.resolve(this.worktreesDir, "__candidate__"), editablePath, "worktree");
    }
  }

  private materializeParent(wtPath: string, parent: ParentArtifact): void {
    const artifactDir = path.resolve(parent.parentArtifactDir);
    for (const editablePath of parent.editablePaths) {
      const src = this.resolveEditablePath(artifactDir, editablePath, "parent artifact");
      const dst = this.resolveEditablePath(wtPath, editablePath, "worktree");

      // A snapshot is authoritative over the complete editable surface.
      // Absence in the parent therefore means the path was deleted.
      fs.rmSync(dst, { recursive: true, force: true });
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }

  private resolveEditablePath(root: string, editablePath: string, label: string): string {
    if (editablePath.trim() === "" || path.isAbsolute(editablePath)) {
      throw new Error(`Editable path must be non-empty and relative: ${JSON.stringify(editablePath)}`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, editablePath);
    const relative = path.relative(resolvedRoot, resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Editable path escapes the ${label}: ${JSON.stringify(editablePath)}`);
    }
    return resolved;
  }

  async remove(ideaId: string): Promise<void> {
    await this.registryLock.runExclusive(() => this.removeUnlocked(ideaId));
  }

  private async removeUnlocked(ideaId: string): Promise<void> {
    const wtPath = path.join(this.worktreesDir, ideaId);
    await this.git(["worktree", "remove", "--force", wtPath]);
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    const prune = await this.git(["worktree", "prune"]);
    if (prune.code !== 0) {
      throw new Error(`git worktree prune failed after removing ${ideaId}: ${prune.stderr.trim()}`);
    }
  }

  /**
   * Copy the editablePaths content of a worktree into the main repo (the
   * winning idea's diff applied). Whole-path copy is correct because
   * editablePaths is the complete mutable surface.
   */
  applyToMain(ideaId: string, editablePaths: string[]): void {
    const wtPath = path.join(this.worktreesDir, ideaId);
    for (const ep of editablePaths) {
      const src = path.join(wtPath, ep);
      const dst = path.join(this.repoRoot, ep);
      fs.rmSync(dst, { recursive: true, force: true });
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }

  /**
   * Capture the main checkout's complete editable surface before finalization.
   * The completed marker makes this idempotent across process restarts.
   */
  ensureMainSnapshot(snapshotDir: string, editablePaths: string[]): void {
    const marker = path.join(snapshotDir, ".complete");
    if (fs.existsSync(marker)) return;

    const tmpDir = `${snapshotDir}.tmp-${process.pid}`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const editablePath of editablePaths) {
      const src = path.join(this.repoRoot, editablePath);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(tmpDir, editablePath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    fs.writeFileSync(path.join(tmpDir, ".complete"), "complete\n");
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, snapshotDir);
  }

  /** Restore the main editable surface exactly, including paths that were absent. */
  restoreMainSnapshot(snapshotDir: string, editablePaths: string[]): void {
    if (!fs.existsSync(path.join(snapshotDir, ".complete"))) {
      throw new Error(`Main-checkout snapshot is incomplete: ${snapshotDir}`);
    }
    for (const editablePath of editablePaths) {
      const src = path.join(snapshotDir, editablePath);
      const dst = path.join(this.repoRoot, editablePath);
      fs.rmSync(dst, { recursive: true, force: true });
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }

  discardMainSnapshot(snapshotDir: string): void {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }

  /**
   * Copy files that setup produced but git doesn't track (setup markers,
   * generated fixtures) into a worktree so verify/bench work there. Ignored
   * files (large weights, build dirs) are deliberately NOT copied — challenges
   * gitignore heavy artifacts and setup must be idempotent for those.
   */
  async seedUntracked(ideaId: string): Promise<void> {
    const wtPath = path.join(this.worktreesDir, ideaId);
    const status = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    if (status.code !== 0) {
      throw new Error(`git status failed while seeding ${ideaId}: ${status.stderr.trim()}`);
    }
    for (const line of status.stdout.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      const rel = line.slice(3).trim();
      if (rel === "" || rel.startsWith(".autoresearch/")) continue;
      const src = path.join(this.repoRoot, rel);
      const dst = path.join(wtPath, rel);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
}
