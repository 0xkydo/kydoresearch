import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkManifest } from "./types.ts";

const KNOWN_CLIS = ["ecdsafail", "mlxfast"];

/** Read and validate benchmark.json at the repo root. */
export function readManifest(repoRoot: string): BenchmarkManifest {
  const manifestPath = path.join(repoRoot, "benchmark.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `No benchmark.json found in ${repoRoot}. /autoresearch must run inside a cloned yukon challenge repo.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<BenchmarkManifest>;
  for (const key of ["name", "setupCommand", "benchmarkCommand", "scorePath", "direction", "editablePaths"] as const) {
    if (raw[key] === undefined) throw new Error(`benchmark.json missing required key "${key}"`);
  }
  if (raw.direction !== "+" && raw.direction !== "-") {
    throw new Error(`benchmark.json direction must be "+" or "-", got ${JSON.stringify(raw.direction)}`);
  }
  if (!Array.isArray(raw.editablePaths) || raw.editablePaths.length === 0) {
    throw new Error("benchmark.json editablePaths must be a non-empty array");
  }
  return raw as BenchmarkManifest;
}

/**
 * Infer the challenge CLI command. Known branded CLIs are matched by manifest
 * name; otherwise fall back to a repo-local ./bin/<something> (the fixture's
 * mockchal), or null when no CLI is available (submit disabled).
 */
export function detectCli(repoRoot: string, manifest: BenchmarkManifest): string | null {
  for (const cli of KNOWN_CLIS) {
    if (manifest.name.toLowerCase().includes(cli)) return cli;
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
      });
    const first = candidates[0];
    if (first) return `./bin/${first}`;
  }
  return null;
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
