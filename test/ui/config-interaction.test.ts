import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import {
  applyConfigSetting,
  ConfigPanel,
  type ConfigPanelResult,
  type NavState,
} from "../../extensions/autoresearch/config-ui.ts";

describe("config component interaction", () => {
  it("handles arrows, tab, enter, space, escape, and Ctrl-C with stable focus", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const nav: NavState = { pane: "left", left: 0, right: 0 };
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

  it("requires an explicit onboarding action to continue", () => {
    const done = vi.fn<(result: ConfigPanelResult) => void>();
    const nav: NavState = { pane: "left", left: 0, right: 0 };
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      nav,
      { requestRender: () => {} } as unknown as TUI,
      plainTheme(),
      done,
      {
        roles: ["setup"],
        onboardingActions: true,
      },
    );

    panel.handleInput("\t");
    expect(nav.pane).toBe("right");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\t");
    expect(nav.pane).toBe("actions");
    expect(nav.action).toBe(0);
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\r");
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith({ type: "continue", nav });
  });

  it("navigates between onboarding actions and cancels explicitly", () => {
    const done = vi.fn<(result: ConfigPanelResult) => void>();
    const nav: NavState = {
      pane: "actions",
      left: 0,
      right: 4,
      action: 0,
    };
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      nav,
      { requestRender: () => {} } as unknown as TUI,
      plainTheme(),
      done,
      {
        roles: ["setup"],
        onboardingActions: true,
      },
    );

    panel.handleInput("\u001b[A");
    expect(nav.pane).toBe("right");
    expect(nav.right).toBe(4);
    panel.handleInput("\u001b[B");
    expect(nav.pane).toBe("actions");

    panel.handleInput("\u001b[C");
    expect(nav.action).toBe(1);
    panel.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ type: "cancel", nav });
  });

  it.each([
    ["Escape", "\u001b"],
    ["Ctrl-C", "\u0003"],
  ])("treats %s as onboarding cancellation from any pane", (_name, key) => {
    const done = vi.fn<(result: ConfigPanelResult) => void>();
    const nav: NavState = { pane: "right", left: 0, right: 2 };
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      nav,
      { requestRender: () => {} } as unknown as TUI,
      plainTheme(),
      done,
      {
        roles: ["setup"],
        onboardingActions: true,
      },
    );

    panel.handleInput(key);
    expect(done).toHaveBeenCalledWith({ type: "cancel", nav });
  });
});

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}
