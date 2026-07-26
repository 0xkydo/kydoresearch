import * as path from "node:path";
import type { LocalEvaluationV1 } from "./experiments.ts";
import { atomicWriteJson, readJsonIfExists } from "./util.ts";

export const INITIALIZATION_REPORT_VERSION = 1;

export type InitializationStepId =
  | "validate"
  | "setup"
  | "setup-agent"
  | "baseline"
  | "archive";

export type InitializationStepStatus =
  | "pending"
  | "running"
  | "retrying"
  | "resuming"
  | "passed"
  | "failed";

export type InitializationFailureCode =
  | "invalid-manifest"
  | "not-git-repository"
  | "state-path-conflict"
  | "profile-unavailable"
  | "command-not-found"
  | "command-timeout"
  | "setup-command-failed"
  | "setup-agent-failed"
  | "setup-result-invalid"
  | "external-capability-blocker"
  | "score-file-missing"
  | "score-json-invalid"
  | "score-value-invalid"
  | "baseline-failed"
  | "persistence-failed"
  | "unexpected";

export interface InitializationDiagnosticV1 {
  code: InitializationFailureCode;
  step: InitializationStepId;
  title: string;
  reason: string;
  action: string;
  evidencePath?: string;
  command?: string;
  exitCode?: number;
  retryable: boolean;
  resumesFromCheckpoint: boolean;
}

export class InitializationError extends Error {
  constructor(readonly diagnostic: InitializationDiagnosticV1) {
    super(
      `${diagnostic.title}\nReason: ${diagnostic.reason}\nAction: ${diagnostic.action}` +
        (diagnostic.evidencePath
          ? `\nEvidence: ${diagnostic.evidencePath}`
          : ""),
    );
    this.name = "InitializationError";
  }
}

export interface InitializationStepV1 {
  id: InitializationStepId;
  label: string;
  status: InitializationStepStatus;
  detail?: string;
  command?: string;
  logPath?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface InitializationSummaryV1 {
  readiness: "ready" | "ready-with-limitations";
  baselineScore: number;
  direction: "+" | "-";
  verifyCommand: string;
  benchCommand: string;
  localEvaluation: LocalEvaluationV1;
  submissionReady: boolean;
  evidencePath: string;
}

export interface InitializationReportV1 {
  schemaVersion: typeof INITIALIZATION_REPORT_VERSION;
  challengeName: string;
  status: "running" | "failed" | "ready" | "ready-with-limitations";
  currentStep: InitializationStepId;
  steps: InitializationStepV1[];
  recentActivity: string[];
  updatedAt: string;
  diagnostic?: InitializationDiagnosticV1;
  summary?: InitializationSummaryV1;
}

const STEP_LABELS: Record<InitializationStepId, string> = {
  validate: "Validate challenge and Git checkout",
  setup: "Install challenge dependencies",
  "setup-agent": "Map repository and local hardware",
  baseline: "Measure and validate the local baseline",
  archive: "Archive baseline and save ready state",
};

export function createInitializationReport(
  challengeName: string,
): InitializationReportV1 {
  return {
    schemaVersion: INITIALIZATION_REPORT_VERSION,
    challengeName,
    status: "running",
    currentStep: "validate",
    steps: (Object.keys(STEP_LABELS) as InitializationStepId[]).map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: "pending",
    })),
    recentActivity: [],
    updatedAt: new Date().toISOString(),
  };
}

export function initializationReportPath(stateDir: string): string {
  return path.join(stateDir, "loops", "init", "status.json");
}

export function loadInitializationReport(
  stateDir: string,
): InitializationReportV1 | null {
  const report = readJsonIfExists<InitializationReportV1>(
    initializationReportPath(stateDir),
  );
  if (
    report?.schemaVersion !== INITIALIZATION_REPORT_VERSION ||
    !Array.isArray(report.steps)
  ) {
    return null;
  }
  return report;
}

export function saveInitializationReport(
  stateDir: string,
  report: InitializationReportV1,
): void {
  report.updatedAt = new Date().toISOString();
  atomicWriteJson(initializationReportPath(stateDir), report);
}

export function updateInitializationStep(
  report: InitializationReportV1,
  update: Omit<InitializationStepV1, "label"> & { label?: string },
  activity?: string,
): InitializationReportV1 {
  const next = structuredClone(report);
  const step = next.steps.find((entry) => entry.id === update.id);
  if (!step) return next;
  Object.assign(step, update, { label: update.label ?? step.label });
  next.currentStep = update.id;
  next.status = update.status === "failed" ? "failed" : "running";
  delete next.diagnostic;
  if (activity) {
    next.recentActivity = [
      activity,
      ...next.recentActivity.filter((entry) => entry !== activity),
    ].slice(0, 4);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export function failInitializationReport(
  report: InitializationReportV1,
  diagnostic: InitializationDiagnosticV1,
): InitializationReportV1 {
  const next = structuredClone(report);
  next.status = "failed";
  next.currentStep = diagnostic.step;
  next.diagnostic = diagnostic;
  const step = next.steps.find((entry) => entry.id === diagnostic.step);
  if (step) {
    step.status = "failed";
    step.detail = diagnostic.title;
    if (diagnostic.command) step.command = diagnostic.command;
    if (diagnostic.evidencePath) step.logPath = diagnostic.evidencePath;
  }
  next.recentActivity = [
    `${diagnostic.title}: ${diagnostic.reason}`,
    ...next.recentActivity,
  ].slice(0, 4);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function completeInitializationReport(
  report: InitializationReportV1,
  summary: InitializationSummaryV1,
): InitializationReportV1 {
  const next = structuredClone(report);
  next.status = summary.readiness;
  next.currentStep = "archive";
  next.summary = summary;
  delete next.diagnostic;
  for (const step of next.steps) step.status = "passed";
  next.recentActivity = [
    `baseline ${summary.baselineScore} · ${
      summary.readiness === "ready" ? "full local evaluation" : "ready with limitations"
    }`,
    ...next.recentActivity,
  ].slice(0, 4);
  next.updatedAt = new Date().toISOString();
  return next;
}
