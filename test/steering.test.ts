import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearOperatorSteering,
  loadOperatorSteering,
  MAX_OPERATOR_STEERING_CHARS,
  setOperatorSteering,
} from "../src/steering.ts";

describe("operator steering", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function stateDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-steering-"));
    dirs.push(root);
    return path.join(root, ".autoresearch");
  }

  it("atomically persists, replaces, and clears the active direction", () => {
    const dir = stateDir();

    expect(loadOperatorSteering(dir)).toBeNull();
    expect(
      setOperatorSteering(
        dir,
        "  Explore cache locality before changing the algorithm family.  ",
        "2026-07-26T10:00:00.000Z",
      ),
    ).toEqual({
      text: "Explore cache locality before changing the algorithm family.",
      updatedAt: "2026-07-26T10:00:00.000Z",
    });
    expect(loadOperatorSteering(dir)?.text).toContain("cache locality");

    setOperatorSteering(
      dir,
      "Test a structural representation change.",
      "2026-07-26T11:00:00.000Z",
    );
    expect(loadOperatorSteering(dir)).toEqual({
      text: "Test a structural representation change.",
      updatedAt: "2026-07-26T11:00:00.000Z",
    });

    clearOperatorSteering(dir);
    expect(loadOperatorSteering(dir)).toBeNull();
  });

  it("rejects empty and unbounded operator input", () => {
    const dir = stateDir();

    expect(() => setOperatorSteering(dir, "  ")).toThrow(/must not be empty/);
    expect(() =>
      setOperatorSteering(dir, "x".repeat(MAX_OPERATOR_STEERING_CHARS + 1)),
    ).toThrow(/exceeds/);
  });
});
