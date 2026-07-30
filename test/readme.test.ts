import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

function objectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    objectKeys(child, keys);
  }
  return keys;
}

describe("README contract", () => {
  it("documents the installed-package ecdsafail quickstart", () => {
    expect(readme).toMatch(/^## Quickstart: ecdsafail$/m);
    expect(readme).toContain("pi install git:github.com/0xkydo/kydoresearch");
    expect(readme).toContain("/autoresearch config");
    expect(readme).toContain('"runner": "subprocess"');
    expect(readme).toContain("/autoresearch status");
    expect(readme).toContain(".autoresearch/logs/");
  });

  it("keeps every persisted configuration field in the config example", () => {
    const configBlock = readme.match(
      /^## Configuration — `.autoresearch\/config\.json`$[\s\S]*?```jsonc\n([\s\S]*?)```/m,
    )?.[1];
    expect(configBlock).toBeDefined();

    for (const key of objectKeys(DEFAULT_CONFIG)) {
      expect(configBlock, `README config example is missing ${key}`).toContain(`"${key}"`);
    }
    for (const optionalKey of ["soul", "prompt", "tools", "submitModelName"]) {
      expect(configBlock, `README config example is missing ${optionalKey}`).toContain(
        `"${optionalKey}"`,
      );
    }
  });

  it("provides recovery guidance for common first-run failures", () => {
    expect(readme).toMatch(/^## Troubleshooting$/m);
    for (const phrase of [
      "Pi 0.75.0",
      "benchmark.json",
      "setup",
      "benchmark",
      "git repository",
      "pi update",
    ]) {
      expect(readme).toContain(phrase);
    }
  });

  it("documents guided profile review and durable setup feedback", () => {
    expect(readme).toContain("guided profile review");
    expect(readme).toContain("Start Research");
    expect(readme).toContain("Stay Ready");
    expect(readme).toContain(".autoresearch/loops/init/status.json");
    expect(readme).toContain("pending, running, retrying, passed, or failed");
  });

  it("documents the optional catastrophic-failure supervisor and its limits", () => {
    for (const phrase of [
      "pi-kydo",
      ".autoresearch/oncall/incidents/",
      "two matching high-confidence",
      "gpt-5.6-sol",
      "--max-restarts",
      "--no-repair",
      "not a security sandbox",
    ]) {
      expect(readme).toContain(phrase);
    }
  });
});
