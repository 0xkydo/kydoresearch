import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDurableStateReadable,
  createPhaseHarness,
  loadFrozenFixture,
} from "./index.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("phase testkit", () => {
  it("uses isolated repositories, durable state, deterministic ports, and cleanup", async () => {
    const first = await createPhaseHarness();
    const second = await createPhaseHarness();
    cleanups.push(first.cleanup, second.cleanup);

    expect(first.repoRoot).not.toBe(second.repoRoot);
    expect(first.effects.runnerCalls.map((call) => call.kind)).toEqual(["init.explore"]);
    expect(second.effects.runnerCalls.map((call) => call.kind)).toEqual(["init.explore"]);
    expect(first.effects.runnerCalls[0]?.signal).toBeUndefined();
    expect(first.effects.commands.some((call) => call.command === "/bin/bash")).toBe(true);
    assertDurableStateReadable(first.stateDir);
    expect(first.stateFiles()).toContain("state.json");

    const firstRoot = first.repoRoot;
    first.cleanup();
    cleanups.splice(cleanups.indexOf(first.cleanup), 1);
    expect(fs.existsSync(firstRoot)).toBe(false);
  });

  it("rejects fixture escapes and deeply freezes loaded input", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase-fixture-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "case.json"), '{"state":{"phase":"ready"}}');

    const fixture = loadFrozenFixture<{ state: { phase: string } }>(root, "case.json");
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.state)).toBe(true);
    expect(() => loadFrozenFixture(root, "../outside.json")).toThrow(/escapes/);
    expect(() => loadFrozenFixture(root, path.join(root, "case.json"))).toThrow(/relative/);
  });
});
