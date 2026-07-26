import type {
  FullSuiteReference,
  ResearchPhaseId,
  SelectedTest,
  SelectionReasonCode,
  SelectionReceipt,
  TestImpactMapV1,
  TestTier,
} from "./contracts.ts";
import {
  FULL_SUITE_FRESHNESS_WINDOW_MS,
  parsePhaseIntent,
} from "./contracts.ts";

export interface SelectionInput {
  impactMap: TestImpactMapV1;
  mode: "phase" | "related" | "full";
  changedFiles: string[];
  explicitIntent?: string;
  tier?: TestTier;
  dependencyMatches?: Record<string, string[]>;
  commit: string;
  generatedAt?: string;
  latestSuccessfulFullSuite?: FullSuiteReference;
}

interface Reason {
  code: SelectionReasonCode;
  detail: string;
}

export function selectTests(input: SelectionInput): SelectionReceipt {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const changedFiles = [...new Set(input.changedFiles.map(normalizePath))].sort();
  const selected = new Map<string, Reason[]>();
  const phases = new Set<ResearchPhaseId>();
  const escalations: string[] = [];
  let explicitPhase: ResearchPhaseId | undefined;
  let explicitSegment: string | undefined;

  const add = (file: string, reason: Reason): void => {
    const existing = selected.get(file) ?? [];
    if (!existing.some((candidate) => sameReason(candidate, reason))) existing.push(reason);
    selected.set(file, existing);
  };

  for (const suite of input.impactMap.suites) {
    if (suite.tiers.includes("kernel")) {
      add(suite.file, {
        code: "always-on-kernel",
        detail: "required by the always-on safety kernel",
      });
    }
  }

  if (input.explicitIntent) {
    const intent = parsePhaseIntent(input.explicitIntent, input.impactMap);
    explicitPhase = intent.phase;
    explicitSegment = intent.segment;
    phases.add(intent.phase);
    for (const suite of input.impactMap.suites) {
      const matches = intent.segment
        ? suite.segments.includes(intent.segment)
        : suite.phases.includes(intent.phase);
      if (!matches || (input.tier && !suite.tiers.includes(input.tier))) continue;
      add(suite.file, {
        code: intent.segment ? "explicit-segment" : "explicit-phase",
        detail: intent.segment ?? intent.phase,
      });
    }
  }

  for (const changedFile of changedFiles) {
    const directSuite = input.impactMap.suites.find((suite) => suite.file === changedFile);
    if (directSuite) {
      add(directSuite.file, { code: "changed-test", detail: changedFile });
      directSuite.phases.forEach((phase) => phases.add(phase));
    }
    for (const [suiteFile, dependencies] of Object.entries(input.dependencyMatches ?? {})) {
      if (dependencies.map(normalizePath).includes(changedFile)) {
        add(suiteFile, { code: "import-dependency", detail: changedFile });
        const suite = input.impactMap.suites.find((candidate) => candidate.file === suiteFile);
        suite?.phases.forEach((phase) => phases.add(phase));
      }
    }
    for (const rule of input.impactMap.rules) {
      if (!rule.patterns.some((pattern) => matchesPattern(changedFile, pattern))) continue;
      rule.phases.forEach((phase) => phases.add(phase));
      for (const suite of input.impactMap.suites) {
        if (
          suite.phases.some((phase) => rule.phases.includes(phase)) &&
          (rule.tiers.length === 0 ||
            suite.tiers.some((tier) => rule.tiers.includes(tier))) &&
          (!input.tier || suite.tiers.includes(input.tier))
        ) {
          add(suite.file, {
            code: "semantic-impact",
            detail: `${changedFile}: ${rule.reason}`,
          });
        }
      }
      if (rule.escalateToFull) {
        escalations.push(`${changedFile}: ${rule.reason}`);
      }
    }
  }

  const unknownProduction = changedFiles.filter(
    (file) =>
      input.impactMap.productionRoots.some((root) => file.startsWith(root)) &&
      !input.impactMap.rules.some((rule) =>
        rule.patterns.some((pattern) => matchesPattern(file, pattern))
      ),
  );
  if (unknownProduction.length > 0) {
    escalations.push(`unknown production impact: ${unknownProduction.join(", ")}`);
  }
  const productionChanges = changedFiles.filter((file) =>
    input.impactMap.productionRoots.some((root) => file.startsWith(root))
  );
  if (productionChanges.length >= input.impactMap.broadChangeFileThreshold) {
    escalations.push(
      `broad production change (${productionChanges.length} files, threshold ` +
        `${input.impactMap.broadChangeFileThreshold})`,
    );
  }
  if (phases.size >= input.impactMap.broadChangePhaseThreshold) {
    escalations.push(
      `multiple architectural boundaries (${[...phases].sort().join(", ")})`,
    );
  }
  if (input.mode === "full") escalations.push("full suite explicitly requested");

  const fullSuiteRequired = escalations.length > 0;
  if (fullSuiteRequired) {
    for (const suite of input.impactMap.suites) {
      add(suite.file, {
        code: "full-escalation",
        detail: escalations.join("; "),
      });
    }
  }

  const selectedTests: SelectedTest[] = input.impactMap.suites
    .filter((suite) => selected.has(suite.file))
    .map((suite) => ({
      file: suite.file,
      suiteId: suite.id,
      reasons: selected.get(suite.file) ?? [],
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  const selectedFiles = new Set(selectedTests.map((test) => test.file));

  return {
    schemaVersion: 1,
    generatedAt,
    commit: input.commit,
    mode: input.mode,
    ...(input.explicitIntent ? { explicitIntent: input.explicitIntent } : {}),
    changedFiles,
    selectedTests,
    skippedSuites: input.impactMap.suites
      .map((suite) => suite.file)
      .filter((file) => !selectedFiles.has(file))
      .sort(),
    escalations: [...new Set(escalations)],
    fullSuiteRequired,
    fullSuiteStatus: fullSuiteStatus(
      input.latestSuccessfulFullSuite,
      generatedAt,
    ),
    ...(input.latestSuccessfulFullSuite
      ? { latestSuccessfulFullSuite: input.latestSuccessfulFullSuite }
      : {}),
  };
}

function fullSuiteStatus(
  reference: FullSuiteReference | undefined,
  generatedAt: string,
): SelectionReceipt["fullSuiteStatus"] {
  if (!reference) {
    return {
      freshness: "unknown",
      maxAgeMs: FULL_SUITE_FRESHNESS_WINDOW_MS,
    };
  }
  const generatedTime = Date.parse(generatedAt);
  const completedTime = Date.parse(reference.completedAt);
  if (!Number.isFinite(generatedTime) || !Number.isFinite(completedTime)) {
    return {
      freshness: "unknown",
      maxAgeMs: FULL_SUITE_FRESHNESS_WINDOW_MS,
    };
  }
  const ageMs = Math.max(0, generatedTime - completedTime);
  return {
    freshness:
      ageMs <= FULL_SUITE_FRESHNESS_WINDOW_MS ? "current" : "stale",
    maxAgeMs: FULL_SUITE_FRESHNESS_WINDOW_MS,
    ageMs,
  };
}

export function matchesPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);
  const expression = normalizedPattern
    .split("**")
    .map((chunk) =>
      chunk
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]")
    )
    .join(".*");
  return new RegExp(`^${expression}$`).test(normalizedFile);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sameReason(left: Reason, right: Reason): boolean {
  return left.code === right.code && left.detail === right.detail;
}
