import * as fs from "node:fs";
import * as path from "node:path";

/** Write JSON atomically: tmp file in same dir + rename. */
export function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return readJson<T>(filePath);
}

/** Append one JSON line to an ndjson journal. */
export function appendJournal(filePath: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

export type Direction = "+" | "-";

/**
 * Direction-aware improvement check with relative epsilon.
 * A null best means any successful score is an improvement (baseline).
 */
export function isImprovement(
  best: number | null,
  candidate: number,
  direction: Direction,
  minImprovement: number,
): boolean {
  if (best === null) return true;
  if (direction === "+") return candidate > best * (1 + minImprovement);
  // For minimization, guard against best === 0 (relative epsilon degenerates).
  if (best === 0) return candidate < 0;
  return candidate < best * (1 - minImprovement);
}

/** Pick the better of two scores for a direction. */
export function betterScore(a: number, b: number, direction: Direction): number {
  return direction === "+" ? Math.max(a, b) : Math.min(a, b);
}

/** Simple FIFO async mutex. Used to serialize benchmarks across parallel ideas. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
