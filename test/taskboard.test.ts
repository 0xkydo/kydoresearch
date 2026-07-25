import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Taskboard } from "../src/taskboard.ts";
import { isImprovement, Mutex } from "../src/util.ts";

describe("Taskboard", () => {
  let stateDir: string;

  beforeEach(() => (stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-"))));
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it("add/update/list with concurrent writers", async () => {
    const board = new Taskboard(stateDir);
    const tasks = await Promise.all(
      Array.from({ length: 10 }, (_, i) => board.add(`task ${i}`, { role: "phd" })),
    );
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10); // no id collisions under concurrency
    expect(board.openCount()).toBe(10);

    await board.update(tasks[0]!.id, { status: "done" });
    await board.update(tasks[1]!.id, { status: "cancelled", note: "superseded" });
    expect(board.openCount()).toBe(8);
    expect(board.list().find((t) => t.id === tasks[1]!.id)?.note).toBe("superseded");

    await expect(board.update(999, { status: "done" })).rejects.toThrow(/no task/);
  });
});

describe("util", () => {
  it("isImprovement is direction-aware with epsilon", () => {
    expect(isImprovement(null, 100, "-", 0.005)).toBe(true); // baseline always improves
    expect(isImprovement(10, 9.96, "-", 0.005)).toBe(false); // within epsilon
    expect(isImprovement(10, 9.9, "-", 0.005)).toBe(true);
    expect(isImprovement(10, 10.04, "+", 0.005)).toBe(false);
    expect(isImprovement(10, 10.1, "+", 0.005)).toBe(true);
    expect(isImprovement(0, 0, "-", 0.005)).toBe(false); // zero-best guard
    expect(isImprovement(0, -1, "-", 0.005)).toBe(true);
  });

  it("Mutex serializes", async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.runExclusive(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      mutex.runExclusive(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
