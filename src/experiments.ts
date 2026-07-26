import * as path from "node:path";
import type { Direction } from "./util.ts";

/** Version of the persisted research contracts introduced by the Pi-native archive. */
export const EXPERIMENT_SCHEMA_VERSION = 1 as const;

export type ExperimentSchemaVersion = typeof EXPERIMENT_SCHEMA_VERSION;

export type SearchMode =
  | "refinement"
  | "exploration"
  | "repair"
  | "transplant"
  | "ablation"
  | "structural";

export const SEARCH_MODES: readonly SearchMode[] = [
  "refinement",
  "exploration",
  "repair",
  "transplant",
  "ablation",
  "structural",
];

/**
 * Canonical, persisted proposal. Scientific fields are deliberately required:
 * normalizeProposal fills explicit compatibility defaults for legacy
 * `{ title, spec }` proposals before anything is written to the archive.
 */
export interface CandidateProposalV1 {
  schemaVersion: ExperimentSchemaVersion;
  title: string;
  parentCandidateId: string;
  searchMode: SearchMode;
  editFamily: string;
  evidenceRefs: string[];
  observation: string;
  hypothesis: string;
  intervention: string;
  expectedResult: string;
  falsifiedWhen: string;
  risks: string[];
  nonGoals: string[];
  /** Human-readable implementation specification. */
  spec: string;
}

export interface LegacyProposedIdea {
  title: string;
  spec: string;
}

export interface ProposalDefaults {
  parentCandidateId: string;
  searchMode?: SearchMode;
  editFamily?: string;
}

const LEGACY_DEFAULTS = {
  observation: "No explicit observation was supplied by the legacy proposal.",
  hypothesis: "No explicit hypothesis was supplied by the legacy proposal.",
  expectedResult: "The intervention is expected to improve the challenge score.",
  falsifiedWhen: "The candidate fails verification or does not improve the comparison score.",
} as const;

/**
 * Convert professor output (including the old `{ title, spec }` shape) into
 * the only proposal shape that may be persisted.
 */
export function normalizeProposal(input: unknown, defaults: ProposalDefaults): CandidateProposalV1 {
  const value = record(input, "proposal");
  if ("schemaVersion" in value && value.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported proposal schemaVersion ${String(value.schemaVersion)}`);
  }

  const title = nonEmptyString(value.title, "proposal.title");
  const spec = nonEmptyString(value.spec, "proposal.spec");
  const parentCandidateId =
    optionalNonEmptyString(value.parentCandidateId, "proposal.parentCandidateId") ??
    nonEmptyString(defaults.parentCandidateId, "defaults.parentCandidateId");
  const searchMode = normalizeSearchMode(value.searchMode, defaults.searchMode ?? "exploration");
  const editFamily =
    optionalNonEmptyString(value.editFamily, "proposal.editFamily") ??
    optionalNonEmptyString(defaults.editFamily, "defaults.editFamily") ??
    "unspecified";

  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    title,
    parentCandidateId,
    searchMode,
    editFamily,
    evidenceRefs: stringArray(value.evidenceRefs, "proposal.evidenceRefs"),
    observation:
      optionalNonEmptyString(value.observation, "proposal.observation") ?? LEGACY_DEFAULTS.observation,
    hypothesis:
      optionalNonEmptyString(value.hypothesis, "proposal.hypothesis") ?? LEGACY_DEFAULTS.hypothesis,
    intervention: optionalNonEmptyString(value.intervention, "proposal.intervention") ?? spec,
    expectedResult:
      optionalNonEmptyString(value.expectedResult, "proposal.expectedResult") ??
      LEGACY_DEFAULTS.expectedResult,
    falsifiedWhen:
      optionalNonEmptyString(value.falsifiedWhen, "proposal.falsifiedWhen") ??
      LEGACY_DEFAULTS.falsifiedWhen,
    risks: stringArray(value.risks, "proposal.risks"),
    nonGoals: stringArray(value.nonGoals, "proposal.nonGoals"),
    spec,
  };
}

export interface ObjectiveV1 {
  score: number | null;
  direction: Direction;
  minimumImprovement: number;
}

interface ResearchTaskBaseV1<Kind extends string, Role extends string, Input> {
  schemaVersion: ExperimentSchemaVersion;
  taskId: string;
  kind: Kind;
  role: Role;
  /** Absolute path after the task is materialized. */
  taskPath: string;
  /** Absolute path to the main checkout's `.autoresearch` directory. */
  stateDir: string;
  /** Absolute path at which the task-specific structured result is expected. */
  resultPath: string;
  input: Input;
}

export interface SetupTaskInputV1 {
  repoRoot: string;
  manifestPath: string;
  knowledgeBasePath: string;
  setupCommand: string;
  setupLogPath: string;
  setupSucceeded: true;
}

export type SetupTaskV1 = ResearchTaskBaseV1<"init.explore", "setup", SetupTaskInputV1>;

export interface SetupReviewTaskInputV1 {
  repoRoot: string;
  manifestPath: string;
  knowledgeBasePath: string;
  previousVerifyCommand: string;
  previousBenchCommand: string;
  benchmarkLogPath: string;
  scorePath: string;
  benchmarkExitCode: number;
  benchmarkFailureTail: string;
}

export type SetupReviewTaskV1 = ResearchTaskBaseV1<
  "init.review",
  "setup",
  SetupReviewTaskInputV1
>;

export interface SetupDecisionTaskInputV1 {
  repoRoot: string;
  manifestPath: string;
  knowledgeBasePath: string;
  previousVerifyCommand: string;
  previousBenchCommand: string;
  decisionRequest: string;
  evidencePaths: string[];
}

export type SetupDecisionTaskV1 = ResearchTaskBaseV1<
  "init.decide",
  "setup",
  SetupDecisionTaskInputV1
>;

export interface ProfessorProposalTaskInputV1 {
  loop: number;
  objective: ObjectiveV1;
  maxIdeas: number;
  ledgerPath: string;
  knowledgeBasePath: string;
  runsDirectory: string;
  currentBestCandidateId: string;
  inFlightCandidateIds: string[];
  /** Operator preference captured immutably when this proposal task is created. */
  operatorSteering?: {
    text: string;
    updatedAt: string;
  };
}

export type ProfessorProposalTaskV1 = ResearchTaskBaseV1<
  "propose",
  "professor",
  ProfessorProposalTaskInputV1
>;

export interface PhdImplementationTaskInputV1 {
  candidateId: string;
  parentCandidateId: string;
  attempt: number;
  maximumAttempts: number;
  proposalPath: string;
  requiredEvidence: string[];
  /** Explicit repo-local instructions replacing Pi's disabled ambient context loading. */
  repositoryInstructionPaths: string[];
  editablePaths: string[];
  readOnlyPaths: string[];
  verifyCommand: string;
  /** Setup's durable statement of whether this command is full or reduced validation. */
  localEvaluation?: LocalEvaluationV1;
  benchmarkProhibited: true;
  previousVerifierReport?: string;
  requiredCompletionFields: string[];
}

export type PhdImplementationTaskV1 = ResearchTaskBaseV1<
  "implement",
  "phd",
  PhdImplementationTaskInputV1
>;

export type CandidateTerminalStatus =
  | "failed"
  | "done-no-improvement"
  | "done-superseded"
  | "done-improved";

export interface PhdPostmortemTaskInputV1 {
  candidateId: string;
  proposalPath: string;
  implementationTaskPath: string;
  sourcePath: string;
  diffPath: string;
  metricsPath: string;
  integrityPath: string;
  verifyLogPath: string;
  benchmarkLogPath: string;
  terminalStatus: CandidateTerminalStatus;
  score?: number;
  comparisonScore: number | null;
  failure?: string;
  postmortemPath: string;
}

export type PhdPostmortemTaskV1 = ResearchTaskBaseV1<
  "postmortem",
  "phd",
  PhdPostmortemTaskInputV1
>;

export interface AdvisorTaskInputV1 {
  loop: number;
  watchdogPath: string;
  statePath: string;
  candidateRunPaths: string[];
}

export type AdvisorTaskV1 = ResearchTaskBaseV1<"advise", "advisor", AdvisorTaskInputV1>;

export interface GodConversationTaskInputV1 {
  loop: number;
  dryLoopStreak: number;
  recentRunPaths: string[];
  notePath: string;
}

export type GodConversationTaskV1 = ResearchTaskBaseV1<
  "god-conversation",
  "god",
  GodConversationTaskInputV1
>;

export interface MetaHarnessEvolutionTaskInputV1 {
  generation: number;
  candidateId: string;
  parentCandidateId: string;
  candidateDirectory: string;
  profilePath: string;
  parentProfilePath: string;
  metaLedgerPath: string;
  metaFrontierPath: string;
  innerLedgerPath: string;
  innerRunsDirectory: string;
  candidatesDirectory: string;
  verifierContractPath: string;
  editableRoles: string[];
  maxProfileBytes: number;
}

export type MetaHarnessEvolutionTaskV1 = ResearchTaskBaseV1<
  "evolve-harness",
  "metaharness",
  MetaHarnessEvolutionTaskInputV1
>;

export type ResearchTaskV1 =
  | SetupTaskV1
  | SetupReviewTaskV1
  | SetupDecisionTaskV1
  | ProfessorProposalTaskV1
  | PhdImplementationTaskV1
  | PhdPostmortemTaskV1
  | AdvisorTaskV1
  | GodConversationTaskV1
  | MetaHarnessEvolutionTaskV1;

/**
 * Runtime boundary for agent- or configuration-originated task data. This is
 * intentionally stricter than a TypeScript cast: persisted tasks must have a
 * supported version, a role/kind pairing, absolute ownership paths, and the
 * required kind-specific input fields.
 */
export function validateResearchTask(input: unknown): ResearchTaskV1 {
  const task = record(input, "task");
  if (task.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported task schemaVersion ${String(task.schemaVersion)}`);
  }
  nonEmptyString(task.taskId, "task.taskId");
  absolutePath(task.taskPath, "task.taskPath");
  absolutePath(task.stateDir, "task.stateDir");
  absolutePath(task.resultPath, "task.resultPath");
  const taskInput = record(task.input, "task.input");

  switch (task.kind) {
    case "init.explore":
      expectedRole(task.role, "setup", task.kind);
      absolutePath(taskInput.repoRoot, "task.input.repoRoot");
      absolutePath(taskInput.manifestPath, "task.input.manifestPath");
      absolutePath(taskInput.knowledgeBasePath, "task.input.knowledgeBasePath");
      nonEmptyString(taskInput.setupCommand, "task.input.setupCommand");
      absolutePath(taskInput.setupLogPath, "task.input.setupLogPath");
      if (taskInput.setupSucceeded !== true) {
        throw new Error("task.input.setupSucceeded must be true");
      }
      break;
    case "init.review":
      expectedRole(task.role, "setup", task.kind);
      absolutePath(taskInput.repoRoot, "task.input.repoRoot");
      absolutePath(taskInput.manifestPath, "task.input.manifestPath");
      absolutePath(taskInput.knowledgeBasePath, "task.input.knowledgeBasePath");
      nonEmptyString(taskInput.previousVerifyCommand, "task.input.previousVerifyCommand");
      nonEmptyString(taskInput.previousBenchCommand, "task.input.previousBenchCommand");
      absolutePath(taskInput.benchmarkLogPath, "task.input.benchmarkLogPath");
      absolutePath(taskInput.scorePath, "task.input.scorePath");
      nonNegativeInteger(taskInput.benchmarkExitCode, "task.input.benchmarkExitCode");
      nonEmptyString(taskInput.benchmarkFailureTail, "task.input.benchmarkFailureTail");
      break;
    case "init.decide":
      expectedRole(task.role, "setup", task.kind);
      absolutePath(taskInput.repoRoot, "task.input.repoRoot");
      absolutePath(taskInput.manifestPath, "task.input.manifestPath");
      absolutePath(taskInput.knowledgeBasePath, "task.input.knowledgeBasePath");
      nonEmptyString(taskInput.previousVerifyCommand, "task.input.previousVerifyCommand");
      nonEmptyString(taskInput.previousBenchCommand, "task.input.previousBenchCommand");
      nonEmptyString(taskInput.decisionRequest, "task.input.decisionRequest");
      absolutePathArray(taskInput.evidencePaths, "task.input.evidencePaths");
      break;
    case "propose":
      expectedRole(task.role, "professor", task.kind);
      nonNegativeInteger(taskInput.loop, "task.input.loop");
      positiveInteger(taskInput.maxIdeas, "task.input.maxIdeas");
      absolutePath(taskInput.ledgerPath, "task.input.ledgerPath");
      absolutePath(taskInput.knowledgeBasePath, "task.input.knowledgeBasePath");
      absolutePath(taskInput.runsDirectory, "task.input.runsDirectory");
      nonEmptyString(taskInput.currentBestCandidateId, "task.input.currentBestCandidateId");
      stringArray(taskInput.inFlightCandidateIds, "task.input.inFlightCandidateIds");
      if (taskInput.operatorSteering !== undefined) {
        const steering = record(
          taskInput.operatorSteering,
          "task.input.operatorSteering",
        );
        nonEmptyString(steering.text, "task.input.operatorSteering.text");
        nonEmptyString(steering.updatedAt, "task.input.operatorSteering.updatedAt");
      }
      validateObjective(taskInput.objective);
      break;
    case "implement":
      expectedRole(task.role, "phd", task.kind);
      nonEmptyString(taskInput.candidateId, "task.input.candidateId");
      nonEmptyString(taskInput.parentCandidateId, "task.input.parentCandidateId");
      positiveInteger(taskInput.attempt, "task.input.attempt");
      positiveInteger(taskInput.maximumAttempts, "task.input.maximumAttempts");
      absolutePath(taskInput.proposalPath, "task.input.proposalPath");
      stringArray(taskInput.requiredEvidence, "task.input.requiredEvidence");
      absolutePathArray(
        taskInput.repositoryInstructionPaths,
        "task.input.repositoryInstructionPaths",
      );
      nonEmptyStringArray(taskInput.editablePaths, "task.input.editablePaths");
      stringArray(taskInput.readOnlyPaths, "task.input.readOnlyPaths");
      nonEmptyString(taskInput.verifyCommand, "task.input.verifyCommand");
      if (taskInput.localEvaluation !== undefined) {
        validateLocalEvaluation(
          taskInput.localEvaluation,
          "task.input.localEvaluation",
        );
      }
      if (taskInput.benchmarkProhibited !== true) {
        throw new Error("task.input.benchmarkProhibited must be true");
      }
      nonEmptyStringArray(
        taskInput.requiredCompletionFields,
        "task.input.requiredCompletionFields",
      );
      optionalNonEmptyString(taskInput.previousVerifierReport, "task.input.previousVerifierReport");
      break;
    case "postmortem":
      expectedRole(task.role, "phd", task.kind);
      nonEmptyString(taskInput.candidateId, "task.input.candidateId");
      for (const field of [
        "proposalPath",
        "implementationTaskPath",
        "sourcePath",
        "diffPath",
        "metricsPath",
        "integrityPath",
        "verifyLogPath",
        "benchmarkLogPath",
        "postmortemPath",
      ] as const) {
        absolutePath(taskInput[field], `task.input.${field}`);
      }
      terminalStatus(taskInput.terminalStatus, "task.input.terminalStatus");
      nullableFiniteNumber(taskInput.comparisonScore, "task.input.comparisonScore");
      optionalFiniteNumber(taskInput.score, "task.input.score");
      optionalNonEmptyString(taskInput.failure, "task.input.failure");
      break;
    case "advise":
      expectedRole(task.role, "advisor", task.kind);
      nonNegativeInteger(taskInput.loop, "task.input.loop");
      absolutePath(taskInput.watchdogPath, "task.input.watchdogPath");
      absolutePath(taskInput.statePath, "task.input.statePath");
      nonEmptyStringArray(taskInput.candidateRunPaths, "task.input.candidateRunPaths");
      break;
    case "god-conversation":
      expectedRole(task.role, "god", task.kind);
      nonNegativeInteger(taskInput.loop, "task.input.loop");
      nonNegativeInteger(taskInput.dryLoopStreak, "task.input.dryLoopStreak");
      stringArray(taskInput.recentRunPaths, "task.input.recentRunPaths");
      absolutePath(taskInput.notePath, "task.input.notePath");
      break;
    case "evolve-harness":
      expectedRole(task.role, "metaharness", task.kind);
      positiveInteger(taskInput.generation, "task.input.generation");
      nonEmptyString(taskInput.candidateId, "task.input.candidateId");
      nonEmptyString(taskInput.parentCandidateId, "task.input.parentCandidateId");
      for (const field of [
        "candidateDirectory",
        "profilePath",
        "parentProfilePath",
        "metaLedgerPath",
        "metaFrontierPath",
        "innerLedgerPath",
        "innerRunsDirectory",
        "candidatesDirectory",
        "verifierContractPath",
      ] as const) {
        absolutePath(taskInput[field], `task.input.${field}`);
      }
      nonEmptyStringArray(taskInput.editableRoles, "task.input.editableRoles");
      positiveInteger(taskInput.maxProfileBytes, "task.input.maxProfileBytes");
      break;
    default:
      throw new Error(`Unsupported task kind ${String(task.kind)}`);
  }

  return task as unknown as ResearchTaskV1;
}

interface ResearchResultBaseV1<Kind extends string> {
  schemaVersion: ExperimentSchemaVersion;
  taskId: string;
  kind: Kind;
  ok: boolean;
  summary: string;
  error?: string;
}

export interface LocalEvaluationV1 {
  fidelity: "full" | "reduced";
  decision: string;
  limitations: string[];
  officialValidationRequired: boolean;
}

export interface SetupResultV1 extends ResearchResultBaseV1<"init.explore.result"> {
  subjectArea?: string;
  knowledgeBasePath: string;
  verifyCommand: string;
  benchCommand: string;
  localEvaluation: LocalEvaluationV1;
  checkpointFingerprint: string;
  reviewCount: number;
}

export interface ProfessorProposalResultV1 extends ResearchResultBaseV1<"propose.result"> {
  proposals: CandidateProposalV1[];
}

export interface PhdImplementationResultV1 extends ResearchResultBaseV1<"implement.result"> {
  candidateId: string;
  changedFiles: string[];
  checks: string[];
  assumptions: string[];
  deviations: string[];
}

export interface PhdPostmortemResultV1 extends ResearchResultBaseV1<"postmortem.result"> {
  candidateId: string;
  postmortemPath: string;
  lessons: string[];
}

export interface AdvisorResultV1 extends ResearchResultBaseV1<"advise.result"> {
  notes: Array<{ severity: "info" | "warning" | "blocker"; text: string; evidenceRefs: string[] }>;
}

export interface GodConversationResultV1 extends ResearchResultBaseV1<"god-conversation.result"> {
  notePath: string;
}

export interface MetaHarnessEvolutionResultV1
  extends ResearchResultBaseV1<"evolve-harness.result"> {
  candidateId: string;
  profilePath: string;
}

export type ResearchResultV1 =
  | SetupResultV1
  | ProfessorProposalResultV1
  | PhdImplementationResultV1
  | PhdPostmortemResultV1
  | AdvisorResultV1
  | GodConversationResultV1
  | MetaHarnessEvolutionResultV1;

export interface EvaluationCommandV1 {
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  timeoutMs: number;
  exitCode: number | null;
  timedOut: boolean;
  outputPath: string;
}

export interface CandidateMetricsV1 {
  schemaVersion: ExperimentSchemaVersion;
  candidateId: string;
  terminalStatus: CandidateTerminalStatus;
  comparisonScore: number | null;
  score?: number;
  improved: boolean;
  verify: EvaluationCommandV1[];
  benchmark?: EvaluationCommandV1;
  failure?: string;
}

export interface CandidateIntegrityV1 {
  schemaVersion: ExperimentSchemaVersion;
  candidateId: string;
  parentCandidateId: string;
  checkedAt: string;
  passed: boolean;
  changedFiles: string[];
  unexpectedFiles: string[];
  evaluatorHashes?: Record<string, string>;
}

export interface CandidateParentV1 {
  schemaVersion: ExperimentSchemaVersion;
  candidateId: string;
  parentCandidateId: string;
  baseRevision: string;
  parentSourcePath: string;
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function nonEmptyStringArray(value: unknown, label: string): string[] {
  const result = stringArray(value, label);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function normalizeSearchMode(value: unknown, fallback: SearchMode): SearchMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !SEARCH_MODES.includes(value as SearchMode)) {
    throw new Error(`proposal.searchMode must be one of: ${SEARCH_MODES.join(", ")}`);
  }
  return value as SearchMode;
}

function absolutePath(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be an absolute path`);
  return result;
}

function absolutePathArray(value: unknown, label: string): string[] {
  const result = stringArray(value, label);
  result.forEach((item, index) => absolutePath(item, `${label}[${index}]`));
  return result;
}

function expectedRole(value: unknown, role: string, kind: unknown): void {
  if (value !== role) throw new Error(`Task kind ${String(kind)} requires role ${role}`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} must be positive`);
  return result;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return finiteNumber(value, label);
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, label);
}

function validateObjective(input: unknown): void {
  const objective = record(input, "task.input.objective");
  nullableFiniteNumber(objective.score, "task.input.objective.score");
  if (objective.direction !== "+" && objective.direction !== "-") {
    throw new Error('task.input.objective.direction must be "+" or "-"');
  }
  const minimum = finiteNumber(
    objective.minimumImprovement,
    "task.input.objective.minimumImprovement",
  );
  if (minimum < 0) throw new Error("task.input.objective.minimumImprovement must not be negative");
}

function validateLocalEvaluation(value: unknown, label: string): void {
  const evaluation = record(value, label);
  if (evaluation.fidelity !== "full" && evaluation.fidelity !== "reduced") {
    throw new Error(`${label}.fidelity must be "full" or "reduced"`);
  }
  nonEmptyString(evaluation.decision, `${label}.decision`);
  stringArray(evaluation.limitations, `${label}.limitations`);
  if (typeof evaluation.officialValidationRequired !== "boolean") {
    throw new Error(`${label}.officialValidationRequired must be boolean`);
  }
}

function terminalStatus(value: unknown, label: string): CandidateTerminalStatus {
  if (
    value !== "failed" &&
    value !== "done-no-improvement" &&
    value !== "done-superseded" &&
    value !== "done-improved"
  ) {
    throw new Error(`${label} is not a terminal candidate status`);
  }
  return value;
}
