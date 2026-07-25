import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

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
    expect(config.mockLoopDelayMs).toBe(0);
  });
});
