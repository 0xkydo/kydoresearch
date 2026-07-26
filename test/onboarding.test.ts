import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readManifest } from "../src/challenge/detect.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  completeInitializationReport,
  createInitializationReport,
  failInitializationReport,
  loadInitializationReport,
  saveInitializationReport,
  updateInitializationStep,
} from "../src/initialization.ts";
import {
  activeProfileRoles,
  onboardingCheckpointMatches,
  renderSetupPlan,
  saveOnboardingCheckpoint,
  validateActiveProfiles,
} from "../extensions/autoresearch/onboarding.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("first-run onboarding contracts", () => {
  it("describes only active profiles and validates their effective files and models", () => {
    const challenge = makeTmpChallenge();
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.runner = "subprocess";
      config.advisor.enabled = false;
      config.churchTriggerThreshold = 0;
      config.metaHarness.enabled = false;
      expect(activeProfileRoles(config)).toEqual(["setup", "professor", "phd"]);

      const models = new Set(
        activeProfileRoles(config).map((role) => config.roles[role].model),
      );
      expect(validateActiveProfiles(challenge.repoRoot, config, models)).toEqual([]);

      models.delete(config.roles.professor.model);
      expect(validateActiveProfiles(challenge.repoRoot, config, models)).toEqual([
        expect.stringMatching(/Professor.*unavailable.*\/login/),
      ]);
    } finally {
      challenge.cleanup();
    }
  });

  it("checkpoints the reviewed manifest and config and invalidates either change", () => {
    const challenge = makeTmpChallenge();
    try {
      const stateDir = path.join(challenge.repoRoot, ".autoresearch");
      const manifest = readManifest(challenge.repoRoot);
      const config = structuredClone(DEFAULT_CONFIG);
      expect(onboardingCheckpointMatches(stateDir, manifest, config)).toBe(false);
      saveOnboardingCheckpoint(stateDir, manifest, config);
      expect(onboardingCheckpointMatches(stateDir, manifest, config)).toBe(true);

      config.maxLoops = 3;
      expect(onboardingCheckpointMatches(stateDir, manifest, config)).toBe(false);
      expect(renderSetupPlan(manifest, config)).toContain(
        `2. Install dependencies: ${manifest.setupCommand}`,
      );
      expect(renderSetupPlan(manifest, config)).toContain(
        "The dependency command may modify this checkout.",
      );
    } finally {
      challenge.cleanup();
    }
  });
});

describe("durable initialization presentation", () => {
  it("persists checklist progress, precise failure, and readiness evidence", () => {
    const challenge = makeTmpChallenge();
    try {
      const stateDir = path.join(challenge.repoRoot, ".autoresearch");
      let report = createInitializationReport("fixture");
      report = updateInitializationStep(
        report,
        {
          id: "setup",
          status: "running",
          command: "./setup.sh",
          logPath: ".autoresearch/logs/setup.log",
        },
        "dependency setup started",
      );
      report = failInitializationReport(report, {
        code: "setup-command-failed",
        step: "setup",
        title: "Dependency setup failed",
        reason: "compiler was not found",
        action: "Install the compiler, then retry.",
        evidencePath: ".autoresearch/logs/setup.log",
        retryable: true,
        resumesFromCheckpoint: false,
      });
      saveInitializationReport(stateDir, report);
      expect(loadInitializationReport(stateDir)).toMatchObject({
        status: "failed",
        diagnostic: { code: "setup-command-failed" },
      });

      report = completeInitializationReport(report, {
        readiness: "ready-with-limitations",
        baselineScore: 12,
        direction: "-",
        verifyCommand: "./verify.sh",
        benchCommand: "./benchmark.sh",
        localEvaluation: {
          fidelity: "reduced",
          decision: "Use the documented local mode.",
          limitations: ["Official hardware path is not exercised."],
          officialValidationRequired: true,
        },
        submissionReady: true,
        evidencePath: ".autoresearch/runs/baseline",
      });
      saveInitializationReport(stateDir, report);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(stateDir, "loops", "init", "status.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        status: "ready-with-limitations",
        summary: {
          baselineScore: 12,
          verifyCommand: "./verify.sh",
        },
      });
    } finally {
      challenge.cleanup();
    }
  });
});
