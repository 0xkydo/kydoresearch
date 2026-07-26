import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkManifest } from "../../src/challenge/types.ts";
import type { HarnessConfig, RolesConfig } from "../../src/config.ts";
import { atomicWriteJson, readJsonIfExists } from "../../src/util.ts";

export const ONBOARDING_VERSION = 1;

export type ProfileRole = keyof RolesConfig;

export interface RoleProfileDescriptor {
  label: string;
  purpose: string;
  timing: string;
  authority: string;
}

export const ROLE_PROFILE_DESCRIPTORS: Record<
  ProfileRole,
  RoleProfileDescriptor
> = {
  setup: {
    label: "Setup",
    purpose: "Maps the challenge and chooses supported local evaluation commands.",
    timing: "Runs during first-time initialization and bounded baseline recovery.",
    authority: "May inspect the host and write setup knowledge; never optimizes candidates.",
  },
  professor: {
    label: "Professor",
    purpose: "Directs the search and proposes evidence-backed, falsifiable experiments.",
    timing: "Runs once per research loop before candidate work begins.",
    authority: "Reads evidence and proposes work; never edits candidate code.",
  },
  phd: {
    label: "PhD",
    purpose: "Implements one bounded experiment in an isolated worktree.",
    timing: "Runs for each proposed candidate and verifier repair attempt.",
    authority: "Edits declared paths and runs cheap checks; never runs the benchmark.",
  },
  advisor: {
    label: "Advisor",
    purpose: "Independently checks research quality, integrity, and watchdog rules.",
    timing: "Reviews completed loop evidence when Advisor is enabled.",
    authority: "Read-only; may raise evidence-backed concerns or blockers.",
  },
  god: {
    label: "God",
    purpose: "Provides warm, candid plateau reflection after repeated dry loops.",
    timing: "Runs only when the configured church threshold is reached.",
    authority: "Writes reflection notes; does not control search or evaluation.",
  },
  metaharness: {
    label: "Meta-harness",
    purpose: "Evolves permitted Professor, PhD, and Advisor profile artifacts.",
    timing: "Runs only during an explicitly enabled bilevel campaign.",
    authority: "Cannot change models, budgets, evaluator behavior, Setup, or God.",
  },
};

interface OnboardingCheckpointV1 {
  schemaVersion: typeof ONBOARDING_VERSION;
  fingerprint: string;
  completedAt: string;
}

export function activeProfileRoles(config: HarnessConfig): ProfileRole[] {
  const roles: ProfileRole[] = ["setup", "professor", "phd"];
  if (config.advisor.enabled) roles.push("advisor");
  if (config.churchTriggerThreshold > 0) roles.push("god");
  if (config.metaHarness.enabled) roles.push("metaharness");
  return roles;
}

export function onboardingFingerprint(
  manifest: BenchmarkManifest,
  config: HarnessConfig,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ manifest, config }))
    .digest("hex");
}

export function onboardingCheckpointMatches(
  stateDir: string,
  manifest: BenchmarkManifest,
  config: HarnessConfig,
): boolean {
  const checkpoint = readJsonIfExists<OnboardingCheckpointV1>(
    path.join(stateDir, "onboarding.json"),
  );
  return (
    checkpoint?.schemaVersion === ONBOARDING_VERSION &&
    checkpoint.fingerprint === onboardingFingerprint(manifest, config)
  );
}

export function saveOnboardingCheckpoint(
  stateDir: string,
  manifest: BenchmarkManifest,
  config: HarnessConfig,
): void {
  atomicWriteJson(path.join(stateDir, "onboarding.json"), {
    schemaVersion: ONBOARDING_VERSION,
    fingerprint: onboardingFingerprint(manifest, config),
    completedAt: new Date().toISOString(),
  } satisfies OnboardingCheckpointV1);
}

export function validateActiveProfiles(
  repoRoot: string,
  config: HarnessConfig,
  availableModels?: Set<string>,
): string[] {
  if (config.runner === "mock") return [];
  const errors: string[] = [];
  for (const role of activeProfileRoles(config)) {
    const spec = config.roles[role];
    if (availableModels && !availableModels.has(spec.model)) {
      errors.push(
        `${ROLE_PROFILE_DESCRIPTORS[role].label}: model "${spec.model}" is unavailable; configure its provider with /login or choose another model.`,
      );
    }
    const soul = resolveSoulPath(repoRoot, role, spec.soul);
    if (!isRegularFile(soul)) {
      errors.push(
        `${ROLE_PROFILE_DESCRIPTORS[role].label}: soul "${spec.soul ?? "SOUL.md"}" was not found at ${soul}.`,
      );
    }
    const prompt = resolvePromptPath(repoRoot, role, spec.prompt);
    if (!isRegularFile(prompt)) {
      errors.push(
        `${ROLE_PROFILE_DESCRIPTORS[role].label}: prompt "${spec.prompt ?? `${role}.md`}" was not found at ${prompt}.`,
      );
    }
    if (
      spec.tools !== undefined &&
      (!Array.isArray(spec.tools) ||
        !spec.tools.every((tool) => typeof tool === "string" && tool.trim()))
    ) {
      errors.push(
        `${ROLE_PROFILE_DESCRIPTORS[role].label}: tools must be a list of non-empty Pi tool names.`,
      );
    }
  }
  return errors;
}

export function renderSetupPlan(
  manifest: BenchmarkManifest,
  config: HarnessConfig,
): string {
  return [
    `1. Validate benchmark.json and the Git checkout.`,
    `2. Install dependencies: ${manifest.setupCommand}`,
    `3. Setup maps repository and local hardware evidence.`,
    `4. Select supported verification and benchmark commands.`,
    `5. Measure baseline: ${manifest.benchmarkCommand}`,
    `6. Archive ${manifest.editablePaths.join(", ")} and save ready state.`,
    "",
    `Objective: ${manifest.direction === "+" ? "higher" : "lower"} score wins`,
    `Retries: commands ${config.resilience.commandMaxAttempts} · agents ${config.resilience.agentMaxAttempts}`,
    `Logs: .autoresearch/logs/`,
    "",
    "The dependency command may modify this checkout.",
  ].join("\n");
}

function resolveSoulPath(
  repoRoot: string,
  role: ProfileRole,
  configured: string | undefined,
): string {
  const value = configured ?? "SOUL.md";
  return value.includes("/") || value.includes("\\")
    ? path.resolve(repoRoot, value)
    : path.join(import.meta.dirname, "agents", role, value);
}

function resolvePromptPath(
  repoRoot: string,
  role: ProfileRole,
  configured: string | undefined,
): string {
  const value = configured ?? `${role}.md`;
  return value.includes("/") || value.includes("\\")
    ? path.resolve(repoRoot, value)
    : path.join(import.meta.dirname, "prompts", value);
}

function isRegularFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}
