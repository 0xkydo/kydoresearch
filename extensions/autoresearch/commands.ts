import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
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
import { initChallenge, type InitProgress } from "../../src/init.ts";
import {
  loadMetaHarnessStatus,
  MetaHarnessController,
} from "../../src/metaharness.ts";
import type { OrchestratorEvent, StatusReport } from "../../src/orchestrator.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import { loadState, STATE_DIR_NAME, statePaths } from "../../src/state.ts";
import { Taskboard } from "../../src/taskboard.ts";
import {
  clearOperatorSteering,
  loadOperatorSteering,
  setOperatorSteering,
} from "../../src/steering.ts";
import { readTelemetry, renderTelemetryReport } from "../../src/telemetry.ts";
import type {
  ConfigPanelResult,
  ConfigurableRole,
  EditableSettingField,
  NavState,
} from "./config-ui.ts";
import { ConfigPanel, CONFIGURABLE_ROLES } from "./config-ui.ts";
import { renderCandidateInspection, renderCandidateList } from "./inspect.ts";
import {
  renderInitializationDashboardLines,
  renderInitializationLines,
  renderStatusDashboardLines,
  renderStatusLines,
  type InitializationRenderState,
  type StatusRenderOptions,
} from "./widget.ts";

const WIDGET_KEY = "autoresearch";
export const MIN_PI_VERSION = "0.75.0";

export interface AutoresearchCommandOptions {
  /** Injectable for compatibility regression tests; production uses Pi's runtime version. */
  piVersion?: string;
}

interface RunHandle {
  controller: AbortController;
  orchestrator: { status(): StatusReport; runUntilDone(): Promise<void> };
  challengeName: string;
  stateDir: string;
  running: Promise<void>;
  recentActivity: string[];
}

/** Registers /autoresearch and its run, steering, inspection, and config controls. */
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

  function operatorSteeringForUi(stateDir: string) {
    try {
      return loadOperatorSteering(stateDir);
    } catch {
      // A display refresh must not become a new failure mode for the durable
      // loop. The Professor checkpoint still validates the file strictly.
      return null;
    }
  }

  function setPersistentWidget(
    ctx: ExtensionContext,
    plainLines: string[],
    themedLines: (width: number, theme: Theme) => string[],
  ): void {
    if (!ctx.hasUI) return;
    const placement = { placement: "belowEditor" as const };
    // Pi added ctx.mode after the custom widget API. Treat an absent mode from
    // older supported Pi releases as interactive; only RPC requires the
    // serializable string-array fallback.
    if (ctx.mode !== "rpc") {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
          render: (width: number) => themedLines(width, theme),
          invalidate() {},
        }),
        placement,
      );
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, plainLines, placement);
  }

  function setResearchDashboard(
    ctx: ExtensionContext,
    challengeName: string,
    report: StatusReport,
    options: StatusRenderOptions,
  ): void {
    setPersistentWidget(
      ctx,
      renderStatusLines(challengeName, report, options),
      (width, theme) =>
        renderStatusDashboardLines(challengeName, report, width, theme, options),
    );
  }

  function setInitializationDashboard(
    ctx: ExtensionContext,
    challengeName: string,
    state: InitializationRenderState,
  ): void {
    setPersistentWidget(
      ctx,
      renderInitializationLines(challengeName, state),
      (width, theme) =>
        renderInitializationDashboardLines(challengeName, state, width, theme),
    );
  }

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI || !active) return;
    setResearchDashboard(
      ctx,
      active.challengeName,
      active.orchestrator.status(),
      {
        recentActivity: active.recentActivity,
        operatorSteering: operatorSteeringForUi(active.stateDir),
        running: true,
      },
    );
  }

  function makeRunner(runnerKind: "mock" | "subprocess", stateDir: string): AgentRunner {
    return runnerKind === "subprocess" ? new PiSubprocessRunner(loadConfig(stateDir).roles) : new MockAgentRunner();
  }

  function surfaceEvent(ctx: ExtensionContext, ev: OrchestratorEvent) {
    if (active) {
      active.recentActivity.unshift(activityFromEvent(ev));
      active.recentActivity = active.recentActivity.filter(Boolean).slice(0, 3);
    }
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
      case "church":
        notify(ctx, `the Professor went to church after loop ${ev.loop} — see ${ev.noteFile}`, "warning");
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
    const detectedCli = detectCli(repoRoot, manifest);
    const preflightConfig = loadConfig(stateDir);
    if (detectedCli === "mlxfast" && !preflightConfig.submitModelName?.trim()) {
      notify(
        ctx,
        'MLX Fast requires exact model attribution before the loop can submit. ' +
          'Open /autoresearch config → settings → submit model and enter the underlying model name ' +
          '(for this Codex agent: "GPT 5.6 Sol"), then retry /autoresearch.',
        "error",
      );
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
      let initialization: InitializationRenderState = {
        stage: "setup",
        status: "running",
        message: "preparing challenge initialization",
        command: manifest.setupCommand,
        logPath: path.join(STATE_DIR_NAME, "logs", "setup.log"),
        recentActivity: [],
      };
      const showInitialization = (progress: InitProgress): void => {
        const activity = initialization.recentActivity;
        const event = initializationActivity(progress);
        initialization = {
          ...progress,
          logPath: progress.logPath
            ? displayPath(repoRoot, progress.logPath)
            : initialization.logPath,
          recentActivity: event
            ? [event, ...activity.filter((entry) => entry !== event)].slice(0, 3)
            : activity,
        };
        if (ctx.hasUI) {
          setInitializationDashboard(ctx, manifest.name, initialization);
          ctx.ui.setStatus(
            WIDGET_KEY,
            `autoresearch: initializing (${progress.stage})`,
          );
        }
      };
      if (ctx.hasUI) {
        setInitializationDashboard(ctx, manifest.name, initialization);
        ctx.ui.setStatus(WIDGET_KEY, "autoresearch: initializing");
      }
      try {
        await initChallenge({
          repoRoot,
          runner: makeRunner(config.runner, stateDir),
          exec: nodeExec,
          emit: (msg) => notify(ctx, msg),
          onProgress: showInitialization,
        });
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        initialization = {
          ...initialization,
          status: "failed",
          message: initializationFailureStage(initialization.stage),
          failure,
          recentActivity: [
            `initialization stopped: ${firstDisplayLine(failure)}`,
            ...initialization.recentActivity,
          ].slice(0, 3),
        };
        if (ctx.hasUI) {
          setInitializationDashboard(ctx, manifest.name, initialization);
          ctx.ui.setStatus(WIDGET_KEY, "autoresearch: initialization failed");
        }
        notify(ctx, `init failed: ${failure}`, "error");
        return;
      }
    }

    const config = loadConfig(stateDir);
    // The scripted mock playlist covers ~6 loops (submit, god trigger,
    // post-god improvement) then idles forever; cap the demo so it terminates.
    if (config.runner === "mock" && config.maxLoops === null) config.maxLoops = 8;
    const state = loadState(stateDir)!;
    const controller = new AbortController();
    const runner = makeRunner(config.runner, stateDir);
    const ports = {
      runner,
      adapter: new YukonCliAdapter({
        repoRoot,
        manifest,
        cli: detectedCli,
        verifyCommand: state.challenge.verifyCommand,
        benchCommand: state.challenge.benchCommand,
        execution: config.execution,
        logDir: statePaths(stateDir).logsDir,
        exec: nodeExec,
      }),
      exec: nodeExec,
      emit: (ev: OrchestratorEvent) => surfaceEvent(ctx, ev),
      signal: controller.signal,
    };
    let orchestrator: RunHandle["orchestrator"];
    try {
      orchestrator = config.metaHarness.enabled
        ? await MetaHarnessController.create(repoRoot, stateDir, config, ports)
        : new Orchestrator(repoRoot, stateDir, config, ports);
    } catch (error) {
      notify(
        ctx,
        `failed to start ${config.metaHarness.enabled ? "metaharness" : "autoresearch"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error",
      );
      return;
    }

    // Install the handle before starting so synchronous phase events are not
    // lost from the live activity feed.
    const runHandle: RunHandle = {
      controller,
      orchestrator,
      challengeName: state.challenge.name,
      stateDir,
      running: Promise.resolve(),
      recentActivity: readRecentActivity(stateDir),
    };
    active = runHandle;

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
        if (active === runHandle) {
          const finalReport = orchestrator.status();
          if (ctx.hasUI) {
            setResearchDashboard(
              ctx,
              state.challenge.name,
              finalReport,
              {
                recentActivity: runHandle.recentActivity,
                operatorSteering: operatorSteeringForUi(stateDir),
                running: false,
              },
            );
            ctx.ui.setStatus(
              WIDGET_KEY,
              `autoresearch: ${finalReport.phase} (loop ${finalReport.loop})`,
            );
          }
          active = null;
        }
      });

    runHandle.running = running;
    if (ctx.hasUI) ctx.ui.setStatus(WIDGET_KEY, "autoresearch: running");
    notify(
      ctx,
      `autoresearch loop started for ${state.challenge.name} ` +
        `(runner: ${config.runner}${config.metaHarness.enabled ? ", metaharness: enabled" : ""})`,
    );
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
      ? renderStatusLines(active.challengeName, active.orchestrator.status(), {
          recentActivity: active.recentActivity,
          operatorSteering: operatorSteeringForUi(stateDir),
          running: true,
        })
      : renderStatusLines(state.challenge.name, statusFromState(stateDir, state), {
          recentActivity: readRecentActivity(stateDir),
          operatorSteering: operatorSteeringForUi(stateDir),
          running: false,
        });
    notify(ctx, lines.join("\n"));
  }

  async function steerResearch(
    ctx: ExtensionCommandContext,
    requestedDirection: string,
  ): Promise<void> {
    const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
    const state = loadState(stateDir);
    if (!state) {
      notify(
        ctx,
        "no autoresearch state in this repo; run /autoresearch first",
        "warning",
      );
      return;
    }

    let direction = requestedDirection.trim();
    if (!direction && ctx.hasUI) {
      direction =
        (
          await ctx.ui.input(
            "Steer the next Professor portfolio:",
            operatorSteeringForUi(stateDir)?.text ?? "",
          )
        )?.trim() ?? "";
    }
    if (!direction) {
      notify(
        ctx,
        "usage: /autoresearch steer <direction> (or /autoresearch steer clear)",
        "warning",
      );
      return;
    }

    if (direction.toLowerCase() === "clear") {
      clearOperatorSteering(stateDir);
      notify(ctx, "operator direction cleared; future Professor tasks are evidence-led");
    } else {
      const steering = setOperatorSteering(stateDir, direction);
      const currentPhase = active?.orchestrator.status().phase ?? state.phase;
      const appliesNextLoop =
        currentPhase === "loop.proposing" ||
        currentPhase === "loop.ideas" ||
        currentPhase === "loop.finalizing" ||
        currentPhase === "loop.end" ||
        currentPhase === "church" ||
        currentPhase === "god";
      notify(
        ctx,
        `operator direction saved: ${firstDisplayLine(steering.text)} · ` +
          (appliesNextLoop
            ? "the current portfolio is immutable, so this takes effect at the next Professor proposal"
            : "this will be snapshotted into the next Professor proposal"),
      );
    }

    if (active) {
      updateWidget(ctx);
    } else {
      setResearchDashboard(
        ctx,
        state.challenge.name,
        statusFromState(stateDir, state),
        {
          recentActivity: readRecentActivity(stateDir),
          operatorSteering: operatorSteeringForUi(stateDir),
          running: false,
        },
      );
    }
  }

  function showCandidate(ctx: ExtensionCommandContext, candidateId?: string): void {
    const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
    const state = loadState(stateDir);
    if (!state) {
      notify(ctx, "no autoresearch state in this repo; run /autoresearch first", "warning");
      return;
    }
    notify(
      ctx,
      candidateId
        ? renderCandidateInspection(ctx.cwd, stateDir, state, candidateId)
        : renderCandidateList(stateDir, state),
    );
  }

  function showTelemetry(ctx: ExtensionCommandContext): void {
    const telemetryFile = statePaths(path.join(ctx.cwd, STATE_DIR_NAME)).telemetry;
    notify(ctx, renderTelemetryReport(readTelemetry(telemetryFile)));
  }

  /** Bundled dynamic prompts plus per-challenge prompt overrides. */
  function listPromptFiles(repoRoot: string): { label: string; value: string }[] {
    const bundledPrompts = path.join(import.meta.dirname, "prompts");
    const customRoot = path.join(repoRoot, STATE_DIR_NAME, "prompts");
    const customRoles = path.join(customRoot, "roles");
    const entries: { label: string; value: string }[] = [];
    for (const [dir, labelPrefix, valuePrefix, bundled] of [
      [bundledPrompts, "", "", true],
      [customRoles, `${STATE_DIR_NAME}/prompts/roles/`, `${STATE_DIR_NAME}/prompts/roles/`, false],
      // Keep legacy flat custom role prompts selectable.
      [customRoot, `${STATE_DIR_NAME}/prompts/`, `${STATE_DIR_NAME}/prompts/`, false],
    ] as const) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
        entries.push({
          label: `${labelPrefix}${file}${bundled ? " (bundled)" : ""}`,
          value: `${valuePrefix}${file}`,
        });
      }
    }
    return entries;
  }

  /** Bundled role soul plus per-challenge overrides in .autoresearch/agents/<role>/. */
  function listSoulFiles(
    repoRoot: string,
    role: ConfigurableRole,
  ): { label: string; value: string }[] {
    const bundled = path.join(import.meta.dirname, "agents", role);
    const custom = path.join(repoRoot, STATE_DIR_NAME, "agents", role);
    const entries: { label: string; value: string }[] = [];
    for (const [dir, prefix] of [
      [bundled, ""],
      [custom, `${STATE_DIR_NAME}/agents/${role}/`],
    ] as const) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        entries.push({
          label: `${prefix}${file}${prefix ? "" : " (bundled)"}`,
          value: `${prefix}${file}`,
        });
      }
    }
    return entries;
  }

  async function editSettingDialog(ctx: ExtensionCommandContext, config: ReturnType<typeof loadConfig>, field: EditableSettingField): Promise<void> {
    const prompts: Record<EditableSettingField, [title: string, current: string]> = {
      maxIdeasPerLoop: ["Max ideas the professor may propose per loop:", String(config.maxIdeasPerLoop)],
      churchTriggerThreshold: ["Dry loops before church (0 disables):", String(config.churchTriggerThreshold)],
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
      agentMaxAttempts: [
        "Total attempts per model task (including the first call):",
        String(config.resilience.agentMaxAttempts),
      ],
      commandMaxAttempts: [
        "Total attempts per harness command (including the first call):",
        String(config.resilience.commandMaxAttempts),
      ],
      submitMaxAttempts: [
        "Total submission attempts (including the first call):",
        String(config.resilience.submitMaxAttempts),
      ],
      maxConsecutiveLoopFailures: [
        "Consecutive failed loop resumptions before pausing:",
        String(config.resilience.maxConsecutiveLoopFailures),
      ],
      retryBaseDelayMs: [
        "Initial operation retry delay in milliseconds:",
        String(config.resilience.retryBaseDelayMs),
      ],
      retryMaxDelayMs: [
        "Maximum operation retry delay in milliseconds:",
        String(config.resilience.retryMaxDelayMs),
      ],
      loopFailureBaseDelayMs: [
        "Initial failed-loop recovery delay in milliseconds:",
        String(config.resilience.loopFailureBaseDelayMs),
      ],
      loopFailureMaxDelayMs: [
        "Maximum failed-loop recovery delay in milliseconds:",
        String(config.resilience.loopFailureMaxDelayMs),
      ],
      metaEvaluationLoops: [
        "Inner loops used to evaluate one harness profile:",
        String(config.metaHarness.evaluationLoops),
      ],
      metaMaxGenerations: [
        "Maximum harness generations (empty = unlimited):",
        config.metaHarness.maxGenerations === null
          ? ""
          : String(config.metaHarness.maxGenerations),
      ],
      metaMaxWallTimeMs: [
        "Metaharness campaign wall-time budget in milliseconds (empty = unlimited):",
        config.metaHarness.maxWallTimeMs === null
          ? ""
          : String(config.metaHarness.maxWallTimeMs),
      ],
      metaMaxRecoveryAttempts: [
        "Fatal inner-loop recovery attempts before fail-stop:",
        String(config.metaHarness.maxRecoveryAttempts),
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
      case "churchTriggerThreshold":
        if (Number.isInteger(asInt) && asInt >= 0) config.churchTriggerThreshold = asInt;
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
      case "agentMaxAttempts":
        if (Number.isInteger(asInt) && asInt > 0) config.resilience.agentMaxAttempts = asInt;
        break;
      case "commandMaxAttempts":
        if (Number.isInteger(asInt) && asInt > 0) config.resilience.commandMaxAttempts = asInt;
        break;
      case "submitMaxAttempts":
        if (Number.isInteger(asInt) && asInt > 0) config.resilience.submitMaxAttempts = asInt;
        break;
      case "maxConsecutiveLoopFailures":
        if (Number.isInteger(asInt) && asInt > 0) {
          config.resilience.maxConsecutiveLoopFailures = asInt;
        }
        break;
      case "retryBaseDelayMs":
        if (Number.isInteger(asInt) && asInt >= 0) config.resilience.retryBaseDelayMs = asInt;
        break;
      case "retryMaxDelayMs":
        if (Number.isInteger(asInt) && asInt >= 0) config.resilience.retryMaxDelayMs = asInt;
        break;
      case "loopFailureBaseDelayMs":
        if (Number.isInteger(asInt) && asInt >= 0) {
          config.resilience.loopFailureBaseDelayMs = asInt;
        }
        break;
      case "loopFailureMaxDelayMs":
        if (Number.isInteger(asInt) && asInt >= 0) {
          config.resilience.loopFailureMaxDelayMs = asInt;
        }
        break;
      case "metaEvaluationLoops":
        if (Number.isInteger(asInt) && asInt > 0) config.metaHarness.evaluationLoops = asInt;
        break;
      case "metaMaxGenerations":
        if (trimmed === "") config.metaHarness.maxGenerations = null;
        else if (Number.isInteger(asInt) && asInt > 0) config.metaHarness.maxGenerations = asInt;
        break;
      case "metaMaxWallTimeMs":
        if (trimmed === "") config.metaHarness.maxWallTimeMs = null;
        else if (Number.isInteger(asInt) && asInt > 0) config.metaHarness.maxWallTimeMs = asInt;
        break;
      case "metaMaxRecoveryAttempts":
        if (Number.isInteger(asInt) && asInt >= 0) config.metaHarness.maxRecoveryAttempts = asInt;
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
        `churchTriggerThreshold: ${config.churchTriggerThreshold}`,
        `maxVerifyAttempts: ${config.maxVerifyAttempts}`,
        `mockLoopDelayMs: ${config.mockLoopDelayMs}`,
        `setupTimeoutMs: ${config.execution.setupTimeoutMs}`,
        `verifyTimeoutMs: ${config.execution.verifyTimeoutMs}`,
        `benchmarkTimeoutMs: ${config.execution.benchmarkTimeoutMs}`,
        `agentMaxAttempts: ${config.resilience.agentMaxAttempts}`,
        `commandMaxAttempts: ${config.resilience.commandMaxAttempts}`,
        `submitMaxAttempts: ${config.resilience.submitMaxAttempts}`,
        `maxConsecutiveLoopFailures: ${config.resilience.maxConsecutiveLoopFailures}`,
        `retryBackoffMs: ${config.resilience.retryBaseDelayMs}..${config.resilience.retryMaxDelayMs}`,
        `loopFailureBackoffMs: ${config.resilience.loopFailureBaseDelayMs}..${config.resilience.loopFailureMaxDelayMs}`,
        `metaHarness: ${config.metaHarness.enabled ? "enabled" : "disabled"} ` +
          `(eval loops ${config.metaHarness.evaluationLoops}, generations ${
            config.metaHarness.maxGenerations ?? "unlimited"
          }, wall ${config.metaHarness.maxWallTimeMs ?? "unlimited"}ms)`,
        `advisor: ${config.advisor.enabled ? "enabled" : "disabled"} (${config.advisor.watchdogFile})`,
        ...CONFIGURABLE_ROLES.map(
          (role) =>
            `role ${role}: ${config.roles[role].model}${config.roles[role].thinking ? ` (${config.roles[role].thinking})` : ""} · soul ${config.roles[role].soul ?? "SOUL.md"} · prompt ${config.roles[role].prompt ?? `${role}.md`}`,
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
          const current = config.roles[result.role].model;
          const models = ctx.modelRegistry
            .getAvailable()
            .map((model) => ({
              label:
                model.name && model.name !== model.id
                  ? `${model.provider}/${model.id} — ${model.name}`
                  : `${model.provider}/${model.id}`,
              value: `${model.provider}/${model.id}`,
            }))
            .sort((left, right) => {
              if (left.value === current) return -1;
              if (right.value === current) return 1;
              return left.value.localeCompare(right.value);
            });
          if (models.length === 0) {
            notify(
              ctx,
              "no available models found; use /login to configure a provider, then reopen config",
              "warning",
            );
            break;
          }
          const choice = await ctx.ui.select(
            `Model for ${result.role} (current: ${current})`,
            models.map((model) => model.label),
          );
          const picked = models.find((model) => model.label === choice);
          if (picked) config.roles[result.role].model = picked.value;
          break;
        }
        case "editSoul": {
          const files = listSoulFiles(ctx.cwd, result.role);
          const current = config.roles[result.role].soul ?? "SOUL.md";
          const choice = await ctx.ui.select(
            `Soul for ${result.role} (current: ${current})`,
            files.map((file) => file.label),
          );
          const picked = files.find((file) => file.label === choice);
          if (picked) config.roles[result.role].soul = picked.value;
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
    description: "AutoResearch harness: run|status|steer|inspect|telemetry|config|stop (default: run)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["run", "status", "steer", "inspect", "telemetry", "config", "stop"]
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
      const [sub = "run", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      switch (sub) {
        case "run":
          return startRun(ctx);
        case "status":
          return showStatus(ctx);
        case "steer":
          return steerResearch(ctx, rest.join(" "));
        case "inspect":
          return showCandidate(ctx, rest[0]);
        case "telemetry":
          return showTelemetry(ctx);
        case "config":
          return editConfig(ctx);
        case "stop":
          return stopRun(ctx);
        default:
          notify(
            ctx,
            `unknown subcommand "${sub}" — use run|status|steer|inspect|telemetry|config|stop`,
            "warning",
          );
      }
    },
  });

  return {
    restoreWidget: (ctx: ExtensionContext) => {
      // After a Pi restart, restore the last durable dashboard even though no
      // worker process is active.
      const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
      const state = loadState(stateDir);
      if (state && ctx.hasUI) {
        setResearchDashboard(
          ctx,
          state.challenge.name,
          statusFromState(stateDir, state),
          {
            recentActivity: readRecentActivity(stateDir),
            operatorSteering: operatorSteeringForUi(stateDir),
            running: false,
          },
        );
        ctx.ui.setStatus(
          WIDGET_KEY,
          state.phase === "done"
            ? `autoresearch: done (loop ${state.loop})`
            : `autoresearch: ${state.phase} (loop ${state.loop}) — /autoresearch to resume`,
        );
      }
    },
  };
}

function statusFromState(
  stateDir: string,
  state: NonNullable<ReturnType<typeof loadState>>,
): StatusReport {
  const config = loadConfig(stateDir);
  const metaHarness = loadMetaHarnessStatus(stateDir);
  return {
    phase: state.phase,
    loop: state.loop,
    scoreDirection: state.challenge.direction,
    bestScore: state.bestScore,
    bestSubmittedScore: state.bestSubmittedScore,
    dryLoopStreak: state.dryLoopStreak,
    churchTriggerThreshold: config.churchTriggerThreshold,
    ideas: state.ideas.map((idea) => ({
      id: idea.id,
      title: idea.title,
      parentCandidateId: idea.parentCandidateId,
      status: idea.status,
      verifyAttempts: idea.verifyAttempts,
      maxVerifyAttempts: config.maxVerifyAttempts,
      comparisonScore: idea.comparisonScore,
      localScore: idea.localScore,
      lastVerifyError: idea.lastVerifyError,
    })),
    taskboardOpen: new Taskboard(stateDir).openCount(),
    lastAdvisorNotes: state.history[state.history.length - 1]?.advisorNotes ?? [],
    ...(state.challenge.localEvaluation
      ? { localEvaluation: state.challenge.localEvaluation }
      : {}),
    recovery: state.recovery,
    ...(metaHarness ? { metaHarness } : {}),
  };
}

function activityFromEvent(event: OrchestratorEvent): string {
  switch (event.type) {
    case "phase":
      return `loop ${event.loop} · phase → ${event.phase}`;
    case "idea":
      return `${event.idea.id} · ${event.message}`;
    case "advice":
      return `advisor · ${event.notes.length} note(s) after loop ${event.loop}`;
    case "church":
      return `church reflection saved · ${event.noteFile}`;
    case "submitted":
      return `${event.ideaId} · submitted score ${event.score}`;
    case "log":
      return event.message;
  }
}

function readRecentActivity(stateDir: string): string[] {
  const journalPath = statePaths(stateDir).journal;
  if (!fs.existsSync(journalPath)) return [];
  const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean);
  const activity: string[] = [];
  for (let index = lines.length - 1; index >= 0 && activity.length < 3; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]!) as Record<string, unknown>;
      const rendered =
        typeof entry.message === "string"
          ? typeof entry.idea === "string"
            ? `${entry.idea} · ${entry.message}`
            : entry.message
          : typeof entry.phase === "string"
            ? `loop ${String(entry.loop ?? "?")} · phase → ${entry.phase}`
            : "";
      if (rendered && !activity.includes(rendered)) activity.push(rendered);
    } catch {
      // The journal is append-only operational history. A partial final line
      // after an interrupted process should not hide the rest of the dashboard.
    }
  }
  return activity;
}

function initializationActivity(progress: InitProgress): string {
  const attempt =
    progress.attempt !== undefined
      ? ` · attempt ${progress.attempt}${progress.maxAttempts ? `/${progress.maxAttempts}` : ""}`
      : "";
  return `${progress.stage} · ${progress.status}${attempt} · ${progress.message}`;
}

function initializationFailureStage(
  stage: InitializationRenderState["stage"],
): string {
  switch (stage) {
    case "setup":
      return "challenge dependency setup failed";
    case "setup-agent":
      return "Setup agent could not complete its repository decision";
    case "baseline":
      return "local baseline benchmark failed";
    case "baseline-review":
      return "Setup could not choose a supported baseline recovery";
    case "ready":
      return "initialization failed while saving ready state";
  }
}

function displayPath(repoRoot: string, value: string): string {
  const relative = path.relative(repoRoot, value);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    ? relative
    : value;
}

function firstDisplayLine(value: string): string {
  return value.trim().split("\n")[0] ?? value;
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
