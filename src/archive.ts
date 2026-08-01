import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CandidateIntegrityV1,
  CandidateMetricsV1,
  CandidateParentV1,
  CandidateProposalV1,
  CandidateTerminalStatus,
  ResearchTaskV1,
  SearchMode,
} from "./experiments.ts";
import { EXPERIMENT_SCHEMA_VERSION, validateResearchTask } from "./experiments.ts";
import { Mutex, readJson } from "./util.ts";

export const ARCHIVE_SCHEMA_VERSION = 1 as const;

export interface CandidateRunRecordV1 {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  candidateId: string;
  parentCandidateId: string;
  baseRevision: string;
  status: "active" | "sealed";
  createdAt: string;
  sealedAt?: string;
  terminalStatus?: CandidateTerminalStatus;
}

export interface CreateCandidateRunInput {
  candidateId: string;
  parentCandidateId: string;
  baseRevision: string;
  createdAt?: string;
}

export interface CandidateLedgerRecordV1 {
  schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  candidateId: string;
  parentCandidateId: string;
  title: string;
  terminalStatus: CandidateTerminalStatus;
  searchMode: SearchMode;
  editFamily: string;
  score?: number;
  comparisonScore: number | null;
  improved: boolean;
  submission?: {
    submissionId?: string;
    promoted?: boolean;
  };
  runPath: string;
  recordedAt: string;
}

export type NewCandidateLedgerRecord = Omit<
  CandidateLedgerRecordV1,
  "schemaVersion" | "runPath" | "recordedAt"
> & {
  recordedAt?: string;
};

export interface SealCandidateRunOptions {
  terminalStatus: CandidateTerminalStatus;
  sealedAt?: string;
  /**
   * Override the standard required artifact set. Paths may be absolute or
   * relative to the run directory and must remain inside it.
   */
  requiredArtifacts?: string[];
}

export interface RunReadiness {
  ready: boolean;
  missing: string[];
}

export function archivePaths(stateDir: string) {
  return {
    runsDir: path.join(stateDir, "runs"),
    ledger: path.join(stateDir, "ledger.ndjson"),
  };
}

export function candidateRunPaths(stateDir: string, candidateId: string) {
  assertCandidateId(candidateId);
  const root = path.join(archivePaths(stateDir).runsDir, candidateId);
  return {
    root,
    record: path.join(root, "run.json"),
    task: path.join(root, "task.json"),
    proposal: path.join(root, "proposal.json"),
    parent: path.join(root, "parent.json"),
    source: path.join(root, "source"),
    diff: path.join(root, "diff.patch"),
    metrics: path.join(root, "metrics.json"),
    integrity: path.join(root, "integrity.json"),
    postmortem: path.join(root, "postmortem.md"),
    agentDir: path.join(root, "agent"),
    agentSoul: path.join(root, "agent", "soul.md"),
    agentContext: path.join(root, "agent", "context.md"),
    agentInvocation: path.join(root, "agent", "invocation.json"),
    agentEvents: path.join(root, "agent", "events.ndjson"),
    agentFinal: path.join(root, "agent", "final.md"),
    logsDir: path.join(root, "logs"),
    verifyLog: path.join(root, "logs", "verify.log"),
    benchmarkLog: path.join(root, "logs", "benchmark.log"),
  };
}

/**
 * Create an active run. Repeating the call is resume-safe only when lineage
 * and base revision agree exactly.
 */
export function createCandidateRun(
  stateDir: string,
  input: CreateCandidateRunInput,
): ReturnType<typeof candidateRunPaths> {
  const paths = candidateRunPaths(stateDir, input.candidateId);
  fs.mkdirSync(archivePaths(stateDir).runsDir, { recursive: true });
  try {
    fs.mkdirSync(paths.root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const existing = readRunRecord(stateDir, input.candidateId);
    if (
      existing.parentCandidateId !== input.parentCandidateId ||
      existing.baseRevision !== input.baseRevision
    ) {
      throw new Error(`Candidate run ${input.candidateId} already exists with different lineage`);
    }
    return paths;
  }

  fs.mkdirSync(paths.source, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const record: CandidateRunRecordV1 = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    candidateId: input.candidateId,
    parentCandidateId: input.parentCandidateId,
    baseRevision: input.baseRevision,
    status: "active",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  atomicWriteJson(paths.record, record);
  return paths;
}

export function readRunRecord(stateDir: string, candidateId: string): CandidateRunRecordV1 {
  const record = readJson<CandidateRunRecordV1>(candidateRunPaths(stateDir, candidateId).record);
  if (record.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw new Error(`Unsupported run schemaVersion ${String(record.schemaVersion)} for ${candidateId}`);
  }
  if (record.candidateId !== candidateId) {
    throw new Error(`Run record candidate ID mismatch: expected ${candidateId}, got ${record.candidateId}`);
  }
  if (record.status !== "active" && record.status !== "sealed") {
    throw new Error(`Invalid run status ${String(record.status)} for ${candidateId}`);
  }
  return record;
}

export function isCandidateRunSealed(stateDir: string, candidateId: string): boolean {
  return readRunRecord(stateDir, candidateId).status === "sealed";
}

export function assertCandidateRunWritable(stateDir: string, candidateId: string): void {
  const record = readRunRecord(stateDir, candidateId);
  if (record.status !== "active") {
    throw new Error(`Candidate run ${candidateId} is sealed and immutable`);
  }
}

/** Tasks and proposals are immutable even while the rest of a run is active. */
export function writeCandidateTask(stateDir: string, candidateId: string, task: ResearchTaskV1): void {
  const validated = validateResearchTask(task);
  const paths = candidateRunPaths(stateDir, candidateId);
  if (path.resolve(validated.stateDir) !== path.resolve(stateDir)) {
    throw new Error(`task stateDir does not match the archive for ${candidateId}`);
  }
  if (path.resolve(validated.taskPath) !== path.resolve(paths.task)) {
    throw new Error(`task taskPath does not match the archive path for ${candidateId}`);
  }
  resolveRunArtifact(paths.root, validated.resultPath);
  if ("candidateId" in validated.input) {
    assertMatchingCandidate(candidateId, validated.input.candidateId, "task");
  }
  writeImmutableJsonArtifact(stateDir, candidateId, paths.task, task);
}

export function writeCandidateProposal(
  stateDir: string,
  candidateId: string,
  proposal: CandidateProposalV1,
): void {
  if (proposal.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported proposal schemaVersion ${String(proposal.schemaVersion)}`);
  }
  const run = readRunRecord(stateDir, candidateId);
  if (proposal.parentCandidateId !== run.parentCandidateId) {
    throw new Error(`proposal parent candidate does not match run ${candidateId}`);
  }
  writeImmutableJsonArtifact(
    stateDir,
    candidateId,
    candidateRunPaths(stateDir, candidateId).proposal,
    proposal,
  );
}

export function writeCandidateParent(
  stateDir: string,
  candidateId: string,
  parent: CandidateParentV1,
): void {
  if (parent.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported parent schemaVersion ${String(parent.schemaVersion)}`);
  }
  assertMatchingCandidate(candidateId, parent.candidateId, "parent");
  const run = readRunRecord(stateDir, candidateId);
  if (
    parent.parentCandidateId !== run.parentCandidateId ||
    parent.baseRevision !== run.baseRevision
  ) {
    throw new Error(`parent artifact does not match run lineage for ${candidateId}`);
  }
  writeImmutableJsonArtifact(
    stateDir,
    candidateId,
    candidateRunPaths(stateDir, candidateId).parent,
    parent,
  );
}

export function writeCandidateMetrics(
  stateDir: string,
  candidateId: string,
  metrics: CandidateMetricsV1,
): void {
  if (metrics.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported metrics schemaVersion ${String(metrics.schemaVersion)}`);
  }
  assertMatchingCandidate(candidateId, metrics.candidateId, "metrics");
  writeActiveJsonArtifact(stateDir, candidateId, candidateRunPaths(stateDir, candidateId).metrics, metrics);
}

export function writeCandidateIntegrity(
  stateDir: string,
  candidateId: string,
  integrity: CandidateIntegrityV1,
): void {
  if (integrity.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported integrity schemaVersion ${String(integrity.schemaVersion)}`);
  }
  assertMatchingCandidate(candidateId, integrity.candidateId, "integrity");
  writeActiveJsonArtifact(
    stateDir,
    candidateId,
    candidateRunPaths(stateDir, candidateId).integrity,
    integrity,
  );
}

export function writeCandidatePostmortem(
  stateDir: string,
  candidateId: string,
  markdown: string,
): void {
  if (markdown.trim() === "") throw new Error("Candidate postmortem must not be empty");
  assertCandidateRunWritable(stateDir, candidateId);
  atomicWriteText(candidateRunPaths(stateDir, candidateId).postmortem, ensureTrailingNewline(markdown));
}

export function candidateRunReadiness(
  stateDir: string,
  candidateId: string,
  requiredArtifacts?: string[],
): RunReadiness {
  const paths = candidateRunPaths(stateDir, candidateId);
  const required =
    requiredArtifacts ??
    [
      paths.task,
      paths.proposal,
      paths.parent,
      paths.source,
      paths.diff,
      paths.metrics,
      paths.integrity,
      paths.postmortem,
      paths.verifyLog,
      paths.benchmarkLog,
    ];
  const missing = required
    .map((artifact) => resolveRunArtifact(paths.root, artifact))
    .filter((artifact) => !fs.existsSync(artifact))
    .map((artifact) => path.relative(paths.root, artifact) || ".");
  return { ready: missing.length === 0, missing };
}

export function sealCandidateRun(
  stateDir: string,
  candidateId: string,
  options: SealCandidateRunOptions,
): CandidateRunRecordV1 {
  assertCandidateRunWritable(stateDir, candidateId);
  const readiness = candidateRunReadiness(stateDir, candidateId, options.requiredArtifacts);
  if (!readiness.ready) {
    throw new Error(
      `Cannot seal candidate run ${candidateId}; missing required artifacts: ${readiness.missing.join(", ")}`,
    );
  }
  const current = readRunRecord(stateDir, candidateId);
  const metricsPath = candidateRunPaths(stateDir, candidateId).metrics;
  if (fs.existsSync(metricsPath)) {
    const metrics = readJson<CandidateMetricsV1>(metricsPath);
    if (metrics.candidateId !== candidateId || metrics.terminalStatus !== options.terminalStatus) {
      throw new Error(`Candidate metrics do not match the terminal run status for ${candidateId}`);
    }
  }
  const sealed: CandidateRunRecordV1 = {
    ...current,
    status: "sealed",
    terminalStatus: options.terminalStatus,
    sealedAt: options.sealedAt ?? new Date().toISOString(),
  };
  atomicWriteJson(candidateRunPaths(stateDir, candidateId).record, sealed);
  return sealed;
}

/**
 * Snapshot the complete editable surface. The target is replaced so stale
 * files from an earlier interrupted snapshot cannot survive.
 */
export function snapshotEditableSource(
  sourceRoot: string,
  snapshotRoot: string,
  editablePaths: string[],
): void {
  assertSafeCopyRoots(sourceRoot, snapshotRoot, "snapshot");
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  fs.mkdirSync(snapshotRoot, { recursive: true });
  copyEditablePaths(sourceRoot, snapshotRoot, editablePaths, false);
}

/**
 * Materialize a parent snapshot into a worktree. Each editable destination is
 * removed first, which faithfully carries parent-side deletions.
 */
export function copyEditableSource(
  snapshotRoot: string,
  destinationRoot: string,
  editablePaths: string[],
): void {
  assertSafeCopyRoots(snapshotRoot, destinationRoot, "materialization");
  copyEditablePaths(snapshotRoot, destinationRoot, editablePaths, true);
}

export function generateCandidateDiff(
  parentSnapshotRoot: string,
  candidateRoot: string,
  editablePaths: string[],
): string {
  const before = collectEditableEntries(parentSnapshotRoot, editablePaths);
  const after = collectEditableEntries(candidateRoot, editablePaths);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const chunks: string[] = [];
  for (const name of names) {
    const oldEntry = before.get(name);
    const newEntry = after.get(name);
    if (entriesEqual(oldEntry, newEntry)) continue;
    chunks.push(renderEntryDiff(name, oldEntry, newEntry));
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n")}\n`;
}

export function writeCandidateDiff(
  stateDir: string,
  candidateId: string,
  parentSnapshotRoot: string,
  candidateRoot: string,
  editablePaths: string[],
): string {
  assertCandidateRunWritable(stateDir, candidateId);
  const diff = generateCandidateDiff(parentSnapshotRoot, candidateRoot, editablePaths);
  atomicWriteText(candidateRunPaths(stateDir, candidateId).diff, diff);
  return diff;
}

const ledgerLocks = new Map<string, Mutex>();

/**
 * Append one terminal compact record. A module-scoped FIFO mutex serializes
 * every writer for the same ledger in this process.
 */
export async function appendLedgerRecord(
  stateDir: string,
  record: NewCandidateLedgerRecord,
): Promise<CandidateLedgerRecordV1> {
  const ledgerPath = archivePaths(stateDir).ledger;
  const lock = ledgerLocks.get(ledgerPath) ?? new Mutex();
  ledgerLocks.set(ledgerPath, lock);
  return lock.runExclusive(async () => {
    const run = readRunRecord(stateDir, record.candidateId);
    if (run.status !== "sealed") {
      throw new Error(`Cannot add active candidate ${record.candidateId} to the terminal ledger`);
    }
    if (
      run.parentCandidateId !== record.parentCandidateId ||
      run.terminalStatus !== record.terminalStatus
    ) {
      throw new Error(`Ledger record for ${record.candidateId} does not match its sealed run`);
    }
    const existing = readLedger(stateDir);
    if (existing.some((item) => item.candidateId === record.candidateId)) {
      throw new Error(`Ledger already contains candidate ${record.candidateId}`);
    }
    const canonical: CandidateLedgerRecordV1 = {
      ...record,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      runPath: path.relative(stateDir, candidateRunPaths(stateDir, record.candidateId).root),
      recordedAt: record.recordedAt ?? new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(canonical)}\n`);
    return canonical;
  });
}

export function readLedger(stateDir: string): CandidateLedgerRecordV1[] {
  const ledgerPath = archivePaths(stateDir).ledger;
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8");
  if (text === "") return [];
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        const entry = JSON.parse(line) as CandidateLedgerRecordV1;
        if (entry.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
          throw new Error(`unsupported schemaVersion ${String(entry.schemaVersion)}`);
        }
        return entry;
      } catch (error) {
        throw new Error(
          `Invalid ledger record at ${ledgerPath}:${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
}

function writeImmutableJsonArtifact(
  stateDir: string,
  candidateId: string,
  artifactPath: string,
  value: unknown,
): void {
  assertCandidateRunWritable(stateDir, candidateId);
  if (fs.existsSync(artifactPath)) {
    throw new Error(`${path.basename(artifactPath)} is immutable once written`);
  }
  atomicWriteJson(artifactPath, value);
}

function writeActiveJsonArtifact(
  stateDir: string,
  candidateId: string,
  artifactPath: string,
  value: unknown,
): void {
  assertCandidateRunWritable(stateDir, candidateId);
  atomicWriteJson(artifactPath, value);
}

let atomicSequence = 0;

function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${atomicSequence++}`;
  try {
    fs.writeFileSync(tmp, value);
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function copyEditablePaths(
  sourceRoot: string,
  destinationRoot: string,
  editablePaths: string[],
  removeDestination: boolean,
): void {
  for (const editablePath of normalizeEditablePaths(editablePaths)) {
    const source = resolveWithin(sourceRoot, editablePath);
    const destination = resolveWithin(destinationRoot, editablePath);
    if (removeDestination) fs.rmSync(destination, { recursive: true, force: true });
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
  }
}

type SnapshotEntry =
  | { kind: "file"; content: Buffer; mode: number; hash: string }
  | { kind: "symlink"; target: string };

function collectEditableEntries(root: string, editablePaths: string[]): Map<string, SnapshotEntry> {
  const entries = new Map<string, SnapshotEntry>();
  for (const editablePath of normalizeEditablePaths(editablePaths)) {
    collectPath(root, editablePath, entries);
  }
  return entries;
}

function collectPath(root: string, relativePath: string, entries: Map<string, SnapshotEntry>): void {
  const absolutePath = resolveWithin(root, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    entries.set(relativePath, { kind: "symlink", target: fs.readlinkSync(absolutePath) });
    return;
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(absolutePath);
    entries.set(relativePath, {
      kind: "file",
      content,
      mode: stat.mode & 0o777,
      hash: createHash("sha256").update(content).digest("hex"),
    });
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(absolutePath).sort()) {
    collectPath(root, path.posix.join(relativePath, name), entries);
  }
}

function entriesEqual(left: SnapshotEntry | undefined, right: SnapshotEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "symlink" && right.kind === "symlink") return left.target === right.target;
  return (
    left.kind === "file" &&
    right.kind === "file" &&
    left.mode === right.mode &&
    left.hash === right.hash
  );
}

function renderEntryDiff(
  name: string,
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined,
): string {
  const oldLabel = before === undefined ? "/dev/null" : `a/${name}`;
  const newLabel = after === undefined ? "/dev/null" : `b/${name}`;
  const header = [`diff --git a/${name} b/${name}`, `--- ${oldLabel}`, `+++ ${newLabel}`];

  if (before?.kind === "symlink" || after?.kind === "symlink") {
    const oldTarget = before?.kind === "symlink" ? before.target : "<not a symlink>";
    const newTarget = after?.kind === "symlink" ? after.target : "<not a symlink>";
    return [...header, "@@ symlink @@", `-${oldTarget}`, `+${newTarget}`].join("\n");
  }

  const oldContent = before?.kind === "file" ? before.content : Buffer.alloc(0);
  const newContent = after?.kind === "file" ? after.content : Buffer.alloc(0);
  if (!isText(oldContent) || !isText(newContent)) {
    const oldHash = before?.kind === "file" ? before.hash : "absent";
    const newHash = after?.kind === "file" ? after.hash : "absent";
    return [...header, `Binary files differ (sha256 ${oldHash} -> ${newHash})`].join("\n");
  }

  const oldLines = splitLines(oldContent.toString("utf8"));
  const newLines = splitLines(newContent.toString("utf8"));
  const modeLines =
    before?.kind === "file" && after?.kind === "file" && before.mode !== after.mode
      ? [`old mode ${before.mode.toString(8)}`, `new mode ${after.mode.toString(8)}`]
      : [];
  return [
    header[0]!,
    ...modeLines,
    header[1]!,
    header[2]!,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function isText(content: Buffer): boolean {
  return !content.includes(0);
}

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeEditablePaths(editablePaths: string[]): string[] {
  const normalized = editablePaths.map((editablePath) => {
    if (typeof editablePath !== "string" || editablePath.trim() === "") {
      throw new Error("Editable paths must be non-empty relative paths");
    }
    const portable = editablePath.replaceAll("\\", "/").replace(/\/+$/, "");
    if (
      portable === "" ||
      portable === "." ||
      path.posix.isAbsolute(portable) ||
      portable === ".." ||
      portable.startsWith("../") ||
      portable.split("/").includes("..")
    ) {
      throw new Error(`Editable path must remain inside the repository: ${editablePath}`);
    }
    return path.posix.normalize(portable);
  });
  return [...new Set(normalized)].sort();
}

function assertSafeCopyRoots(sourceRoot: string, destinationRoot: string, operation: string): void {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (source === destination) {
    throw new Error(`Source and destination roots must differ for ${operation}`);
  }
  if (destination === path.parse(destination).root) {
    throw new Error(`Refusing to use a filesystem root as the ${operation} destination`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, relativePath);
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Path escapes root ${root}: ${relativePath}`);
  }
  return resolved;
}

function resolveRunArtifact(runRoot: string, artifact: string): string {
  const resolved = path.isAbsolute(artifact) ? path.resolve(artifact) : path.resolve(runRoot, artifact);
  const absoluteRoot = path.resolve(runRoot);
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Required artifact is outside candidate run: ${artifact}`);
  }
  return resolved;
}

function assertCandidateId(candidateId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId)) {
    throw new Error(`Invalid candidate ID: ${candidateId}`);
  }
}

function assertMatchingCandidate(expected: string, actual: string, artifact: string): void {
  if (actual !== expected) {
    throw new Error(`${artifact} candidate ID mismatch: expected ${expected}, got ${actual}`);
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
