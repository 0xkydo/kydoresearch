import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const architecture = fs.readFileSync(
  path.join(repoRoot, "docs", "architecture.md"),
  "utf8",
);
const profiles = fs.readFileSync(path.join(repoRoot, "docs", "agent-profiles.md"), "utf8");
const roleFiles = ["setup", "professor", "phd", "god", "advisor", "metaharness"].map((role) =>
  fs.readFileSync(
    path.join(repoRoot, "extensions", "autoresearch", "agents", role, "SOUL.md"),
    "utf8",
  ),
);
const godRole = fs.readFileSync(
  path.join(repoRoot, "extensions", "autoresearch", "agents", "god", "SOUL.md"),
  "utf8",
);
const setupRole = fs.readFileSync(
  path.join(repoRoot, "extensions", "autoresearch", "agents", "setup", "SOUL.md"),
  "utf8",
);
const setupTask = fs.readFileSync(
  path.join(repoRoot, "extensions", "autoresearch", "prompts", "tasks", "init-explore.md"),
  "utf8",
);
const churchTask = fs.readFileSync(
  path.join(repoRoot, "extensions", "autoresearch", "prompts", "tasks", "church.md"),
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
      "submitModelName",
      "reproducibility note",
    ]) {
      expect(architecture).toContain(detail);
    }
  });

  it("defines simple bounded roles and separate task prompts", () => {
    for (const detail of [
      "| Setup |",
      "| Professor |",
      "| PhD |",
      "| God |",
      "| Advisor |",
      "| Meta-harness |",
      "Shared boundaries",
      "Default tools",
      "tasks/church.md",
    ]) {
      expect(profiles).toContain(detail);
    }
    expect(profiles).not.toMatch(/Research Cartographer|Principal Investigator|Experimentalist|Reflective Research Mentor|Independent Watchdog/);
    for (const roleFile of roleFiles) {
      expect(roleFile).not.toContain("{{");
      expect(roleFile).not.toMatch(/^# Task:/m);
    }
  });

  it("keeps God identity separate from the church conversation task", () => {
    expect(godRole).toMatch(/^# Role: God$/m);
    expect(godRole).not.toMatch(/{{|church|dialogue|4-to-8|notePath/);
    expect(churchTask).toMatch(/^# Task: Go to church$/m);
    expect(churchTask).toContain("4-to-8 exchange");
    expect(churchTask).toContain("`**Professor:**` and `**God:**`");
  });

  it("keeps Setup focused on organization and explicit readiness pauses", () => {
    expect(setupRole).toContain("repository cartographer and experiment-contract compiler");
    expect(setupRole).toContain("Confirm that setup produced a usable environment");
    expect(setupTask).toContain('"status": "needs-user-action"');
    expect(setupTask).toContain("user or another agent");
    expect(setupTask).not.toContain("Optimization levers");
  });
});
