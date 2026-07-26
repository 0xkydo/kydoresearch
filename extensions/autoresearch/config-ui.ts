import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { HarnessConfig, ThinkingLevel } from "../../src/config.ts";

/** Roles editable in the config panel. Setup runs once at init, so it is excluded. */
export const CONFIGURABLE_ROLES = ["professor", "phd", "god", "advisor"] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type EditableSettingField =
  | "maxIdeasPerLoop"
  | "churchTriggerThreshold"
  | "maxVerifyAttempts"
  | "maxLoops"
  | "minImprovement"
  | "mockLoopDelayMs"
  | "setupTimeoutMs"
  | "verifyTimeoutMs"
  | "benchmarkTimeoutMs"
  | "agentMaxAttempts"
  | "commandMaxAttempts"
  | "submitMaxAttempts"
  | "maxConsecutiveLoopFailures"
  | "retryBaseDelayMs"
  | "retryMaxDelayMs"
  | "loopFailureBaseDelayMs"
  | "loopFailureMaxDelayMs"
  | "watchdogFile"
  | "submitModelName";

export interface NavState {
  pane: "left" | "right";
  left: number;
  right: number;
}

/**
 * The panel resolves with an edit request when a field needs a dialog
 * (ui.input/ui.select can't stack on top of ui.custom); the command handler
 * performs the edit and reopens the panel at the same nav position.
 * Cycle fields (thinking, runner, advisor) mutate the config in place.
 */
export type ConfigPanelResult =
  | { type: "close" }
  | { type: "editModel"; role: ConfigurableRole; nav: NavState }
  | { type: "editPrompt"; role: ConfigurableRole; nav: NavState }
  | { type: "editSetting"; field: EditableSettingField; nav: NavState };

interface Row {
  id: string;
  label: string;
  value: string;
  kind: "cycle" | "edit";
}

const LEFT_WIDTH = 12;
const LABEL_WIDTH = 18;

export class ConfigPanel {
  constructor(
    private readonly config: HarnessConfig,
    private readonly nav: NavState,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: ConfigPanelResult) => void,
  ) {}

  private leftItems(): string[] {
    return [...CONFIGURABLE_ROLES, "settings"];
  }

  private rows(): Row[] {
    const selected = this.leftItems()[this.nav.left];
    if (selected !== "settings") {
      const role = selected as ConfigurableRole;
      const spec = this.config.roles[role];
      return [
        { id: "model", label: "model", value: spec.model, kind: "edit" },
        { id: "thinking", label: "thinking", value: spec.thinking ?? "off", kind: "cycle" },
        { id: "prompt", label: "role prompt", value: spec.prompt ?? `roles/${role}.md`, kind: "edit" },
      ];
    }
    const c = this.config;
    return [
      { id: "runner", label: "runner", value: c.runner, kind: "cycle" },
      { id: "advisorEnabled", label: "advisor", value: c.advisor.enabled ? "enabled" : "disabled", kind: "cycle" },
      { id: "maxIdeasPerLoop", label: "max ideas/loop", value: String(c.maxIdeasPerLoop), kind: "edit" },
      { id: "churchTriggerThreshold", label: "church threshold", value: c.churchTriggerThreshold === 0 ? "off" : String(c.churchTriggerThreshold), kind: "edit" },
      { id: "maxVerifyAttempts", label: "verify attempts", value: String(c.maxVerifyAttempts), kind: "edit" },
      { id: "maxLoops", label: "max loops", value: c.maxLoops === null ? "unlimited" : String(c.maxLoops), kind: "edit" },
      { id: "minImprovement", label: "min improvement", value: String(c.minImprovement), kind: "edit" },
      { id: "mockLoopDelayMs", label: "mock loop delay", value: `${c.mockLoopDelayMs} ms`, kind: "edit" },
      { id: "setupTimeoutMs", label: "setup timeout", value: `${c.execution.setupTimeoutMs} ms`, kind: "edit" },
      { id: "verifyTimeoutMs", label: "verify timeout", value: `${c.execution.verifyTimeoutMs} ms`, kind: "edit" },
      {
        id: "benchmarkTimeoutMs",
        label: "benchmark timeout",
        value: `${c.execution.benchmarkTimeoutMs} ms`,
        kind: "edit",
      },
      { id: "agentMaxAttempts", label: "agent attempts", value: String(c.resilience.agentMaxAttempts), kind: "edit" },
      { id: "commandMaxAttempts", label: "command attempts", value: String(c.resilience.commandMaxAttempts), kind: "edit" },
      { id: "submitMaxAttempts", label: "submit attempts", value: String(c.resilience.submitMaxAttempts), kind: "edit" },
      {
        id: "maxConsecutiveLoopFailures",
        label: "failure circuit",
        value: String(c.resilience.maxConsecutiveLoopFailures),
        kind: "edit",
      },
      { id: "retryBaseDelayMs", label: "retry base delay", value: `${c.resilience.retryBaseDelayMs} ms`, kind: "edit" },
      { id: "retryMaxDelayMs", label: "retry max delay", value: `${c.resilience.retryMaxDelayMs} ms`, kind: "edit" },
      { id: "loopFailureBaseDelayMs", label: "recovery base", value: `${c.resilience.loopFailureBaseDelayMs} ms`, kind: "edit" },
      { id: "loopFailureMaxDelayMs", label: "recovery max", value: `${c.resilience.loopFailureMaxDelayMs} ms`, kind: "edit" },
      { id: "watchdogFile", label: "watchdog file", value: c.advisor.watchdogFile, kind: "edit" },
      { id: "submitModelName", label: "submit model", value: c.submitModelName ?? "—", kind: "edit" },
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) return this.done({ type: "close" });
    if (this.nav.pane === "left") {
      const count = this.leftItems().length;
      if (matchesKey(data, "escape")) return this.done({ type: "close" });
      if (matchesKey(data, "up")) {
        this.nav.left = (this.nav.left + count - 1) % count;
        this.nav.right = 0;
      } else if (matchesKey(data, "down")) {
        this.nav.left = (this.nav.left + 1) % count;
        this.nav.right = 0;
      } else if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "tab")) {
        this.nav.pane = "right";
        this.nav.right = 0;
      }
    } else {
      const rows = this.rows();
      if (matchesKey(data, "escape") || matchesKey(data, "left")) {
        this.nav.pane = "left";
      } else if (matchesKey(data, "up")) {
        this.nav.right = (this.nav.right + rows.length - 1) % rows.length;
      } else if (matchesKey(data, "down")) {
        this.nav.right = (this.nav.right + 1) % rows.length;
      } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const row = rows[this.nav.right];
        if (row) this.activate(row);
      }
    }
    this.tui.requestRender();
  }

  private activate(row: Row): void {
    const selected = this.leftItems()[this.nav.left];
    const role = selected !== "settings" ? (selected as ConfigurableRole) : undefined;
    switch (row.id) {
      case "thinking": {
        const spec = this.config.roles[role!];
        const next = (THINKING_LEVELS.indexOf(spec.thinking ?? "off") + 1) % THINKING_LEVELS.length;
        spec.thinking = THINKING_LEVELS[next];
        return;
      }
      case "runner":
        this.config.runner = this.config.runner === "mock" ? "subprocess" : "mock";
        return;
      case "advisorEnabled":
        this.config.advisor.enabled = !this.config.advisor.enabled;
        return;
      case "model":
        return this.done({ type: "editModel", role: role!, nav: this.nav });
      case "prompt":
        return this.done({ type: "editPrompt", role: role!, nav: this.nav });
      default:
        return this.done({ type: "editSetting", field: row.id as EditableSettingField, nav: this.nav });
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const leftItems = this.leftItems();
    const rows = this.rows();
    const sep = th.fg("borderMuted", "│ ");
    const lines: string[] = [""];

    const title = th.fg("accent", " autoresearch config ");
    lines.push(truncateToWidth(th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 25))), width));
    lines.push("");

    // Left column: roles, a divider, then settings.
    const leftCells: string[] = [];
    const leftRowIndex: number[] = []; // visual row → nav index (-1 for divider)
    for (let i = 0; i < leftItems.length; i++) {
      if (leftItems[i] === "settings") {
        leftCells.push("  " + "─".repeat(LEFT_WIDTH - 2));
        leftRowIndex.push(-1);
      }
      const selected = i === this.nav.left;
      const marker = selected ? "▸ " : "  ";
      const plain = (marker + leftItems[i]).padEnd(LEFT_WIDTH);
      leftCells.push(
        selected
          ? this.nav.pane === "left"
            ? th.fg("accent", th.bold(plain))
            : th.fg("accent", plain)
          : th.fg("muted", plain),
      );
      leftRowIndex.push(i);
    }

    const rightCells: string[] = rows.map((row, i) => {
      const selected = this.nav.pane === "right" && i === this.nav.right;
      const marker = selected ? "▸ " : "  ";
      const label = row.label.padEnd(LABEL_WIDTH);
      const hint = row.kind === "cycle" ? th.fg("dim", "  (enter cycles)") : "";
      const labelStyled = selected ? th.fg("accent", th.bold(marker + label)) : th.fg("muted", marker + label);
      return labelStyled + th.fg("text", row.value) + (selected ? hint : "");
    });

    const height = Math.max(leftCells.length, rightCells.length);
    for (let i = 0; i < height; i++) {
      const left = leftCells[i] ?? " ".repeat(LEFT_WIDTH);
      lines.push(truncateToWidth(" " + left + sep + (rightCells[i] ?? ""), width));
    }

    lines.push("");
    const hint =
      this.nav.pane === "left"
        ? "↑↓ select · enter/→ open · esc close"
        : "↑↓ select · enter edit/cycle · ←/esc back";
    lines.push(truncateToWidth("  " + th.fg("dim", hint), width));
    lines.push("");
    return lines;
  }

  invalidate(): void {}
}
