import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExecPort } from "./exec.ts";

export interface CandidateIntegrityAuditOptions {
  /** The user's main challenge checkout, used as the source of seeded setup artifacts. */
  repoRoot: string;
  /** The detached candidate worktree to inspect. */
  candidateWorktree: string;
  /** The complete set of repository-relative paths the candidate may edit. */
  editablePaths: readonly string[];
  exec: ExecPort;
}

export type IntegrityViolationReason = "outside-editable-path" | "seed-artifact-mismatch";

export interface IntegrityViolation {
  path: string;
  /** One or more two-character Git porcelain status codes. */
  status: string;
  reason: IntegrityViolationReason;
}

export interface CandidateIntegrityAudit {
  /** All tracked and untracked paths changed in the candidate, sorted and de-duplicated. */
  changedPaths: string[];
  /** Changed paths permitted by the editable surface or seeded-artifact exception. */
  allowedPaths: string[];
  violations: IntegrityViolation[];
  ok: boolean;
}

interface StatusEntry {
  path: string;
  status: string;
}

const STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignore-submodules=none",
] as const;

/**
 * Deterministically audit a candidate before running any evaluator.
 *
 * Tracked or untracked changes are allowed beneath editablePaths. Outside
 * that surface, only an untracked path copied unchanged from an untracked
 * path in the main checkout is allowed.
 */
export async function auditCandidateIntegrity(
  options: CandidateIntegrityAuditOptions,
): Promise<CandidateIntegrityAudit> {
  const repoRoot = path.resolve(options.repoRoot);
  const candidateWorktree = path.resolve(options.candidateWorktree);
  const editablePaths = normalizeEditablePaths(candidateWorktree, options.editablePaths);

  const [candidateEntries, repoEntries] = await Promise.all([
    readStatus(options.exec, candidateWorktree, "candidate worktree"),
    readStatus(options.exec, repoRoot, "main repository"),
  ]);

  const candidateStatuses = collectStatuses(candidateWorktree, candidateEntries);
  const repoStatuses = collectStatuses(repoRoot, repoEntries);
  const changedPaths = [...candidateStatuses.keys()].sort(comparePaths);
  const allowedPaths: string[] = [];
  const violations: IntegrityViolation[] = [];

  for (const changedPath of changedPaths) {
    const statuses = candidateStatuses.get(changedPath);
    if (!statuses) continue;

    if (editablePaths.some((editablePath) => isWithin(changedPath, editablePath))) {
      allowedPaths.push(changedPath);
      continue;
    }

    const isUntracked = statuses.size === 1 && statuses.has("??");
    const repoPathStatuses = repoStatuses.get(changedPath);
    const isUntrackedInRepo =
      repoPathStatuses !== undefined && repoPathStatuses.size === 1 && repoPathStatuses.has("??");

    if (isUntracked && isUntrackedInRepo) {
      const candidatePath = resolveRelativePath(candidateWorktree, changedPath, "Git status path");
      const repoPath = resolveRelativePath(repoRoot, changedPath, "Git status path");
      if (await nodesMatch(candidatePath, repoPath)) {
        allowedPaths.push(changedPath);
        continue;
      }
      violations.push({
        path: changedPath,
        status: formatStatuses(statuses),
        reason: "seed-artifact-mismatch",
      });
      continue;
    }

    violations.push({
      path: changedPath,
      status: formatStatuses(statuses),
      reason: "outside-editable-path",
    });
  }

  return {
    changedPaths,
    allowedPaths,
    violations,
    ok: violations.length === 0,
  };
}

function normalizeEditablePaths(root: string, editablePaths: readonly string[]): string[] {
  const normalized = editablePaths.map((editablePath) => {
    if (
      editablePath.trim() === "" ||
      editablePath.includes("\0") ||
      path.isAbsolute(editablePath)
    ) {
      throw new Error(`Editable path must be non-empty and relative: ${JSON.stringify(editablePath)}`);
    }
    return relativePathWithin(root, editablePath, "Editable path");
  });
  return [...new Set(normalized)].sort(comparePaths);
}

async function readStatus(exec: ExecPort, cwd: string, label: string): Promise<StatusEntry[]> {
  const result = await exec("git", [...STATUS_ARGS], { cwd });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Unable to inspect ${label} Git status: ${detail}`);
  }
  return parsePorcelainV1Z(result.stdout);
}

function parsePorcelainV1Z(output: string): StatusEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length < 4 || field[2] !== " ") {
      throw new Error("Malformed NUL-delimited Git status output");
    }

    const status = field.slice(0, 2);
    const changedPath = field.slice(3);
    entries.push({ path: changedPath, status });

    if (status.includes("R") || status.includes("C")) {
      const originalPath = fields[index + 1];
      if (originalPath === undefined || originalPath === "") {
        throw new Error("Malformed Git rename/copy status output");
      }
      entries.push({ path: originalPath, status });
      index += 1;
    }
  }
  return entries;
}

function collectStatuses(root: string, entries: readonly StatusEntry[]): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const entry of entries) {
    const normalizedPath = relativePathWithin(root, entry.path, "Git status path");
    const statuses = byPath.get(normalizedPath) ?? new Set<string>();
    statuses.add(entry.status);
    byPath.set(normalizedPath, statuses);
  }
  return byPath;
}

function relativePathWithin(root: string, relativePath: string, label: string): string {
  const resolved = resolveRelativePath(root, relativePath, label);
  const normalized = path.relative(root, resolved);
  if (normalized === "") {
    throw new Error(`${label} must identify a path below the repository root: ${JSON.stringify(relativePath)}`);
  }
  return normalized.split(path.sep).join("/");
}

function resolveRelativePath(root: string, relativePath: string, label: string): string {
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative and in bounds: ${JSON.stringify(relativePath)}`);
  }
  const resolved = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the repository root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

function isWithin(changedPath: string, editablePath: string): boolean {
  return changedPath === editablePath || changedPath.startsWith(`${editablePath}/`);
}

function formatStatuses(statuses: ReadonlySet<string>): string {
  return [...statuses].sort().join(",");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function nodesMatch(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([safeLstat(leftPath), safeLstat(rightPath)]);
  if (!left || !right || nodeType(left) !== nodeType(right)) return false;

  if (left.isFile() && right.isFile()) {
    if (left.size !== right.size) return false;
    const [leftContents, rightContents] = await Promise.all([
      fs.readFile(leftPath),
      fs.readFile(rightPath),
    ]);
    return leftContents.equals(rightContents);
  }

  if (left.isSymbolicLink() && right.isSymbolicLink()) {
    const [leftTarget, rightTarget] = await Promise.all([
      fs.readlink(leftPath),
      fs.readlink(rightPath),
    ]);
    return leftTarget === rightTarget;
  }

  if (left.isDirectory() && right.isDirectory()) {
    const [leftEntries, rightEntries] = await Promise.all([
      fs.readdir(leftPath),
      fs.readdir(rightPath),
    ]);
    leftEntries.sort(comparePaths);
    rightEntries.sort(comparePaths);
    if (
      leftEntries.length !== rightEntries.length ||
      leftEntries.some((entry, index) => entry !== rightEntries[index])
    ) {
      return false;
    }
    for (const entry of leftEntries) {
      if (!(await nodesMatch(path.join(leftPath, entry), path.join(rightPath, entry)))) return false;
    }
    return true;
  }

  // Sockets, devices, and FIFOs are never accepted as portable setup artifacts.
  return false;
}

async function safeLstat(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function nodeType(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}
