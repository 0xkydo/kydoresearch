import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newLoopState, saveState } from "../../../src/state.ts";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("real Pi extension loading", () => {
  it("loads through Pi, registers the command, and restores the RPC dashboard without a provider", () => {
    const challenge = temporaryDirectory("pi-extension-challenge-");
    const stateDir = path.join(challenge, ".autoresearch");
    const state = newLoopState({
      name: "loader-fixture",
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
    state.bestScore = 10;
    saveState(stateDir, state);

    const result = spawnSync(
      path.join(repoRoot, "node_modules/.bin/pi"),
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-session",
        "--no-extensions",
        "--extension",
        path.join(repoRoot, "extensions/autoresearch/index.ts"),
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--tools",
        "taskboard,research_notes",
      ],
      {
        cwd: challenge,
        encoding: "utf8",
        timeout: 15_000,
        input:
          '{"id":"commands","type":"get_commands"}\n' +
          '{"id":"status","type":"prompt","message":"/autoresearch status"}\n',
        env: isolatedPiEnvironment(),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const commands = messages.find((message) =>
      message.type === "response" && message.id === "commands"
    );
    expect(commands.data.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "autoresearch",
          source: "extension",
        }),
      ]),
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "extension_ui_request",
          method: "setWidget",
        }),
        expect.objectContaining({
          type: "response",
          id: "status",
          success: true,
        }),
      ]),
    );
    expect(result.stdout).toContain("loader-fixture");
    expect(result.stdout).toContain("score  10 local");
    expect(result.stderr).not.toContain("Unknown tool");
  });

  it("installs the packed extension in a fresh consumer without runtime side effects", () => {
    const packDirectory = temporaryDirectory("pi-extension-pack-");
    const consumer = temporaryDirectory("pi-extension-consumer-");
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      '{"name":"consumer-fixture","private":true,"version":"1.0.0"}\n',
    );
    const packed = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
        env: npmEnvironment(packDirectory),
      },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as
      | Array<{ filename: string }>
      | Record<string, { filename: string }>;
    const packedEntry = Array.isArray(packResult)
      ? packResult[0]
      : Object.values(packResult)[0];
    expect(packedEntry).toBeDefined();
    const tarball = path.join(packDirectory, packedEntry!.filename);
    const installed = spawnSync(
      "npm",
      [
        "install",
        tarball,
        "--ignore-scripts",
        "--omit=dev",
        "--offline",
        "--legacy-peer-deps",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        timeout: 20_000,
        env: npmEnvironment(path.join(consumer, ".npm-cache")),
      },
    );
    expect(installed.status, installed.stderr).toBe(0);
    const packageRoot = path.join(consumer, "node_modules/kydoresearch");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    expect(manifest.pi?.extensions).toEqual(["./extensions/autoresearch/index.ts"]);
    expect(fs.statSync(
      path.join(packageRoot, "extensions/autoresearch/index.ts"),
    ).isFile()).toBe(true);
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function isolatedPiEnvironment(): NodeJS.ProcessEnv {
  const configDirectory = temporaryDirectory("pi-extension-config-");
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: configDirectory,
    PI_OFFLINE: "1",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
  };
}

function npmEnvironment(cacheDirectory: string): NodeJS.ProcessEnv {
  fs.mkdirSync(cacheDirectory, { recursive: true });
  return {
    ...process.env,
    npm_config_cache: cacheDirectory,
    npm_config_update_notifier: "false",
  };
}
