import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const instructions = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");

describe("coding-agent documentation contract", () => {
  it("preserves the fixed architecture and product constraints", () => {
    for (const requirement of [
      "Keep the Pi extension",
      "Keep meta-harness evolution opt-in",
      "frozen evaluator fingerprint",
      "no repository-level `SOUL.md`",
      "Leave God's role",
      "Git `HEAD` is not the research parent",
      "benchmark lock",
      "sealed candidate missing its ledger entry",
      "Postmortems run outside the main checkout",
      "npm run typecheck",
      "npm test",
    ]) {
      expect(instructions).toContain(requirement);
    }
  });

  it("points agents to the human and architecture contracts", () => {
    expect(instructions).toContain("README.md");
    expect(instructions).toContain("docs/architecture.md");
    expect(instructions).toContain("docs/pi-native-agent-plan.md");
    expect(instructions).toContain("docs/metaharness.md");
  });
});
