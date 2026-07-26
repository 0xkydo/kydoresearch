export const RESEARCH_PHASE_IDS = [
  "setup",
  "professor",
  "phd",
  "advisor",
  "finalization",
  "church",
  "metaharness",
  "ui",
] as const;

export type ResearchPhaseId = (typeof RESEARCH_PHASE_IDS)[number];

export const TEST_TIERS = [
  "kernel",
  "phase-contract",
  "phase-flow",
  "integration",
  "pty",
  "full",
] as const;

export type TestTier = (typeof TEST_TIERS)[number];

export const TEST_CATEGORIES = [
  "phase-local",
  "adjacent-boundary",
  "cross-cutting",
  "package-install",
  "full-loop",
] as const;

export type TestCategory = (typeof TEST_CATEGORIES)[number];

export const SELECTION_REASON_CODES = [
  "always-on-kernel",
  "explicit-phase",
  "explicit-segment",
  "changed-test",
  "import-dependency",
  "semantic-impact",
  "full-escalation",
] as const;

export type SelectionReasonCode = (typeof SELECTION_REASON_CODES)[number];

export interface TestSuiteDefinition {
  id: string;
  file: string;
  phases: ResearchPhaseId[];
  segments: string[];
  tiers: TestTier[];
  category: TestCategory;
}

export interface ImpactRule {
  patterns: string[];
  phases: ResearchPhaseId[];
  tiers: TestTier[];
  reason: string;
  escalateToFull?: boolean;
}

export interface TestImpactMapV1 {
  schemaVersion: 1;
  phases: ResearchPhaseId[];
  segments: Record<string, ResearchPhaseId>;
  tiers: TestTier[];
  productionRoots: string[];
  documentationPatterns: string[];
  broadChangeFileThreshold: number;
  broadChangePhaseThreshold: number;
  suites: TestSuiteDefinition[];
  rules: ImpactRule[];
}

export interface SelectedTest {
  file: string;
  suiteId: string;
  reasons: Array<{
    code: SelectionReasonCode;
    detail: string;
  }>;
}

export interface FullSuiteReference {
  commit: string;
  completedAt: string;
  durationMs: number;
  suiteDurations?: Record<string, number>;
}

export const FULL_SUITE_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FullSuiteStatus {
  freshness: "unknown" | "current" | "stale";
  maxAgeMs: number;
  ageMs?: number;
}

export interface TestExecutionReceipt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  suiteDurations: Record<string, number>;
}

export interface SelectionReceipt {
  schemaVersion: 1;
  generatedAt: string;
  commit: string;
  mode: "phase" | "related" | "full";
  explicitIntent?: string;
  changedFiles: string[];
  selectedTests: SelectedTest[];
  skippedSuites: string[];
  escalations: string[];
  fullSuiteRequired: boolean;
  fullSuiteStatus: FullSuiteStatus;
  latestSuccessfulFullSuite?: FullSuiteReference;
  execution?: TestExecutionReceipt;
}

export function isResearchPhaseId(value: string): value is ResearchPhaseId {
  return (RESEARCH_PHASE_IDS as readonly string[]).includes(value);
}

export function isTestTier(value: string): value is TestTier {
  return (TEST_TIERS as readonly string[]).includes(value);
}

export function parsePhaseIntent(
  value: string,
  impactMap: TestImpactMapV1,
): { phase: ResearchPhaseId; segment?: string } {
  if (isResearchPhaseId(value)) return { phase: value };
  const phase = impactMap.segments[value];
  if (phase) return { phase, segment: value };
  throw new Error(
    `Unknown phase or segment "${value}". Expected one of: ` +
      [...impactMap.phases, ...Object.keys(impactMap.segments)].join(", "),
  );
}

export function validateImpactMap(input: unknown): TestImpactMapV1 {
  const map = requireRecord(input, "impact map");
  requireExactKeys(
    map,
    [
      "schemaVersion",
      "phases",
      "segments",
      "tiers",
      "productionRoots",
      "documentationPatterns",
      "broadChangeFileThreshold",
      "broadChangePhaseThreshold",
      "suites",
      "rules",
    ],
    "impact map",
  );
  if (map.schemaVersion !== 1) {
    throw new Error(`Unsupported impact map schemaVersion ${String(map.schemaVersion)}`);
  }
  const phases = stringArray(map.phases, "impact map.phases");
  if (
    phases.length !== RESEARCH_PHASE_IDS.length ||
    RESEARCH_PHASE_IDS.some((phase) => !phases.includes(phase))
  ) {
    throw new Error(
      `impact map.phases must contain exactly: ${RESEARCH_PHASE_IDS.join(", ")}`,
    );
  }
  const tiers = stringArray(map.tiers, "impact map.tiers");
  if (
    tiers.length !== TEST_TIERS.length ||
    TEST_TIERS.some((tier) => !tiers.includes(tier))
  ) {
    throw new Error(`impact map.tiers must contain exactly: ${TEST_TIERS.join(", ")}`);
  }

  const rawSegments = requireRecord(map.segments, "impact map.segments");
  const segments: Record<string, ResearchPhaseId> = {};
  for (const [segment, phase] of Object.entries(rawSegments)) {
    if (!segment.includes(":") || typeof phase !== "string" || !isResearchPhaseId(phase)) {
      throw new Error(`Invalid segment mapping ${segment} -> ${String(phase)}`);
    }
    if (!segment.startsWith(`${phase}:`)) {
      throw new Error(`Segment ${segment} must be prefixed by its phase ${phase}`);
    }
    segments[segment] = phase;
  }

  const suites = array(map.suites, "impact map.suites").map((entry, index) =>
    validateSuite(entry, index, segments)
  );
  const suiteIds = new Set<string>();
  const suiteFiles = new Set<string>();
  for (const suite of suites) {
    if (suiteIds.has(suite.id)) throw new Error(`Duplicate suite id ${suite.id}`);
    if (suiteFiles.has(suite.file)) throw new Error(`Duplicate suite file ${suite.file}`);
    suiteIds.add(suite.id);
    suiteFiles.add(suite.file);
  }

  const rules = array(map.rules, "impact map.rules").map((entry, index) =>
    validateRule(entry, index)
  );
  return {
    schemaVersion: 1,
    phases: [...RESEARCH_PHASE_IDS],
    segments,
    tiers: [...TEST_TIERS],
    productionRoots: nonEmptyStringArray(
      map.productionRoots,
      "impact map.productionRoots",
    ),
    documentationPatterns: nonEmptyStringArray(
      map.documentationPatterns,
      "impact map.documentationPatterns",
    ),
    broadChangeFileThreshold: positiveInteger(
      map.broadChangeFileThreshold,
      "impact map.broadChangeFileThreshold",
    ),
    broadChangePhaseThreshold: positiveInteger(
      map.broadChangePhaseThreshold,
      "impact map.broadChangePhaseThreshold",
    ),
    suites,
    rules,
  };
}

function validateSuite(
  input: unknown,
  index: number,
  segments: Record<string, ResearchPhaseId>,
): TestSuiteDefinition {
  const label = `impact map.suites[${index}]`;
  const suite = requireRecord(input, label);
  requireExactKeys(
    suite,
    ["id", "file", "phases", "segments", "tiers", "category"],
    label,
  );
  const phases = phaseArray(suite.phases, `${label}.phases`);
  const suiteSegments = stringArray(suite.segments, `${label}.segments`);
  for (const segment of suiteSegments) {
    if (!segments[segment]) throw new Error(`${label}.segments contains unknown ${segment}`);
    if (!phases.includes(segments[segment])) {
      throw new Error(`${label} segment ${segment} requires phase ${segments[segment]}`);
    }
  }
  const tiers = tierArray(suite.tiers, `${label}.tiers`);
  const category = nonEmptyString(suite.category, `${label}.category`);
  if (!(TEST_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`${label}.category is invalid: ${category}`);
  }
  const file = nonEmptyString(suite.file, `${label}.file`);
  if (!file.startsWith("test/") || !file.endsWith(".test.ts")) {
    throw new Error(`${label}.file must be a test/**/*.test.ts path`);
  }
  return {
    id: nonEmptyString(suite.id, `${label}.id`),
    file,
    phases,
    segments: suiteSegments,
    tiers,
    category: category as TestCategory,
  };
}

function validateRule(input: unknown, index: number): ImpactRule {
  const label = `impact map.rules[${index}]`;
  const rule = requireRecord(input, label);
  const allowed = ["patterns", "phases", "tiers", "reason", "escalateToFull"];
  requireExactKeys(
    rule,
    allowed,
    label,
    ["patterns", "phases", "tiers", "reason"],
  );
  if (rule.escalateToFull !== undefined && typeof rule.escalateToFull !== "boolean") {
    throw new Error(`${label}.escalateToFull must be boolean`);
  }
  return {
    patterns: nonEmptyStringArray(rule.patterns, `${label}.patterns`),
    phases: phaseArray(rule.phases, `${label}.phases`),
    tiers: tierArray(rule.tiers, `${label}.tiers`),
    reason: nonEmptyString(rule.reason, `${label}.reason`),
    ...(rule.escalateToFull === true ? { escalateToFull: true } : {}),
  };
}

function phaseArray(input: unknown, label: string): ResearchPhaseId[] {
  return stringArray(input, label).map((value) => {
    if (!isResearchPhaseId(value)) throw new Error(`${label} contains unknown phase ${value}`);
    return value;
  });
}

function tierArray(input: unknown, label: string): TestTier[] {
  return stringArray(input, label).map((value) => {
    if (!isTestTier(value)) throw new Error(`${label} contains unknown tier ${value}`);
    return value;
  });
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  required: string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} keys are invalid` +
        (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : "") +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""),
    );
  }
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function array(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return input;
}

function stringArray(input: unknown, label: string): string[] {
  return array(input, label).map((value, index) =>
    nonEmptyString(value, `${label}[${index}]`)
  );
}

function nonEmptyStringArray(input: unknown, label: string): string[] {
  const values = stringArray(input, label);
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isInteger(input) || Number(input) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(input);
}
