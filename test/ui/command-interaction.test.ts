import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAutoresearchCommand } from "../../extensions/autoresearch/commands.ts";
import type { ConfigPanelResult } from "../../extensions/autoresearch/config-ui.ts";

interface RegisteredCommand {
  getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("command interaction harness", () => {
  it("provides completions and actionable unknown-command feedback", async () => {
    const command = register();
    expect(command.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status" },
      { value: "steer", label: "steer" },
      { value: "stop", label: "stop" },
    ]);
    expect(command.getArgumentCompletions("missing")).toBeNull();

    const notify = vi.fn();
    await command.handler("unknown", {
      cwd: temporaryDirectory(),
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('unknown subcommand "unknown"'),
      "warning",
    );
  });

  it("closes configuration without persistence when cancelled or invalid", async () => {
    const repoRoot = temporaryDirectory();
    const command = register();
    const notify = vi.fn();
    const results: ConfigPanelResult[] = [
      {
        type: "editSetting",
        field: "maxIdeasPerLoop",
        nav: { pane: "right", left: 5, right: 1 },
      },
      { type: "close" },
    ];
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify,
        custom: async () => results.shift(),
        input: async () => "0",
      },
    } as unknown as ExtensionCommandContext;

    await command.handler("config", ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid value for maxIdeasPerLoop"),
      "warning",
    );
    expect(notify).toHaveBeenCalledWith("config closed without changes", "info");
    expect(fs.existsSync(path.join(repoRoot, ".autoresearch/config.json"))).toBe(false);
  });

  it("surfaces empty model lists and persistence failures without claiming success", async () => {
    const repoRoot = temporaryDirectory();
    const command = register();
    const notify = vi.fn();
    const results: ConfigPanelResult[] = [
      {
        type: "editModel",
        role: "professor",
        nav: { pane: "right", left: 0, right: 0 },
      },
      {
        type: "editSetting",
        field: "maxIdeasPerLoop",
        nav: { pane: "right", left: 5, right: 1 },
      },
      { type: "close" },
    ];
    fs.writeFileSync(path.join(repoRoot, ".autoresearch"), "blocks directory creation");
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify,
        custom: async () => results.shift(),
        input: async () => "2",
      },
    } as unknown as ExtensionCommandContext;

    await command.handler("config", ctx);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("no available models found"),
      "warning",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("config was not saved"),
      "error",
    );
    expect(notify).not.toHaveBeenCalledWith(
      "config saved to .autoresearch/config.json",
      "info",
    );
  });
});

function register(): RegisteredCommand {
  let command: RegisteredCommand | undefined;
  const pi = {
    registerCommand: (_name: string, value: RegisteredCommand) => {
      command = value;
    },
  } as unknown as ExtensionAPI;
  registerAutoresearchCommand(pi);
  if (!command) throw new Error("autoresearch command was not registered");
  return command;
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "command-interaction-"));
  directories.push(directory);
  return directory;
}
