import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashHarnessBehavior,
  validateHarnessProfile,
  type HarnessProfileV1,
} from "../../../src/metaharness.ts";

describe("Meta-harness phase capsule", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts only candidate-local Professor/PhD/Advisor artifacts for a later window", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "metaharness-capsule-"));
    for (const role of ["professor", "phd", "advisor"]) {
      const directory = path.join(root, "artifact", role);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "SOUL.md"), `${role} soul\n`);
      fs.writeFileSync(path.join(directory, "prompt.md"), `${role} prompt\n`);
    }
    const profile = profileFixture();
    const validated = validateHarnessProfile(root, profile, {
      expectedCandidateId: "H0001",
      expectedParentCandidateId: "H0000",
      maxBytes: 100_000,
    });

    expect(validated).toEqual(profile);
    expect(hashHarnessBehavior(root, validated)).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.roles).toHaveProperty("professor");
    expect(profile.roles).toHaveProperty("phd");
    expect(profile.roles).toHaveProperty("advisor");
    expect(profile.roles).not.toHaveProperty("setup");
    expect(profile.roles).not.toHaveProperty("god");

    const forbidden = structuredClone(profile) as HarnessProfileV1 & {
      verifier?: { command: string };
    };
    forbidden.verifier = { command: "true" };
    expect(() =>
      validateHarnessProfile(root!, forbidden, {
        expectedCandidateId: "H0001",
        expectedParentCandidateId: "H0000",
        maxBytes: 100_000,
      })
    ).toThrow(/unsupported fields: verifier/);
  });
});

function profileFixture(): HarnessProfileV1 {
  return {
    schemaVersion: 1,
    candidateId: "H0001",
    parentCandidateId: "H0000",
    createdAt: "2026-07-26T00:00:00.000Z",
    hypothesis: {
      observation: "A repeated failure is visible in immutable evidence.",
      mechanism: "The role is not retrieving the decisive trace.",
      intervention: "Require an explicit raw-trace comparison.",
      expectedResult: "Fewer duplicated edit families.",
      falsifiedWhen: "The later evaluation window produces no objective gain.",
      risks: ["Additional context may not improve decisions."],
      evidenceRefs: ["runs/L001-I1/agent/events.ndjson"],
    },
    roles: {
      professor: {
        soul: "artifact/professor/SOUL.md",
        prompt: "artifact/professor/prompt.md",
        tools: ["read", "bash"],
      },
      phd: {
        soul: "artifact/phd/SOUL.md",
        prompt: "artifact/phd/prompt.md",
        tools: ["read", "write", "edit", "bash"],
      },
      advisor: {
        soul: "artifact/advisor/SOUL.md",
        prompt: "artifact/advisor/prompt.md",
        tools: ["read"],
      },
    },
  };
}
