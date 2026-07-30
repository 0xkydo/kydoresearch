import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

interface PackageManifest {
  name?: string;
  version?: string;
  keywords?: string[];
  pi?: { extensions?: string[] };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: Record<string, string>;
}

describe("pi package contract", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const lockfile = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    packages?: Record<string, { name?: string; version?: string }>;
  };

  it("advertises a loadable extension from an installed package root", () => {
    expect(manifest.keywords ?? []).toContain("pi-package");
    expect(manifest.pi?.extensions).toEqual(["./extensions/autoresearch/index.ts"]);

    for (const extension of manifest.pi?.extensions ?? []) {
      const resolved = path.resolve(repoRoot, extension);
      expect(path.relative(repoRoot, resolved)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(fs.statSync(resolved).isFile()).toBe(true);
    }
  });

  it("ships the executable catastrophic-failure supervisor", () => {
    expect(manifest.bin).toEqual({ "pi-kydo": "./bin/pi-kydo.js" });
    const executable = path.join(repoRoot, "bin", "pi-kydo.js");
    expect(fs.statSync(executable).isFile()).toBe(true);
    expect(fs.readFileSync(executable, "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
    expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
  });

  it("declares pi-provided runtime modules as optional wildcard peers", () => {
    for (const dependency of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      expect(manifest.peerDependencies?.[dependency]).toBe("*");
      expect(manifest.peerDependenciesMeta?.[dependency]?.optional).toBe(true);
    }
  });

  it("keeps the lockfile root identity aligned with the package manifest", () => {
    expect({
      name: lockfile.name,
      version: lockfile.version,
      rootName: lockfile.packages?.[""]?.name,
      rootVersion: lockfile.packages?.[""]?.version,
    }).toEqual({
      name: manifest.name,
      version: manifest.version,
      rootName: manifest.name,
      rootVersion: manifest.version,
    });
  });
});
