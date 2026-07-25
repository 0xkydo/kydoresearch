import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkManifest } from "./types.ts";

const KNOWN_CLIS = [
  { command: "ecdsafail", identity: /(?:ecdsa[\s-]*fail|ecadd)/i },
  { command: "mlxfast", identity: /mlx[\s-]*fast/i },
] as const;

/** Read and validate benchmark.json at the repo root. */
export function readManifest(repoRoot: string): BenchmarkManifest {
  const manifestPath = path.join(repoRoot, "benchmark.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No benchmark.json found in ${repoRoot}. ` +
        "cd into a cloned Yukon challenge repo, then retry /autoresearch.",
    );
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("benchmark.json must contain a JSON object");
  }

  const name = requiredString(parsed, "name");
  const setupCommand = normalizeCommand(parsed.setupCommand, "setupCommand");
  const benchmarkCommand = normalizeCommand(parsed.benchmarkCommand, "benchmarkCommand");
  const scorePath = requiredString(parsed, "scorePath");
  if (parsed.direction !== "+" && parsed.direction !== "-") {
    throw new Error(`benchmark.json direction must be "+" or "-", got ${JSON.stringify(parsed.direction)}`);
  }
  if (
    !Array.isArray(parsed.editablePaths) ||
    parsed.editablePaths.length === 0 ||
    !parsed.editablePaths.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new Error("benchmark.json editablePaths must be a non-empty array of paths");
  }

  const description =
    parsed.description === undefined ? undefined : requiredString(parsed, "description");
  const preSubmitCommand =
    parsed.preSubmitCommand === undefined
      ? undefined
      : normalizeCommand(parsed.preSubmitCommand, "preSubmitCommand");

  return {
    name,
    ...(description ? { description } : {}),
    setupCommand,
    benchmarkCommand,
    scorePath,
    direction: parsed.direction,
    editablePaths: parsed.editablePaths,
    ...(preSubmitCommand ? { preSubmitCommand } : {}),
  };
}

/**
 * Infer the challenge CLI command. Yukon challenge names are not always the
 * CLI brand (the ecdsafail checkout is named "ecadd-challenge-test"), so known
 * identity aliases are matched before falling back to a repo-local executable.
 */
export function detectCli(repoRoot: string, manifest: BenchmarkManifest): string | null {
  const identity = `${manifest.name}\n${manifest.description ?? ""}`;
  for (const cli of KNOWN_CLIS) {
    if (cli.identity.test(identity)) return cli.command;
  }
  const binDir = path.join(repoRoot, "bin");
  if (fs.existsSync(binDir)) {
    const candidates = fs
      .readdirSync(binDir)
      .filter((f) => {
        try {
          fs.accessSync(path.join(binDir, f), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
    const first = candidates[0];
    if (first) return `./bin/${first}`;
  }
  return null;
}

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (value === undefined) throw new Error(`benchmark.json missing required key "${key}"`);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`benchmark.json "${key}" must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Yukon schema v1 permits either a shell command string or an argv array.
 * Internally the harness stores shell strings, so arrays are serialized with
 * POSIX-safe argument quoting before they reach shellExec.
 */
function normalizeCommand(value: unknown, key: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string") &&
    value[0]!.trim() !== ""
  ) {
    return value.map(shellQuote).join(" ");
  }
  if (value === undefined) throw new Error(`benchmark.json missing required key "${key}"`);
  throw new Error(`benchmark.json "${key}" must be a command string or non-empty argv array`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a path is inside any editablePaths entry. */
export function isInsideEditablePaths(relPath: string, editablePaths: string[]): boolean {
  const normalize = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const normalized = normalize(relPath);
  return editablePaths.some((ep) => {
    const root = normalize(ep);
    if (root === "" || root === ".") return true; // whole repo editable
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}
