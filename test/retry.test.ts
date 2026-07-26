import { describe, expect, it } from "vitest";
import { retryBackoffMs, retryOperation } from "../src/retry.ts";

describe("retryOperation", () => {
  it("uses total-attempt semantics and bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await retryOperation({
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 25,
      operation: async () => ({ ok: ++calls === 4 }),
      isSuccess: (value) => value.ok,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(4);
    expect(delays).toEqual([10, 20, 25]);
    expect(retryBackoffMs(10, 25, 10)).toBe(25);
  });

  it("retries thrown errors but returns the final diagnostic result", async () => {
    let calls = 0;
    const result = await retryOperation({
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      operation: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket reset");
        return { ok: false, raw: `failure ${calls}` };
      },
      isSuccess: (value) => value.ok,
      delay: async () => {},
    });

    expect(calls).toBe(3);
    expect(result).toEqual({ ok: false, raw: "failure 3" });
  });

  it("does not start another attempt after abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await retryOperation({
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 100,
      signal: controller.signal,
      operation: async () => ({ ok: false, call: ++calls }),
      isSuccess: (value) => value.ok,
      delay: async () => controller.abort(),
    });

    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, call: 1 });
  });
});
