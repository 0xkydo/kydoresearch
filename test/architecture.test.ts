import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const architecture = fs.readFileSync(
  path.join(repoRoot, "docs", "architecture.md"),
  "utf8",
);

describe("architecture documentation contract", () => {
  it("describes the implemented subprocess runtime rather than a future stub", () => {
    expect(architecture).not.toMatch(/PiSubprocessRunner \(v2 stub\)/);
    expect(architecture).not.toMatch(/PiSubprocessRunner\.run\(task\) will:/);
    for (const detail of [
      "PiSubprocessRunner",
      "pi --mode json",
      "--no-session",
      "--thinking",
      "--tools",
      "SIGTERM",
      "SIGKILL",
    ]) {
      expect(architecture).toContain(detail);
    }
  });

  it("documents durable resume, execution controls, and concurrency boundaries", () => {
    for (const detail of [
      "resumePhase",
      "pendingSummary",
      "setupTimeoutMs",
      "verifyTimeoutMs",
      "benchmarkTimeoutMs",
      ".autoresearch/logs/",
      "worktree registry",
      "benchmark lock",
    ]) {
      expect(architecture).toContain(detail);
    }
  });
});
