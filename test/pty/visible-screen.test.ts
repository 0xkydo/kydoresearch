import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, saveConfig } from "../../src/config.ts";
import { newLoopState, saveState } from "../../src/state.ts";
import { makeTmpChallenge } from "../helpers/tmp-challenge.ts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const cleanupCallbacks: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
});

describe("real Pi PTY visible-screen smoke", () => {
  it("shows the compact paused control deck and resume action", async () => {
    const challenge = makeTmpChallenge();
    cleanupCallbacks.push(challenge.cleanup);
    const stateDir = path.join(challenge.repoRoot, ".autoresearch");
    const state = newLoopState({
      name: "pty-fixture",
      cli: "./bin/mockchal",
      direction: "-",
      setupCommand: "./setup.sh",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      submitNeedsModel: false,
      editablePaths: ["src/solution"],
      scorePath: "score.json",
      localEvaluation: {
        fidelity: "reduced",
        decision: "Use the documented reduced local mode.",
        limitations: ["Official hardware remains required."],
        officialValidationRequired: true,
      },
    });
    state.phase = "paused";
    state.resumePhase = "loop.ideas";
    state.loop = 4;
    state.bestScore = 10;
    state.ideas = [
      {
        id: "L004-I1",
        loop: 4,
        title: "Fuse lookup passes",
        parentCandidateId: "baseline",
        specFile: "ideas/loop-004/idea-1.md",
        status: "verifying",
        verifyAttempts: 1,
      },
      {
        id: "L004-I2",
        loop: 4,
        title: "Seeded verifier failure",
        parentCandidateId: "baseline",
        specFile: "ideas/loop-004/idea-2.md",
        status: "failed",
        verifyAttempts: 3,
        lastVerifyError: "params escaped the allowed bounds",
      },
    ];
    saveState(stateDir, state);
    saveConfig(stateDir, DEFAULT_CONFIG);

    const screen = await runPiPty(challenge.repoRoot, []);
    expect(screen).toContain("AUTORESEARCH");
    expect(screen).toContain("pty-fixture");
    expect(screen).toContain("PAUSED");
    expect(screen).toContain("AGENT");
    expect(screen).toContain("RUN");
    expect(screen).toContain("Experiments");
    expect(screen).not.toContain("Candidate");
    expect(screen).not.toContain("Live Activity");
    expect(screen).toMatch(/RESUME|\/autoresearch/);
    expect(writeScreenArtifact("mixed-candidates", screen)).toMatch(
      /mixed-candidates\.svg$/,
    );
  }, 20_000);

  it("opens the real configuration component with keyboard input", async () => {
    const challenge = makeTmpChallenge();
    cleanupCallbacks.push(challenge.cleanup);
    const stateDir = path.join(challenge.repoRoot, ".autoresearch");
    const state = newLoopState({
      name: "config-fixture",
      cli: "./bin/mockchal",
      direction: "-",
      setupCommand: "./setup.sh",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      submitNeedsModel: false,
      editablePaths: ["src/solution"],
      scorePath: "score.json",
    });
    state.phase = "ready";
    saveState(stateDir, state);
    saveConfig(stateDir, DEFAULT_CONFIG);

    const screen = await runPiPty(challenge.repoRoot, [
      { afterMs: 3_000, data: "/autoresearch config\r" },
      { afterMs: 1_200, data: "\t\u001b[B" },
      { afterMs: 300, data: "\u001b" },
    ]);
    expect(screen).toContain("autoresearch config");
    expect(screen).toMatch(/professor|settings/);
    expect(screen).toMatch(/model|thinking/);
    expect(writeScreenArtifact("configuration", screen)).toMatch(
      /configuration\.svg$/,
    );
  }, 20_000);

  it("keeps first-run confirmation and setup failure actionable without model access", async () => {
    const challenge = makeTmpChallenge();
    cleanupCallbacks.push(challenge.cleanup);
    const manifestPath = path.join(challenge.repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      setupCommand: string;
    };
    manifest.setupCommand = "./missing-setup-command.sh";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const screen = await runPiPty(challenge.repoRoot, [
      { afterMs: 3_000, data: "/autoresearch\r" },
      { afterMs: 1_200, data: "\t\t\r" },
      { afterMs: 400, data: "\r" },
      { afterMs: 3_200, data: "" },
    ]);
    expect(screen).toMatch(/Start autoresearch|AUTORESEARCH/);
    expect(screen).toMatch(/INITIALIZATION|dependency setup/i);
    expect(screen).toMatch(/STOPPED|failed|Retry \/autoresearch/i);
    expect(writeScreenArtifact("first-run-failure", screen)).toMatch(
      /first-run-failure\.svg$/,
    );
  }, 20_000);
});

interface ScheduledInput {
  afterMs: number;
  data: string;
}

async function runPiPty(
  cwd: string,
  scheduledInputs: ScheduledInput[],
): Promise<string> {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pty-config-"));
  cleanupCallbacks.push(() =>
    fs.rmSync(configDirectory, { recursive: true, force: true })
  );
  const pi = path.join(repoRoot, "node_modules/.bin/pi");
  const piArgs = [
    "--offline",
    "--no-session",
    "--no-extensions",
    "--extension",
    path.join(repoRoot, "extensions/autoresearch/index.ts"),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-tools",
    "--no-approve",
  ];
  const result = spawnSync("python3", [
    path.join(repoRoot, "test/pty/run_pty.py"),
    cwd,
    JSON.stringify(scheduledInputs),
    pi,
    ...piArgs,
  ], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: configDirectory,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
      COLUMNS: "100",
      LINES: "40",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
    },
  });
  if (result.error) throw result.error;
  if (
    result.status !== 0 &&
    result.status !== 129 &&
    result.status !== 130 &&
    result.signal !== "SIGTERM"
  ) {
    throw new Error(
      `Pi PTY exited ${String(result.status)}:\n` +
        `${stripTerminal(result.stdout)}\n${result.stderr}`,
    );
  }
  return stripTerminal(result.stdout + result.stderr);
}

function stripTerminal(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function writeScreenArtifact(name: string, screen: string): string {
  const configuredDirectory = process.env.KYDO_PTY_ARTIFACT_DIR;
  const directory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : fs.mkdtempSync(path.join(os.tmpdir(), "kydoresearch-pty-gallery-"));
  if (!configuredDirectory) {
    cleanupCallbacks.push(() =>
      fs.rmSync(directory, { recursive: true, force: true })
    );
  }
  fs.mkdirSync(directory, { recursive: true });
  const lines = screen.split("\n").slice(-80);
  const width = 1200;
  const height = Math.max(120, 36 + lines.length * 18);
  const body = lines
    .map(
      (line, index) =>
        `<text x="18" y="${30 + index * 18}">${escapeXml(line)}</text>`,
    )
    .join("\n");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#111827"/>',
    '<g fill="#e5e7eb" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14">',
    body,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
  const file = path.join(directory, `${name}.svg`);
  fs.writeFileSync(file, svg);
  expect(fs.readFileSync(file, "utf8")).toMatch(
    /^<svg[\s\S]*<\/svg>\n$/,
  );
  return file;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
