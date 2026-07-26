import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullSuiteReference,
  SelectionReceipt,
  TestImpactMapV1,
  TestTier,
} from "../src/test-system/contracts.ts";
import {
  isTestTier,
  validateImpactMap,
} from "../src/test-system/contracts.ts";
import { selectTests } from "../src/test-system/selector.ts";

interface CliOptions {
  mode: "phase" | "related" | "full";
  explicitIntent?: string;
  tier?: TestTier;
  explain: boolean;
  json: boolean;
  kernelOnly: boolean;
  changedFiles: string[];
  base?: string;
  receiptPath?: string;
}

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const options = parseArgs(process.argv.slice(2));
const impactMap = loadImpactMap();
validateTestInventory(impactMap);
const commit = git(["rev-parse", "HEAD"]).trim();
const changedFiles = options.kernelOnly
  ? []
  : options.changedFiles.length > 0
  ? options.changedFiles
  : discoverChangedFiles(options.base);
const receipt = selectTests({
  impactMap,
  mode: options.mode,
  changedFiles,
  ...(options.explicitIntent ? { explicitIntent: options.explicitIntent } : {}),
  ...(options.tier ? { tier: options.tier } : {}),
  dependencyMatches: buildDependencyMatches(impactMap),
  commit,
  latestSuccessfulFullSuite: loadLatestFullSuite(),
});

emitReceipt(receipt, options.json);
if (options.receiptPath) writeReceipt(options.receiptPath, receipt);
if (options.explain) process.exit(0);

const selectedFiles = receipt.selectedTests.map((test) => test.file);
if (selectedFiles.length === 0) {
  throw new Error("The selector produced no tests; refusing to continue");
}
const startedAtIso = new Date().toISOString();
const startedAt = Date.now();
const resultFile = path.join(
  repoRoot,
  "node_modules",
  ".cache",
  "kydoresearch-test",
  `vitest-${process.pid}-${Date.now()}.json`,
);
fs.mkdirSync(path.dirname(resultFile), { recursive: true });
const result = spawnSync(
  path.join(repoRoot, "node_modules", ".bin", "vitest"),
  [
    "--run",
    ...selectedFiles,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${resultFile}`,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      KYDO_TEST_SELECTION_RECEIPT: options.receiptPath ?? "",
    },
  },
);
const durationMs = Date.now() - startedAt;
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const suiteDurations = readSuiteDurations(resultFile);
fs.rmSync(resultFile, { force: true });
receipt.execution = {
  startedAt: startedAtIso,
  completedAt: new Date().toISOString(),
  durationMs,
  suiteDurations,
};
if (options.receiptPath) writeReceipt(options.receiptPath, receipt);
emitExecutionReceipt(receipt);
if (receipt.fullSuiteRequired || options.mode === "full") {
  saveLatestFullSuite({
    commit,
    completedAt: receipt.execution.completedAt,
    durationMs,
    suiteDurations,
  });
}

function parseArgs(args: string[]): CliOptions {
  let mode: CliOptions["mode"] = "related";
  let explicitIntent: string | undefined;
  let tier: TestTier | undefined;
  let explain = false;
  let json = false;
  let kernelOnly = false;
  let base: string | undefined;
  let receiptPath: string | undefined;
  const changedFiles: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    switch (arg) {
      case "--mode":
        mode = requiredValue(args, ++index, "--mode") as CliOptions["mode"];
        if (!["phase", "related", "full"].includes(mode)) {
          throw new Error(`Invalid --mode ${mode}`);
        }
        break;
      case "--phase":
        explicitIntent = requiredValue(args, ++index, "--phase");
        break;
      case "--tier": {
        const value = requiredValue(args, ++index, "--tier");
        if (!isTestTier(value)) throw new Error(`Invalid --tier ${value}`);
        tier = value;
        break;
      }
      case "--changed":
        changedFiles.push(requiredValue(args, ++index, "--changed"));
        break;
      case "--base":
        base = requiredValue(args, ++index, "--base");
        break;
      case "--receipt":
        receiptPath = requiredValue(args, ++index, "--receipt");
        break;
      case "--explain":
      case "--dry-run":
        explain = true;
        break;
      case "--json":
        json = true;
        break;
      case "--kernel":
        kernelOnly = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (mode === "phase") {
    explicitIntent = explicitIntent ?? positional[0];
    if (!explicitIntent) {
      throw new Error("Phase mode requires a phase or segment, for example: setup");
    }
  } else if (positional.length > 0) {
    throw new Error(`Unexpected positional argument ${positional[0]}`);
  }
  return {
    mode,
    ...(explicitIntent ? { explicitIntent } : {}),
    ...(tier ? { tier } : {}),
    explain,
    json,
    kernelOnly,
    changedFiles,
    ...(base ? { base } : {}),
    ...(receiptPath ? { receiptPath } : {}),
  };
}

function loadImpactMap(): TestImpactMapV1 {
  const file = path.join(repoRoot, "test", "impact-map.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${file}: ${errorMessage(error)}`);
  }
  return validateImpactMap(parsed);
}

function validateTestInventory(map: TestImpactMapV1): void {
  const trackedTests = listTestFiles(path.join(repoRoot, "test"))
    .map((file) => normalizePath(path.relative(repoRoot, file)))
    .sort();
  const configured = new Set(map.suites.map((suite) => suite.file));
  const missing = map.suites
    .map((suite) => suite.file)
    .filter((file) => !trackedTests.includes(file));
  const unmapped = trackedTests.filter((file) => !configured.has(file));
  if (missing.length > 0 || unmapped.length > 0) {
    throw new Error(
      "Impact-map inventory is invalid" +
        (missing.length > 0 ? `; configured files missing: ${missing.join(", ")}` : "") +
        (unmapped.length > 0 ? `; unmapped tests: ${unmapped.join(", ")}` : ""),
    );
  }
  const focused = trackedTests.filter((file) =>
    /(?:describe|it|test)\s*\.\s*only\s*\(/.test(
      fs.readFileSync(path.join(repoRoot, file), "utf8"),
    )
  );
  if (focused.length > 0) {
    throw new Error(`Focused tests are forbidden: ${focused.join(", ")}`);
  }
  const goldenRoot = path.join(repoRoot, "test", "ui", "goldens");
  if (fs.existsSync(goldenRoot)) {
    const malformed = listFiles(goldenRoot, ".json").filter((file) => {
      try {
        JSON.parse(fs.readFileSync(file, "utf8"));
        return false;
      } catch {
        return true;
      }
    });
    if (malformed.length > 0) {
      throw new Error(
        "Malformed tracked UI goldens: " +
          malformed
            .map((file) => normalizePath(path.relative(repoRoot, file)))
            .join(", "),
      );
    }
  }
}

function listTestFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listTestFiles(resolved));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) result.push(resolved);
  }
  return result;
}

function listFiles(directory: string, suffix: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(resolved, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(resolved);
  }
  return result;
}

function discoverChangedFiles(base?: string): string[] {
  const diffRange = base ? [`${base}...HEAD`] : ["HEAD"];
  const changed = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    ...diffRange,
  ])
    .split("\n")
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean);
  return [...new Set([...changed, ...untracked].map(normalizePath))].sort();
}

function buildDependencyMatches(map: TestImpactMapV1): Record<string, string[]> {
  const cache = new Map<string, Set<string>>();
  const dependencies: Record<string, string[]> = {};
  for (const suite of map.suites) {
    const absolute = path.join(repoRoot, suite.file);
    if (!fs.existsSync(absolute)) continue;
    dependencies[suite.file] = [...collectDependencies(absolute, cache)]
      .map((file) => normalizePath(path.relative(repoRoot, file)))
      .sort();
  }
  return dependencies;
}

function collectDependencies(
  file: string,
  cache: Map<string, Set<string>>,
  active = new Set<string>(),
): Set<string> {
  const cached = cache.get(file);
  if (cached) return cached;
  if (active.has(file)) return new Set();
  active.add(file);
  const result = new Set<string>();
  const source = fs.readFileSync(file, "utf8");
  const expression =
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(expression)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith(".")) continue;
    const resolved = resolveLocalImport(file, specifier);
    if (!resolved) continue;
    result.add(resolved);
    for (const dependency of collectDependencies(resolved, cache, active)) {
      result.add(dependency);
    }
  }
  active.delete(file);
  cache.set(file, result);
  return result;
}

function resolveLocalImport(importer: string, specifier: string): string | undefined {
  const candidate = path.resolve(path.dirname(importer), specifier);
  for (const resolved of [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    path.join(candidate, "index.ts"),
  ]) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return undefined;
}

function emitReceipt(receipt: SelectionReceipt, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  const lines = [
    "TEST SELECTION RECEIPT",
    `mode: ${receipt.mode}${receipt.explicitIntent ? ` (${receipt.explicitIntent})` : ""}`,
    `commit: ${receipt.commit}`,
    `changed files: ${receipt.changedFiles.length}`,
    ...receipt.changedFiles.map((file) => `  - ${file}`),
    `selected tests: ${receipt.selectedTests.length}`,
    ...receipt.selectedTests.map(
      (test) =>
        `  - ${test.file} · ` +
        test.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join("; "),
    ),
    `skipped suites: ${receipt.skippedSuites.length}`,
    ...receipt.skippedSuites.map((file) => `  - ${file}`),
    `full-suite escalation: ${receipt.fullSuiteRequired ? "yes" : "no"}`,
    ...receipt.escalations.map((reason) => `  - ${reason}`),
    receipt.latestSuccessfulFullSuite
      ? `latest successful full suite: ${receipt.latestSuccessfulFullSuite.commit} · ` +
        `${receipt.latestSuccessfulFullSuite.completedAt} · ` +
        `${receipt.latestSuccessfulFullSuite.durationMs}ms`
      : "latest successful full suite: unknown",
    `full-suite freshness: ${receipt.fullSuiteStatus.freshness} ` +
      `(maximum age ${Math.round(receipt.fullSuiteStatus.maxAgeMs / 3_600_000)}h)`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeReceipt(receiptPath: string, receipt: SelectionReceipt): void {
  const resolved = path.resolve(repoRoot, receiptPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`);
}

function fullSuiteReferencePath(): string {
  return path.join(
    repoRoot,
    "node_modules",
    ".cache",
    "kydoresearch-test",
    "full-suite.json",
  );
}

function loadLatestFullSuite(): FullSuiteReference | undefined {
  const file = fullSuiteReferencePath();
  if (!fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FullSuiteReference>;
    if (
      typeof value.commit === "string" &&
      typeof value.completedAt === "string" &&
      typeof value.durationMs === "number"
    ) {
      return {
        commit: value.commit,
        completedAt: value.completedAt,
        durationMs: value.durationMs,
        ...(value.suiteDurations &&
        typeof value.suiteDurations === "object" &&
        !Array.isArray(value.suiteDurations)
          ? { suiteDurations: value.suiteDurations }
          : {}),
      };
    }
  } catch {
    // A malformed local cache is non-authoritative; the receipt reports unknown.
  }
  return undefined;
}

function saveLatestFullSuite(reference: FullSuiteReference): void {
  const file = fullSuiteReferencePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(reference, null, 2)}\n`);
}

function readSuiteDurations(file: string): Record<string, number> {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
      testResults?: Array<{
        name?: string;
        startTime?: number;
        endTime?: number;
      }>;
    };
    return Object.fromEntries(
      (report.testResults ?? [])
        .filter(
          (suite) =>
            typeof suite.name === "string" &&
            typeof suite.startTime === "number" &&
            typeof suite.endTime === "number",
        )
        .map(
          (suite): [string, number] => [
            normalizePath(path.relative(repoRoot, suite.name!)),
            Math.max(0, suite.endTime! - suite.startTime!),
          ],
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  } catch {
    return {};
  }
}

function emitExecutionReceipt(receipt: SelectionReceipt): void {
  if (!receipt.execution) return;
  const slowest = Object.entries(receipt.execution.suiteDurations)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);
  process.stdout.write(
    [
      "TEST RUN RECEIPT",
      `result: passed`,
      `duration: ${receipt.execution.durationMs}ms`,
      "slowest selected suites:",
      ...slowest.map(([file, duration]) => `  - ${file}: ${Math.round(duration)}ms`),
    ].join("\n") + "\n",
  );
}

function git(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
