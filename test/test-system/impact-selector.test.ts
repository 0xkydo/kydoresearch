import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateImpactMap,
  type TestImpactMapV1,
} from "../../src/test-system/contracts.ts";
import { selectTests } from "../../src/test-system/selector.ts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const impactMap = validateImpactMap(
  JSON.parse(fs.readFileSync(path.join(repoRoot, "test/impact-map.json"), "utf8")),
);

describe("test impact selector", () => {
  it("selects only the kernel and Professor contracts for explicit Professor intent", () => {
    const receipt = select({
      mode: "phase",
      explicitIntent: "professor",
      changedFiles: [],
    });
    const files = selectedFiles(receipt);

    expect(files).toContain("test/phases/professor/capsule.test.ts");
    expect(files).toContain("test/archive.test.ts");
    expect(files).toContain("test/steering.test.ts");
    expect(files).not.toContain("test/phases/setup/capsule.test.ts");
    expect(files).not.toContain("test/phases/phd/capsule.test.ts");
    expect(files).not.toContain("test/phases/finalization/capsule.test.ts");
    expect(files).not.toContain("test/adapter.test.ts");
    expect(receipt.fullSuiteRequired).toBe(false);
  });

  it("supports narrower segment intent", () => {
    const receipt = select({
      mode: "phase",
      explicitIntent: "finalization:submission",
      changedFiles: [],
    });

    expect(selectedFiles(receipt)).toContain("test/phases/finalization/capsule.test.ts");
    expect(selectedFiles(receipt)).toContain("test/adapter.test.ts");
    expect(receipt.explicitIntent).toBe("finalization:submission");
  });

  it("keeps docs-only changes on the always-on kernel", () => {
    const receipt = select({
      mode: "related",
      changedFiles: ["docs/architecture.md"],
    });

    expect(receipt.selectedTests.every((test) =>
      test.reasons.some((reason) => reason.code === "always-on-kernel")
    )).toBe(true);
    expect(receipt.fullSuiteRequired).toBe(false);
    expect(receipt.fullSuiteStatus.freshness).toBe("unknown");
  });

  it("reports stale full-suite evidence without making every clean PR a full run", () => {
    const receipt = selectTests({
      impactMap,
      mode: "related",
      changedFiles: ["docs/testing.md"],
      commit: "abc123",
      generatedAt: "2026-07-26T00:00:00.000Z",
      latestSuccessfulFullSuite: {
        commit: "old-full",
        completedAt: "2026-07-01T00:00:00.000Z",
        durationMs: 64_000,
      },
    });

    expect(receipt.fullSuiteStatus.freshness).toBe("stale");
    expect(receipt.fullSuiteRequired).toBe(false);
  });

  it("combines semantic UI impact and import dependency reasons", () => {
    const receipt = select({
      mode: "related",
      changedFiles: ["extensions/autoresearch/widget.ts"],
      dependencyMatches: {
        "test/widget.test.ts": ["extensions/autoresearch/widget.ts"],
      },
    });
    const widget = receipt.selectedTests.find((test) => test.file === "test/widget.test.ts");

    expect(widget?.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["import-dependency", "semantic-impact"]),
    );
    expect(receipt.fullSuiteRequired).toBe(false);
  });

  it("escalates shared lifecycle and unknown production changes", () => {
    const shared = select({
      mode: "related",
      changedFiles: ["src/state.ts"],
    });
    const unknown = select({
      mode: "related",
      changedFiles: ["src/new-unknown-boundary.ts"],
    });

    expect(shared.fullSuiteRequired).toBe(true);
    expect(shared.escalations.join("\n")).toContain("Shared lifecycle");
    expect(unknown.fullSuiteRequired).toBe(true);
    expect(unknown.escalations.join("\n")).toContain("unknown production impact");
    expect(shared.skippedSuites).toEqual([]);
    expect(unknown.skippedSuites).toEqual([]);
  });

  it("escalates package and test-infrastructure changes", () => {
    for (const file of ["package-lock.json", "vitest.config.ts", "test/impact-map.json"]) {
      const receipt = select({ mode: "related", changedFiles: [file] });
      expect(receipt.fullSuiteRequired, file).toBe(true);
    }
  });

  it("escalates broad changes by file count or architectural phase count", () => {
    const byFileCount = select({
      mode: "related",
      changedFiles: Array.from(
        { length: impactMap.broadChangeFileThreshold },
        (_, index) => `src/challenge/broad-${index}.ts`,
      ),
    });
    const byPhaseCount = select({
      mode: "related",
      changedFiles: [
        "extensions/autoresearch/widget.ts",
        "src/integrity.ts",
        "src/metaharness.ts",
      ],
    });

    expect(byFileCount.fullSuiteRequired).toBe(true);
    expect(byFileCount.escalations.join("\n")).toContain("broad production change");
    expect(byPhaseCount.fullSuiteRequired).toBe(true);
    expect(byPhaseCount.escalations.join("\n")).toContain(
      "multiple architectural boundaries",
    );
  });

  it("fails closed for malformed maps and invalid segments", () => {
    expect(() =>
      validateImpactMap({
        ...structuredClone(impactMap),
        unexpected: true,
      })
    ).toThrow(/unknown: unexpected/);
    expect(() =>
      select({
        mode: "phase",
        explicitIntent: "professor:unknown",
        changedFiles: [],
      })
    ).toThrow(/Unknown phase or segment/);
  });
});

function select(
  input: Pick<
    Parameters<typeof selectTests>[0],
    "mode" | "changedFiles" | "explicitIntent" | "dependencyMatches"
  >,
) {
  return selectTests({
    impactMap: impactMap as TestImpactMapV1,
    commit: "abc123",
    generatedAt: "2026-07-26T00:00:00.000Z",
    ...input,
  });
}

function selectedFiles(receipt: ReturnType<typeof selectTests>): string[] {
  return receipt.selectedTests.map((test) => test.file);
}
