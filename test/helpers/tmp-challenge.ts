import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../fixtures/mock-challenge");

/**
 * Copy the fixture challenge to a tmpdir and git-init it with one commit
 * (worktrees need a HEAD; yukon clones always have history).
 */
export function makeTmpChallenge(): { repoRoot: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-challenge-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  for (const f of ["setup.sh", "verify.sh", "benchmark.sh", "bin/mockchal"]) {
    fs.chmodSync(path.join(dir, f), 0o755);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-m", "fixture baseline", "--no-gpg-sign");
  return {
    repoRoot: dir,
    cleanup: () => {
      // git worktrees must be pruned before rm to avoid dangling registrations.
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: dir, stdio: "pipe" });
      } catch {
        /* repo may already be gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
