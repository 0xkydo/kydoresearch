import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAutoresearchCommand } from "../extensions/autoresearch/commands.ts";
import { newLoopState, saveState, STATE_DIR_NAME } from "../src/state.ts";

describe("/autoresearch status", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renders immediately through the interactive UI without queuing a future turn", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-status-"));
    dirs.push(repoRoot);
    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    const state = newLoopState({
      name: "status-challenge",
      cli: "",
      direction: "-",
      setupCommand: "./setup.sh",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      submitNeedsModel: false,
      editablePaths: ["src"],
      scorePath: "score.json",
    });
    state.phase = "ready";
    state.bestScore = 42;
    saveState(stateDir, state);

    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const sendMessage = vi.fn();
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
      sendMessage,
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const notify = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    expect(handler).toBeDefined();
    await handler!("status", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("autoresearch · status-challenge · loop 0 · phase ready"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("best local 42"), "info");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
