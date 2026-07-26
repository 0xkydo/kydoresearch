import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  applyConfigSetting,
  ConfigPanel,
  type ConfigPanelResult,
} from "../../extensions/autoresearch/config-ui.ts";

describe("config component interaction", () => {
  it("handles arrows, tab, enter, space, escape, and Ctrl-C with stable focus", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const nav = { pane: "left" as const, left: 0, right: 0 };
    const done = vi.fn<(result: ConfigPanelResult) => void>();
    const requestRender = vi.fn();
    const panel = new ConfigPanel(
      config,
      nav,
      { requestRender } as unknown as TUI,
      plainTheme(),
      done,
    );

    panel.handleInput("\u001b[B");
    expect(nav.left).toBe(1);
    panel.handleInput("\t");
    expect(nav.pane).toBe("right");
    panel.handleInput("\u001b[B");
    expect(nav.right).toBe(1);
    const thinking = config.roles.phd.thinking;
    panel.handleInput(" ");
    expect(config.roles.phd.thinking).not.toBe(thinking);
    panel.handleInput("\u001b");
    expect(nav.pane).toBe("left");
    panel.handleInput("\u0003");
    expect(done).toHaveBeenCalledWith({ type: "close" });
    expect(requestRender).toHaveBeenCalled();
  });

  it("returns an edit request on Enter and validates dialog values explicitly", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const done = vi.fn<(result: ConfigPanelResult) => void>();
    const panel = new ConfigPanel(
      config,
      { pane: "right", left: 0, right: 0 },
      { requestRender: () => {} } as unknown as TUI,
      plainTheme(),
      done,
    );
    panel.handleInput("\r");

    expect(done).toHaveBeenCalledWith({
      type: "editModel",
      role: "professor",
      nav: { pane: "right", left: 0, right: 0 },
    });
    expect(applyConfigSetting(config, "maxIdeasPerLoop", "0")).toMatchObject({
      ok: false,
      changed: false,
    });
    expect(config.maxIdeasPerLoop).toBe(DEFAULT_CONFIG.maxIdeasPerLoop);
    expect(applyConfigSetting(config, "maxLoops", "")).toEqual({
      ok: true,
      changed: false,
    });
    expect(applyConfigSetting(config, "submitModelName", "  ")).toEqual({
      ok: true,
      changed: false,
    });
    expect(applyConfigSetting(config, "watchdogFile", "")).toMatchObject({
      ok: false,
      changed: false,
    });
  });
});

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}
