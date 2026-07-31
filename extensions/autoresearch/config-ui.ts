import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { HarnessConfig, ThinkingLevel } from "../../src/config.ts";
import {
  ROLE_PROFILE_DESCRIPTORS,
  type ProfileRole,
} from "./onboarding.ts";
import type { RolesConfig } from "../../src/config.ts";

/** Every role can be reviewed; onboarding may pass a smaller active-role list. */
export const CONFIGURABLE_ROLES = [
  "professor",
  "phd",
  "god",
  "advisor",
  "metaharness",
] as const;
export type ConfigurableRole = keyof RolesConfig;
export const ALL_CONFIGURABLE_ROLES: readonly ConfigurableRole[] = [
  "setup",
  ...CONFIGURABLE_ROLES,
];

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
  | "metaEvaluationLoops"
  | "metaMaxGenerations"
  | "metaMaxWallTimeMs"
  | "metaMaxRecoveryAttempts"
  | "watchdogFile"
  | "submitModelName";

export interface ConfigSettingUpdate {
  ok: boolean;
  changed: boolean;
  error?: string;
}

/** Apply one dialog value with the same validation used by the live config UI. */
export function applyConfigSetting(
  config: HarnessConfig,
  field: EditableSettingField,
  value: string,
): ConfigSettingUpdate {
  const before = JSON.stringify(config);
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  let valid = true;
  switch (field) {
    case "maxIdeasPerLoop":
      if (Number.isInteger(numeric) && numeric > 0) config.maxIdeasPerLoop = numeric;
      else valid = false;
      break;
    case "churchTriggerThreshold":
      if (Number.isInteger(numeric) && numeric >= 0) config.churchTriggerThreshold = numeric;
      else valid = false;
      break;
    case "maxVerifyAttempts":
      if (Number.isInteger(numeric) && numeric > 0) config.maxVerifyAttempts = numeric;
      else valid = false;
      break;
    case "maxLoops":
      if (trimmed === "") config.maxLoops = null;
      else if (Number.isInteger(numeric) && numeric > 0) config.maxLoops = numeric;
      else valid = false;
      break;
    case "minImprovement":
      if (Number.isFinite(numeric) && numeric >= 0) config.minImprovement = numeric;
      else valid = false;
      break;
    case "mockLoopDelayMs":
      if (Number.isInteger(numeric) && numeric >= 0) config.mockLoopDelayMs = numeric;
      else valid = false;
      break;
    case "setupTimeoutMs":
      if (Number.isInteger(numeric) && numeric > 0) config.execution.setupTimeoutMs = numeric;
      else valid = false;
      break;
    case "verifyTimeoutMs":
      if (Number.isInteger(numeric) && numeric > 0) config.execution.verifyTimeoutMs = numeric;
      else valid = false;
      break;
    case "benchmarkTimeoutMs":
      if (Number.isInteger(numeric) && numeric > 0) {
        config.execution.benchmarkTimeoutMs = numeric;
      } else valid = false;
      break;
    case "agentMaxAttempts":
      if (Number.isInteger(numeric) && numeric > 0) config.resilience.agentMaxAttempts = numeric;
      else valid = false;
      break;
    case "commandMaxAttempts":
      if (Number.isInteger(numeric) && numeric > 0) config.resilience.commandMaxAttempts = numeric;
      else valid = false;
      break;
    case "submitMaxAttempts":
      if (Number.isInteger(numeric) && numeric > 0) config.resilience.submitMaxAttempts = numeric;
      else valid = false;
      break;
    case "maxConsecutiveLoopFailures":
      if (Number.isInteger(numeric) && numeric > 0) {
        config.resilience.maxConsecutiveLoopFailures = numeric;
      } else valid = false;
      break;
    case "retryBaseDelayMs":
      if (Number.isInteger(numeric) && numeric >= 0) config.resilience.retryBaseDelayMs = numeric;
      else valid = false;
      break;
    case "retryMaxDelayMs":
      if (Number.isInteger(numeric) && numeric >= 0) config.resilience.retryMaxDelayMs = numeric;
      else valid = false;
      break;
    case "loopFailureBaseDelayMs":
      if (Number.isInteger(numeric) && numeric >= 0) {
        config.resilience.loopFailureBaseDelayMs = numeric;
      } else valid = false;
      break;
    case "loopFailureMaxDelayMs":
      if (Number.isInteger(numeric) && numeric >= 0) {
        config.resilience.loopFailureMaxDelayMs = numeric;
      } else valid = false;
      break;
    case "metaEvaluationLoops":
      if (Number.isInteger(numeric) && numeric > 0) config.metaHarness.evaluationLoops = numeric;
      else valid = false;
      break;
    case "metaMaxGenerations":
      if (trimmed === "") config.metaHarness.maxGenerations = null;
      else if (Number.isInteger(numeric) && numeric > 0) {
        config.metaHarness.maxGenerations = numeric;
      } else valid = false;
      break;
    case "metaMaxWallTimeMs":
      if (trimmed === "") config.metaHarness.maxWallTimeMs = null;
      else if (Number.isInteger(numeric) && numeric > 0) {
        config.metaHarness.maxWallTimeMs = numeric;
      } else valid = false;
      break;
    case "metaMaxRecoveryAttempts":
      if (Number.isInteger(numeric) && numeric > 0) {
        config.metaHarness.maxRecoveryAttempts = numeric;
      } else valid = false;
      break;
    case "watchdogFile":
      if (trimmed) config.advisor.watchdogFile = trimmed;
      else valid = false;
      break;
    case "submitModelName":
      config.submitModelName = trimmed || undefined;
      break;
  }
  if (!valid) {
    return {
      ok: false,
      changed: false,
      error: `Invalid value for ${field}: ${JSON.stringify(value)}`,
    };
  }
  return {
    ok: true,
    changed: before !== JSON.stringify(config),
  };
}

export interface NavState {
  pane: "left" | "right" | "actions";
  left: number;
  right: number;
  action?: 0 | 1;
}

/**
 * The panel resolves with an edit request when a field needs a dialog
 * (ui.input/ui.select can't stack on top of ui.custom); the command handler
 * performs the edit and reopens the panel at the same nav position.
 * Cycle fields (thinking, runner, advisor) mutate the config in place.
 */
export type ConfigPanelResult =
  | { type: "close" }
  | { type: "continue"; nav: NavState }
  | { type: "cancel"; nav: NavState }
  | { type: "editModel"; role: ConfigurableRole; nav: NavState }
  | { type: "editSoul"; role: ConfigurableRole; nav: NavState }
  | { type: "editPrompt"; role: ConfigurableRole; nav: NavState }
  | { type: "editTools"; role: ConfigurableRole; nav: NavState }
  | { type: "editSetting"; field: EditableSettingField; nav: NavState };

interface Row {
  id: string;
  label: string;
  value: string;
  kind: "cycle" | "edit";
}

const LEFT_WIDTH = 14;
const LABEL_WIDTH = 18;

export interface ConfigPanelOptions {
  roles?: readonly ConfigurableRole[];
  title?: string;
  describeRoles?: boolean;
  /** Require an explicit Continue or Cancel choice instead of an implicit close. */
  onboardingActions?: boolean;
}

export class ConfigPanel {
  constructor(
    private readonly config: HarnessConfig,
    private readonly nav: NavState,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: ConfigPanelResult) => void,
    private readonly options: ConfigPanelOptions = {},
  ) {}

  private leftItems(): string[] {
    return [...(this.options.roles ?? CONFIGURABLE_ROLES), "settings"];
  }

  private rows(): Row[] {
    const selected = this.leftItems()[this.nav.left];
    if (selected !== "settings") {
      const role = selected as ConfigurableRole;
      const spec = this.config.roles[role];
      return [
        { id: "model", label: "model", value: spec.model, kind: "edit" },
        { id: "thinking", label: "thinking", value: spec.thinking ?? "off", kind: "cycle" },
        {
          id: "tools",
          label: "tools",
          value: spec.tools?.join(", ") ?? "Pi defaults",
          kind: "edit",
        },
        { id: "soul", label: "soul", value: spec.soul ?? "SOUL.md", kind: "edit" },
        { id: "prompt", label: "prompt", value: spec.prompt ?? `${role}.md`, kind: "edit" },
      ];
    }
    const c = this.config;
    return [
      { id: "runner", label: "runner", value: c.runner, kind: "cycle" },
      { id: "advisorEnabled", label: "advisor", value: c.advisor.enabled ? "enabled" : "disabled", kind: "cycle" },
      {
        id: "metaHarnessEnabled",
        label: "metaharness",
        value: c.metaHarness.enabled ? "enabled" : "disabled",
        kind: "cycle",
      },
      { id: "maxIdeasPerLoop", label: "max ideas/loop", value: String(c.maxIdeasPerLoop), kind: "edit" },
      { id: "churchTriggerThreshold", label: "church threshold", value: c.churchTriggerThreshold === 0 ? "off" : String(c.churchTriggerThreshold), kind: "edit" },
      { id: "maxVerifyAttempts", label: "verify cycles", value: String(c.maxVerifyAttempts), kind: "edit" },
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
      {
        id: "metaEvaluationLoops",
        label: "meta eval loops",
        value: String(c.metaHarness.evaluationLoops),
        kind: "edit",
      },
      {
        id: "metaMaxGenerations",
        label: "meta generations",
        value: c.metaHarness.maxGenerations === null
          ? "unlimited"
          : String(c.metaHarness.maxGenerations),
        kind: "edit",
      },
      {
        id: "metaMaxWallTimeMs",
        label: "meta wall budget",
        value: c.metaHarness.maxWallTimeMs === null
          ? "unlimited"
          : `${c.metaHarness.maxWallTimeMs} ms`,
        kind: "edit",
      },
      {
        id: "metaMaxRecoveryAttempts",
        label: "meta recoveries",
        value: String(c.metaHarness.maxRecoveryAttempts),
        kind: "edit",
      },
      { id: "watchdogFile", label: "watchdog file", value: c.advisor.watchdogFile, kind: "edit" },
      { id: "submitModelName", label: "submit model", value: c.submitModelName ?? "—", kind: "edit" },
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      return this.options.onboardingActions
        ? this.done({ type: "cancel", nav: this.nav })
        : this.done({ type: "close" });
    }
    if (this.options.onboardingActions && matchesKey(data, "escape")) {
      return this.done({ type: "cancel", nav: this.nav });
    }
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
    } else if (this.nav.pane === "right") {
      const rows = this.rows();
      if (matchesKey(data, "escape") || matchesKey(data, "left")) {
        this.nav.pane = "left";
      } else if (matchesKey(data, "up")) {
        if (this.options.onboardingActions && this.nav.right === 0) {
          this.nav.pane = "left";
        } else {
          this.nav.right = (this.nav.right + rows.length - 1) % rows.length;
        }
      } else if (matchesKey(data, "down")) {
        if (
          this.options.onboardingActions &&
          this.nav.right === rows.length - 1
        ) {
          this.nav.pane = "actions";
          this.nav.action ??= 0;
        } else {
          this.nav.right = (this.nav.right + 1) % rows.length;
        }
      } else if (matchesKey(data, "tab") && this.options.onboardingActions) {
        this.nav.pane = "actions";
        this.nav.action ??= 0;
      } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        const row = rows[this.nav.right];
        if (row) this.activate(row);
      }
    } else {
      if (matchesKey(data, "left")) {
        this.nav.action = this.nav.action === 1 ? 0 : 1;
      } else if (matchesKey(data, "right")) {
        this.nav.action = this.nav.action === 0 ? 1 : 0;
      } else if (matchesKey(data, "up")) {
        this.nav.pane = "right";
        this.nav.right = Math.max(0, this.rows().length - 1);
      } else if (matchesKey(data, "tab")) {
        this.nav.pane = "left";
      } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
        return this.done({
          type: this.nav.action === 1 ? "cancel" : "continue",
          nav: this.nav,
        });
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
      case "metaHarnessEnabled":
        this.config.metaHarness.enabled = !this.config.metaHarness.enabled;
        return;
      case "model":
        return this.done({ type: "editModel", role: role!, nav: this.nav });
      case "soul":
        return this.done({ type: "editSoul", role: role!, nav: this.nav });
      case "prompt":
        return this.done({ type: "editPrompt", role: role!, nav: this.nav });
      case "tools":
        return this.done({ type: "editTools", role: role!, nav: this.nav });
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

    const titleText = this.options.title ?? "autoresearch config";
    const title = th.fg("accent", ` ${titleText} `);
    lines.push(truncateToWidth(th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - titleText.length - 7))), width));
    lines.push("");

    const selectedItem = leftItems[this.nav.left];
    if (this.options.describeRoles && selectedItem !== "settings") {
      const descriptor = ROLE_PROFILE_DESCRIPTORS[selectedItem as ProfileRole];
      lines.push(truncateToWidth(`  ${th.bold(descriptor.label)} — ${descriptor.purpose}`, width));
      lines.push(truncateToWidth(`  ${th.fg("muted", descriptor.timing)}`, width));
      lines.push(truncateToWidth(`  ${th.fg("dim", descriptor.authority)}`, width));
      lines.push("");
    }

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
    if (this.options.onboardingActions) {
      const action = this.nav.action ?? 0;
      const continueButton = this.renderActionButton(
        "Continue",
        this.nav.pane === "actions" && action === 0,
      );
      const cancelButton = this.renderActionButton(
        "Cancel",
        this.nav.pane === "actions" && action === 1,
      );
      lines.push(
        truncateToWidth(`  ${continueButton}  ${cancelButton}`, width),
      );
      lines.push("");
    }
    const hint =
      this.nav.pane === "actions"
        ? "←→ choose · enter confirm · ↑ fields · esc cancel"
        : this.nav.pane === "left"
        ? this.options.onboardingActions
          ? "↑↓ select · enter/→ open · esc cancel"
          : "↑↓ select · enter/→ open · esc close"
        : this.options.onboardingActions
          ? "↑↓ select · enter edit/cycle · tab actions · ← back · esc cancel"
          : "↑↓ select · enter edit/cycle · ←/esc back";
    lines.push(truncateToWidth("  " + th.fg("dim", hint), width));
    lines.push("");
    return lines;
  }

  private renderActionButton(label: string, selected: boolean): string {
    const text = `[ ${label} ]`;
    return selected
      ? this.theme.fg("accent", this.theme.bold(`▸ ${text}`))
      : this.theme.fg("muted", `  ${text}`);
  }

  invalidate(): void {}
}
