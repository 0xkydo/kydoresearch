import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ConfigPanel } from "../extensions/autoresearch/config-ui.ts";

describe("ConfigPanel", () => {
  it("separates the longest settings label from its value", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const tui = { requestRender: () => {} } as unknown as TUI;
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      { pane: "right", left: 5, right: 0 },
      tui,
      theme,
      () => {},
    );

    const rendered = panel.render(180).join("\n");
    expect(rendered).toContain("benchmark timeout 3600000 ms");
    expect(rendered).toContain("mock loop delay   0 ms");
    expect(rendered).toContain("agent attempts    3");
    expect(rendered).toContain("submit attempts   5");
  });

  it("shows role-local soul and dynamic prompt as separate settings", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const tui = { requestRender: () => {} } as unknown as TUI;
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      { pane: "right", left: 0, right: 0 },
      tui,
      theme,
      () => {},
    );

    const rendered = panel.render(160).join("\n");
    expect(rendered).toContain("soul              SOUL.md");
    expect(rendered).toContain("prompt            professor.md");
  });

  it("explains Setup during onboarding and exposes its tool policy", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const tui = { requestRender: () => {} } as unknown as TUI;
    const panel = new ConfigPanel(
      structuredClone(DEFAULT_CONFIG),
      { pane: "right", left: 0, right: 0 },
      tui,
      theme,
      () => {},
      {
        roles: ["setup"],
        title: "first-run agent profiles",
        describeRoles: true,
      },
    );

    const rendered = panel.render(180).join("\n");
    expect(rendered).toContain("Setup — Maps the challenge");
    expect(rendered).toContain("first-time initialization");
    expect(rendered).toContain("never optimizes candidates");
    expect(rendered).toContain("tools             read, write, edit, bash");
  });
});
