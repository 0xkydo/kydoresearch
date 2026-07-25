import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockAgentRunner } from "../../src/agents/mock.ts";
import { PiSubprocessRunner } from "../../src/agents/subprocess.ts";
import type { AgentRunner } from "../../src/agents/types.ts";
import { YukonCliAdapter } from "../../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../../src/challenge/detect.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { nodeExec } from "../../src/exec.ts";
import { initChallenge } from "../../src/init.ts";
import type { OrchestratorEvent } from "../../src/orchestrator.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import { loadState, STATE_DIR_NAME, statePaths } from "../../src/state.ts";
import type { ConfigPanelResult, EditableSettingField, NavState } from "./config-ui.ts";
import { ConfigPanel, CONFIGURABLE_ROLES } from "./config-ui.ts";
import { renderStatusLines } from "./widget.ts";

const WIDGET_KEY = "autoresearch";
export const MIN_PI_VERSION = "0.75.0";

export interface AutoresearchCommandOptions {
  /** Injectable for compatibility regression tests; production uses Pi's runtime version. */
  piVersion?: string;
}

interface RunHandle {
  controller: AbortController;
  orchestrator: Orchestrator;
  challengeName: string;
  running: Promise<void>;
}

/** Registers /autoresearch with subcommands run|status|config|stop. */
export function registerAutoresearchCommand(
  pi: ExtensionAPI,
  options: AutoresearchCommandOptions = {},
): { restoreWidget: (ctx: ExtensionContext) => void } {
  let active: RunHandle | null = null;
  const piVersion = options.piVersion ?? PI_VERSION;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(`[autoresearch] ${message}`);
  }

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI || !active) return;
    ctx.ui.setWidget(WIDGET_KEY, renderStatusLines(active.challengeName, active.orchestrator.status()));
  }

  function makeRunner(runnerKind: "mock" | "subprocess", stateDir: string): AgentRunner {
    return runnerKind === "subprocess" ? new PiSubprocessRunner(loadConfig(stateDir).roles) : new MockAgentRunner();
  }

  function surfaceEvent(ctx: ExtensionContext, ev: OrchestratorEvent) {
    switch (ev.type) {
      case "advice":
        pi.sendMessage(
          {
            customType: "autoresearch-advice",
            content: ev.notes.map((n) => `[advisor:${n.severity}] ${n.text}`).join("\n"),
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
        break;
      case "submitted":
        notify(ctx, `submitted ${ev.ideaId} (score ${ev.score})${ev.submissionId ? ` as ${ev.submissionId}` : ""}`);
        break;
      case "god":
        notify(ctx, `the professor spoke with God after loop ${ev.loop} — see ${ev.noteFile}`, "warning");
        break;
      default:
        break;
    }
    updateWidget(ctx);
  }

  async function startRun(ctx: ExtensionCommandContext): Promise<void> {
    if (active) {
      notify(ctx, "autoresearch already running; /autoresearch stop first", "warning");
      return;
    }
    const repoRoot = ctx.cwd;
    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    let manifest;
    try {
      manifest = readManifest(repoRoot);
    } catch (err) {
      notify(ctx, err instanceof Error ? err.message : String(err), "error");
      return;
    }

    // First run in this repo: init (setup agent) with a confirm when interactive.
    if (!loadState(stateDir)) {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          `Initialize autoresearch for "${manifest.name}"?`,
          `setup: ${manifest.setupCommand}\nbench: ${manifest.benchmarkCommand}\neditable: ${manifest.editablePaths.join(", ")}\n\nThis runs dependency setup and a baseline benchmark.`,
        );
        if (!ok) return;
      }
      const config = loadConfig(stateDir);
      try {
        await initChallenge({
          repoRoot,
          runner: makeRunner(config.runner, stateDir),
          exec: nodeExec,
          emit: (msg) => notify(ctx, msg),
        });
      } catch (err) {
        notify(ctx, `init failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
    }

    const config = loadConfig(stateDir);
    // The scripted mock playlist covers ~6 loops (submit, god trigger,
    // post-god improvement) then idles forever; cap the demo so it terminates.
    if (config.runner === "mock" && config.maxLoops === null) config.maxLoops = 8;
    const state = loadState(stateDir)!;
    const controller = new AbortController();
    const orchestrator = new Orchestrator(repoRoot, stateDir, config, {
      runner: makeRunner(config.runner, stateDir),
      adapter: new YukonCliAdapter({
        repoRoot,
        manifest,
        cli: detectCli(repoRoot, manifest),
        verifyCommand: state.challenge.verifyCommand,
        benchCommand: state.challenge.benchCommand,
        execution: config.execution,
        logDir: statePaths(stateDir).logsDir,
        exec: nodeExec,
      }),
      exec: nodeExec,
      emit: (ev) => surfaceEvent(ctx, ev),
      signal: controller.signal,
    });

    // Fire-and-forget: the loop must not block pi's turn. Mock agents make no
    // LLM calls so they never contend with the interactive session.
    const running = orchestrator
      .runUntilDone()
      .then(() => {
        const phase = orchestrator.status().phase;
        notify(ctx, `autoresearch stopped (phase: ${phase})`);
      })
      .catch((err) => {
        notify(ctx, `autoresearch crashed: ${err instanceof Error ? err.message : String(err)}`, "error");
      })
      .finally(() => {
        active = null;
        if (ctx.hasUI) {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          ctx.ui.setStatus(WIDGET_KEY, undefined);
        }
      });

    active = { controller, orchestrator, challengeName: state.challenge.name, running };
    if (ctx.hasUI) ctx.ui.setStatus(WIDGET_KEY, "autoresearch: running");
    notify(ctx, `autoresearch loop started for ${state.challenge.name} (runner: ${config.runner})`);
    updateWidget(ctx);

    // In headless print mode, pi exits when the handler returns — block until done.
    if (!ctx.hasUI) await running;
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
    const state = loadState(stateDir);
    if (!state) {
      notify(ctx, "no autoresearch state in this repo; run /autoresearch first", "warning");
      return;
    }
    const lines = active
      ? renderStatusLines(active.challengeName, active.orchestrator.status())
      : renderStatusLines(state.challenge.name, {
          phase: state.phase,
          loop: state.loop,
          bestScore: state.bestScore,
          bestSubmittedScore: state.bestSubmittedScore,
          dryLoopStreak: state.dryLoopStreak,
          godTriggerThreshold: loadConfig(stateDir).godTriggerThreshold,
          ideas: state.ideas.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            verifyAttempts: i.verifyAttempts,
            localScore: i.localScore,
          })),
          taskboardOpen: 0,
          lastAdvisorNotes: state.history[state.history.length - 1]?.advisorNotes ?? [],
        });
    notify(ctx, lines.join("\n"));
  }

  /** Bundled role prompts plus per-challenge overrides in .autoresearch/prompts/. */
  function listPromptFiles(repoRoot: string): { label: string; value: string }[] {
    const bundled = path.join(import.meta.dirname, "prompts");
    const custom = path.join(repoRoot, STATE_DIR_NAME, "prompts");
    const entries: { label: string; value: string }[] = [];
    for (const [dir, prefix] of [
      [bundled, ""],
      [custom, `${STATE_DIR_NAME}/prompts/`],
    ] as const) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
        entries.push({ label: `${prefix}${file}${prefix ? "" : " (bundled)"}`, value: `${prefix}${file}` });
      }
    }
    return entries;
  }

  async function editSettingDialog(ctx: ExtensionCommandContext, config: ReturnType<typeof loadConfig>, field: EditableSettingField): Promise<void> {
    const prompts: Record<EditableSettingField, [title: string, current: string]> = {
      maxIdeasPerLoop: ["Max ideas the professor may propose per loop:", String(config.maxIdeasPerLoop)],
      godTriggerThreshold: ["Dry loops before God (0 disables):", String(config.godTriggerThreshold)],
      maxVerifyAttempts: ["Verify attempts per idea before giving up:", String(config.maxVerifyAttempts)],
      maxLoops: ["Max loops (empty = unlimited):", config.maxLoops === null ? "" : String(config.maxLoops)],
      minImprovement: ["Relative epsilon for meaningful improvement:", String(config.minImprovement)],
      mockLoopDelayMs: ["Pause after each mock loop in milliseconds (0 disables):", String(config.mockLoopDelayMs)],
      setupTimeoutMs: ["Setup command timeout in milliseconds:", String(config.execution.setupTimeoutMs)],
      verifyTimeoutMs: ["Verify command timeout in milliseconds:", String(config.execution.verifyTimeoutMs)],
      benchmarkTimeoutMs: [
        "Benchmark command timeout in milliseconds:",
        String(config.execution.benchmarkTimeoutMs),
      ],
      watchdogFile: ["Advisor watchdog file (repo-relative):", config.advisor.watchdogFile],
      submitModelName: ["Model name for submit --model (empty = none):", config.submitModelName ?? ""],
    };
    const [title, current] = prompts[field];
    const value = await ctx.ui.input(title, current);
    if (value === undefined) return;
    const trimmed = value.trim();
    const asInt = Number(trimmed);
    switch (field) {
      case "maxIdeasPerLoop":
        if (Number.isInteger(asInt) && asInt > 0) config.maxIdeasPerLoop = asInt;
        break;
      case "godTriggerThreshold":
        if (Number.isInteger(asInt) && asInt >= 0) config.godTriggerThreshold = asInt;
        break;
      case "maxVerifyAttempts":
        if (Number.isInteger(asInt) && asInt > 0) config.maxVerifyAttempts = asInt;
        break;
      case "maxLoops":
        if (trimmed === "") config.maxLoops = null;
        else if (Number.isInteger(asInt) && asInt > 0) config.maxLoops = asInt;
        break;
      case "minImprovement":
        if (Number.isFinite(asInt) && asInt >= 0) config.minImprovement = asInt;
        break;
      case "mockLoopDelayMs":
        if (Number.isInteger(asInt) && asInt >= 0) config.mockLoopDelayMs = asInt;
        break;
      case "setupTimeoutMs":
        if (Number.isInteger(asInt) && asInt > 0) config.execution.setupTimeoutMs = asInt;
        break;
      case "verifyTimeoutMs":
        if (Number.isInteger(asInt) && asInt > 0) config.execution.verifyTimeoutMs = asInt;
        break;
      case "benchmarkTimeoutMs":
        if (Number.isInteger(asInt) && asInt > 0) config.execution.benchmarkTimeoutMs = asInt;
        break;
      case "watchdogFile":
        if (trimmed) config.advisor.watchdogFile = trimmed;
        break;
      case "submitModelName":
        config.submitModelName = trimmed || undefined;
        break;
    }
  }

  async function editConfig(ctx: ExtensionCommandContext): Promise<void> {
    const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
    const config = loadConfig(stateDir);
    if (!ctx.hasUI) {
      const summary = [
        `runner: ${config.runner}`,
        `maxIdeasPerLoop: ${config.maxIdeasPerLoop}`,
        `godTriggerThreshold: ${config.godTriggerThreshold}`,
        `maxVerifyAttempts: ${config.maxVerifyAttempts}`,
        `mockLoopDelayMs: ${config.mockLoopDelayMs}`,
        `setupTimeoutMs: ${config.execution.setupTimeoutMs}`,
        `verifyTimeoutMs: ${config.execution.verifyTimeoutMs}`,
        `benchmarkTimeoutMs: ${config.execution.benchmarkTimeoutMs}`,
        `advisor: ${config.advisor.enabled ? "enabled" : "disabled"} (${config.advisor.watchdogFile})`,
        ...CONFIGURABLE_ROLES.map(
          (role) =>
            `role ${role}: ${config.roles[role].model}${config.roles[role].thinking ? ` (${config.roles[role].thinking})` : ""} · ${config.roles[role].prompt ?? `${role}.md`}`,
        ),
      ].join("\n");
      console.log(summary);
      return;
    }

    // Loop: the panel closes for input/select dialogs (they can't stack on
    // ui.custom) and reopens at the same nav position afterwards.
    let nav: NavState = { pane: "left", left: 0, right: 0 };
    for (;;) {
      const result = await ctx.ui.custom<ConfigPanelResult>((tui, theme, _kb, done) => new ConfigPanel(config, nav, tui, theme, done));
      if (result.type === "close") break;
      nav = result.nav;
      switch (result.type) {
        case "editModel": {
          const value = await ctx.ui.input(`Model for ${result.role} (provider/model):`, config.roles[result.role].model);
          if (value?.trim()) config.roles[result.role].model = value.trim();
          break;
        }
        case "editPrompt": {
          const files = listPromptFiles(ctx.cwd);
          const current = config.roles[result.role].prompt ?? `${result.role}.md`;
          const choice = await ctx.ui.select(
            `Prompt for ${result.role} (current: ${current})`,
            files.map((f) => f.label),
          );
          const picked = files.find((f) => f.label === choice);
          if (picked) config.roles[result.role].prompt = picked.value;
          break;
        }
        case "editSetting":
          await editSettingDialog(ctx, config, result.field);
          break;
      }
    }
    fs.mkdirSync(stateDir, { recursive: true });
    saveConfig(stateDir, config);
    notify(ctx, "config saved to .autoresearch/config.json");
  }

  async function stopRun(ctx: ExtensionCommandContext): Promise<void> {
    if (!active) {
      notify(ctx, "no autoresearch loop running", "warning");
      return;
    }
    active.controller.abort();
    await active.running;
    notify(ctx, "autoresearch paused; /autoresearch run to resume");
  }

  pi.registerCommand("autoresearch", {
    description: "AutoResearch harness: run|status|config|stop (default: run)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["run", "status", "config", "stop"]
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!isVersionAtLeast(piVersion, MIN_PI_VERSION)) {
        notify(
          ctx,
          `kydoresearch requires Pi ${MIN_PI_VERSION} or newer (running ${piVersion}). ` +
            "Run `pi update`, restart Pi, then retry /autoresearch.",
          "error",
        );
        return;
      }
      const sub = (args ?? "").trim().split(/\s+/)[0] || "run";
      switch (sub) {
        case "run":
          return startRun(ctx);
        case "status":
          return showStatus(ctx);
        case "config":
          return editConfig(ctx);
        case "stop":
          return stopRun(ctx);
        default:
          notify(ctx, `unknown subcommand "${sub}" — use run|status|config|stop`, "warning");
      }
    },
  });

  return {
    restoreWidget: (ctx: ExtensionContext) => {
      // After pi restart, show paused/resumable state in the footer.
      const state = loadState(path.join(ctx.cwd, STATE_DIR_NAME));
      if (state && ctx.hasUI && state.phase !== "done") {
        ctx.ui.setStatus(WIDGET_KEY, `autoresearch: ${state.phase} (loop ${state.loop}) — /autoresearch to resume`);
      }
    },
  };
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}
