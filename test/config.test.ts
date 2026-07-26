import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_SETUP_MODEL, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("merges partial execution settings with phase-specific defaults", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        execution: { benchmarkTimeoutMs: 123_456 },
      }),
    );

    const config = loadConfig(stateDir);

    expect(config.execution.setupTimeoutMs).toBe(DEFAULT_CONFIG.execution.setupTimeoutMs);
    expect(config.execution.verifyTimeoutMs).toBe(DEFAULT_CONFIG.execution.verifyTimeoutMs);
    expect(config.execution.benchmarkTimeoutMs).toBe(123_456);
    expect(config.resilience).toEqual(DEFAULT_CONFIG.resilience);
    expect(config.metaHarness).toEqual(DEFAULT_CONFIG.metaHarness);
    expect(config.mockLoopDelayMs).toBe(0);
  });

  it("deep-merges partial role settings with the bounded profile defaults", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        roles: {
          professor: { model: "custom/professor" },
          advisor: { model: "custom/advisor", thinking: "high" },
        },
      }),
    );

    const config = loadConfig(stateDir);

    expect(config.roles.professor).toEqual({
      ...DEFAULT_CONFIG.roles.professor,
      model: "custom/professor",
    });
    expect(config.roles.advisor).toEqual({
      ...DEFAULT_CONFIG.roles.advisor,
      model: "custom/advisor",
      thinking: "high",
    });
    expect(config.roles.setup.model).toBe(DEFAULT_SETUP_MODEL);
    expect(config.roles.phd).toEqual(DEFAULT_CONFIG.roles.phd);
  });

  it("migrates the former Setup default to GPT-5.6 Sol without changing PhD", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        roles: {
          setup: {
            model: "anthropic/claude-sonnet-5",
            thinking: "medium",
          },
          phd: {
            model: "anthropic/claude-sonnet-5",
            thinking: "medium",
          },
        },
      }),
    );

    const config = loadConfig(stateDir);

    expect(config.roles.setup.model).toBe(DEFAULT_SETUP_MODEL);
    expect(config.roles.setup.thinking).toBe("medium");
    expect(config.roles.phd.model).toBe("anthropic/claude-sonnet-5");
  });

  it("preserves a custom Setup model", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        roles: {
          setup: {
            model: "custom/setup-model",
          },
        },
      }),
    );

    expect(loadConfig(stateDir).roles.setup.model).toBe("custom/setup-model");
  });

  it("deep-merges partial resilience settings with overnight-safe defaults", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        version: 1,
        resilience: {
          submitMaxAttempts: 7,
          loopFailureBaseDelayMs: 123,
        },
      }),
    );

    expect(loadConfig(stateDir).resilience).toEqual({
      ...DEFAULT_CONFIG.resilience,
      submitMaxAttempts: 7,
      loopFailureBaseDelayMs: 123,
    });
  });

  it("migrates the legacy God threshold to the church threshold", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-config-"));
    dirs.push(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ version: 1, godTriggerThreshold: 7 }),
    );

    const config = loadConfig(stateDir);

    expect(config.churchTriggerThreshold).toBe(7);
    expect(config).not.toHaveProperty("godTriggerThreshold");
  });
});
