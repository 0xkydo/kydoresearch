import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateTelemetry,
  LocalTelemetry,
  readTelemetry,
  renderTelemetryReport,
} from "../src/telemetry.ts";

describe("local flow telemetry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function telemetryFixture(times: number[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-telemetry-"));
    dirs.push(dir);
    const file = path.join(dir, "telemetry.ndjson");
    return {
      file,
      telemetry: new LocalTelemetry(file, () => times.shift() ?? 0),
    };
  }

  it("records only timing context and classifies successful and failed results", async () => {
    const { file, telemetry } = telemetryFixture([1_000, 1_125, 2_000, 2_600]);

    await telemetry.measure(
      "phd.implement",
      { loop: 3, ideaId: "L003-I2", attempt: 1, scope: "idea" },
      async () => ({ ok: true, secret: "must-not-be-recorded" }),
      (result) => (result.ok ? "ok" : "error"),
    );
    await telemetry.measure(
      "challenge.verify",
      { loop: 3, ideaId: "L003-I2", attempt: 1, scope: "idea" },
      async () => ({ ok: false, raw: "private command output" }),
      (result) => (result.ok ? "ok" : "error"),
    );

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("must-not-be-recorded");
    expect(raw).not.toContain("private command output");
    expect(readTelemetry(file)).toEqual([
      expect.objectContaining({
        flow: "phd.implement",
        loop: 3,
        ideaId: "L003-I2",
        durationMs: 125,
        outcome: "ok",
      }),
      expect.objectContaining({
        flow: "challenge.verify",
        durationMs: 600,
        outcome: "error",
      }),
    ]);
  });

  it("survives malformed lines and renders aggregates ordered by total time", () => {
    const { file } = telemetryFixture([]);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          version: 1,
          flow: "professor.propose",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1_000,
          outcome: "ok",
        }),
        "{interrupted",
        JSON.stringify({
          version: 1,
          flow: "professor.propose",
          startedAt: "2026-01-01T00:00:02.000Z",
          endedAt: "2026-01-01T00:00:04.000Z",
          durationMs: 2_000,
          outcome: "aborted",
        }),
        JSON.stringify({
          version: 1,
          flow: "advisor.review",
          startedAt: "2026-01-01T00:00:05.000Z",
          endedAt: "2026-01-01T00:00:05.500Z",
          durationMs: 500,
          outcome: "ok",
        }),
      ].join("\n"),
    );

    const aggregates = aggregateTelemetry(readTelemetry(file));
    expect(aggregates[0]).toMatchObject({
      flow: "professor.propose",
      count: 2,
      ok: 1,
      aborted: 1,
      totalMs: 3_000,
      averageMs: 1_500,
      maxMs: 2_000,
    });
    const report = renderTelemetryReport(readTelemetry(file));
    expect(report).toContain("local telemetry · 3 completed flow(s)");
    expect(report.indexOf("professor.propose")).toBeLessThan(report.indexOf("advisor.review"));
    expect(report).toContain("Stored only in .autoresearch/telemetry.ndjson.");
  });
});
