import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecPort } from "./exec.ts";

/**
 * Per-idea git worktrees under .autoresearch/worktrees/<ideaId>/, so parallel
 * PhDs edit isolated checkouts. Requires the challenge repo to be a git repo
 * (yukon clones always are).
 */
export class WorktreePool {
  constructor(
    private readonly repoRoot: string,
    private readonly worktreesDir: string,
    private readonly exec: ExecPort,
  ) {}

  private git(args: string[], cwd = this.repoRoot) {
    return this.exec("git", args, { cwd });
  }

  /** Create a detached worktree at the current HEAD for an idea. */
  async create(ideaId: string): Promise<string> {
    const wtPath = path.join(this.worktreesDir, ideaId);
    if (fs.existsSync(wtPath)) await this.remove(ideaId); // stale from a previous crash
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    const result = await this.git(["worktree", "add", "--detach", wtPath]);
    if (result.code !== 0) {
      throw new Error(`git worktree add failed for ${ideaId}: ${result.stderr.trim()}`);
    }
    // Untracked, uncommitted setup artifacts (markers, weights symlinks, build
    // dirs) don't travel with worktrees. Copy untracked non-ignored… is risky;
    // instead copy known setup markers and rely on setup being idempotent.
    return wtPath;
  }

  async remove(ideaId: string): Promise<void> {
    const wtPath = path.join(this.worktreesDir, ideaId);
    await this.git(["worktree", "remove", "--force", wtPath]);
    if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    await this.git(["worktree", "prune"]);
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
      if (!fs.existsSync(src)) continue;
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
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
    if (status.code !== 0) return;
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
