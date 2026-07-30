import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deterministicIncident,
  parseOncallAssessment,
  parseSupervisorArgs,
  processExitIncident,
  shouldIntervene,
} from "../src/oncall/supervisor.ts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

describe("on-call incident policy", () => {
  it("does not treat ordinary inner-loop failures as catastrophic", () => {
    const state = {
      phase: "loop.ideas",
      loop: 3,
      ideas: [{ id: "L003-I1", status: "failed", verifyAttempts: 3 }],
    };

    expect(deterministicIncident(state, 20_000, 19_000, 10_000)).toBeNull();
    expect(
      shouldIntervene(
        {
          catastrophic: false,
          category: "none",
          confidence: "high",
          problem: "One candidate failed verification.",
          why: "Sibling ideas and the loop can continue.",
          errorLogs: ["L003-I1 failed"],
          possibleRootCauses: [],
          repairable: false,
          repairScope: [],
          restartRecommended: false,
        },
        null,
      ),
    ).toBe(false);
  });

  it("recognizes only stopped-progress boundaries deterministically", () => {
    expect(
      deterministicIncident(
        {
          phase: "paused",
          recovery: {
            scope: "loop",
            message: "provider unavailable",
            consecutiveFailures: 12,
          },
        },
        20_000,
        19_000,
        10_000,
      ),
    ).toMatchObject({ category: "recovery-circuit-open" });

    expect(
      deterministicIncident(
        { phase: "loop.proposing" },
        20_000,
        1_000,
        10_000,
      ),
    ).toMatchObject({ category: "progress-stalled" });
  });

  it("distinguishes intentional terminal exit from a process crash", () => {
    expect(processExitIncident({ code: 0, signal: null }, { phase: "done" })).toBeNull();
    expect(
      processExitIncident({ code: 1, signal: null }, { phase: "loop.syncing" }),
    ).toMatchObject({ category: "process-crash" });
  });

  it("requires a valid high-confidence analyst contract for semantic intervention", () => {
    const parsed = parseOncallAssessment(
      JSON.stringify({
        catastrophic: true,
        category: "provider-outage",
        confidence: "medium",
        problem: "Requests are failing.",
        why: "Retries remain.",
        errorLogs: ["503"],
        possibleRootCauses: ["upstream outage"],
        repairable: false,
        repairScope: [],
        restartRecommended: false,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(shouldIntervene(parsed, null, 2)).toBe(false);
    expect(
      shouldIntervene(
        {
          ...parsed!,
          confidence: "high",
        },
        null,
        1,
      ),
    ).toBe(false);
    expect(
      shouldIntervene(
        {
          ...parsed!,
          confidence: "high",
        },
        null,
        2,
      ),
    ).toBe(true);
    expect(parseOncallAssessment('{"catastrophic":true}')).toBeNull();
  });

  it("forwards ordinary Pi options while keeping supervisor flags separate", () => {
    const parsed = parseSupervisorArgs(
      [
        "--scan-interval-ms",
        "25",
        "--oncall-thinking",
        "xhigh",
        "--",
        "--model",
        "anthropic/claude-sonnet-5",
      ],
      "/tmp/challenge",
      "/tmp/runtime",
    );
    expect(parsed.options.scanIntervalMs).toBe(25);
    expect(parsed.options.oncallThinking).toBe("xhigh");
    expect(parsed.options.piArgs).toEqual([
      "--model",
      "anthropic/claude-sonnet-5",
    ]);
    expect(parsed.options.extensionPath).toBe(
      "/tmp/runtime/extensions/autoresearch/index.ts",
    );
  });
});

describe("pi-kydo supervised lifecycle", () => {
  it("reports, dispatches Sol high repair, and resumes after a Pi crash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kydo-oncall-"));
    const stateDir = path.join(root, ".autoresearch");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        phase: "loop.syncing",
        loop: 2,
        history: [{}],
        ideas: [],
        updatedAt: new Date().toISOString(),
      })}\n`,
    );
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "");

    const fakePi = path.join(root, "fake-pi.mjs");
    const fakeCodex = path.join(root, "fake-codex.mjs");
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const root = process.cwd();
if (args.includes("--mode")) {
  const assessment = {
    catastrophic: true,
    category: "process-crash",
    confidence: "high",
    problem: "Interactive Pi crashed while AutoResearch was active.",
    why: "The process exited nonzero in loop.syncing.",
    errorLogs: ["fatal runtime error"],
    possibleRootCauses: ["runtime defect"],
    repairable: true,
    repairScope: ["runtime crash path"],
    restartRecommended: true
  };
  console.log(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(assessment) }] }
  }));
  process.exit(0);
}
const countPath = path.join(root, "main-count");
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
fs.appendFileSync(path.join(root, "main-launches.ndjson"), JSON.stringify({
  count,
  restart: process.env.KYDO_ONCALL_RESTART ?? null,
  args
}) + "\\n");
if (count === 1) {
  console.error("fatal runtime error");
  process.exit(7);
}
fs.writeFileSync(path.join(root, ".autoresearch", "state.json"), JSON.stringify({
  phase: "done",
  loop: 2,
  history: [{}, {}],
  ideas: [],
  updatedAt: new Date().toISOString()
}) + "\\n");
process.exit(0);
`,
    );
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), "codex-args.json"), JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
const result = {
  status: "fixed",
  summary: "Repaired the process-level crash.",
  filesChanged: ["runtime.ts"],
  validation: ["focused regression passed"],
  remainingRisk: ""
};
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], JSON.stringify(result));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
`,
    );
    fs.chmodSync(fakePi, 0o755);
    fs.chmodSync(fakeCodex, 0o755);

    const result = await runProcess(
      process.execPath,
      [
        path.join(repoRoot, "bin", "pi-kydo.js"),
        "--pi-bin",
        fakePi,
        "--codex-bin",
        fakeCodex,
        "--scan-interval-ms",
        "10",
        "--stalled-after-ms",
        "10000",
        "--restart-base-delay-ms",
        "10",
        "--restart-max-delay-ms",
        "20",
        "--max-restarts",
        "2",
        "--state-dir",
        stateDir,
      ],
      root,
    );

    expect(result.code).toBe(0);
    const launches = fs
      .readFileSync(path.join(root, "main-launches.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            count: number;
            restart: string | null;
            args: string[];
          },
      );
    expect(launches).toEqual([
      expect.objectContaining({ count: 1, restart: null }),
      expect.objectContaining({ count: 2, restart: "1" }),
    ]);
    expect(launches[0]?.args).toEqual([
      "-e",
      path.join(repoRoot, "extensions", "autoresearch", "index.ts"),
    ]);

    const codexArgs = JSON.parse(
      fs.readFileSync(path.join(root, "codex-args.json"), "utf8"),
    ) as string[];
    expect(codexArgs).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-5.6-sol",
        'model_reasoning_effort="high"',
        "--sandbox",
        "workspace-write",
      ]),
    );
    const incidentDirectories = fs.readdirSync(
      path.join(stateDir, "oncall", "incidents"),
    );
    expect(incidentDirectories).toHaveLength(1);
    const incident = path.join(
      stateDir,
      "oncall",
      "incidents",
      incidentDirectories[0]!,
    );
    expect(fs.readFileSync(path.join(incident, "report.md"), "utf8")).toContain(
      "fatal runtime error",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(incident, "repair.json"), "utf8")),
    ).toMatchObject({ status: "fixed" });
    expect(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8")).toContain(
      ".autoresearch/",
    );
  }, 15_000);
});

function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
