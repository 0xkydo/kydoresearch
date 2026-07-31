import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadAgentInvocations,
  type AgentInvocationSummary,
} from "../../src/agent-activity.ts";
import { MockAgentRunner } from "../../src/agents/mock.ts";
import { PiSubprocessRunner } from "../../src/agents/subprocess.ts";
import type {
  AgentActivityEvent,
  AgentActivityObserver,
  AgentRunner,
} from "../../src/agents/types.ts";
import { YukonCliAdapter } from "../../src/challenge/adapter.ts";
import { detectCli, readManifest } from "../../src/challenge/detect.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { nodeExec } from "../../src/exec.ts";
import {
  excludeAutoresearchStateFromGit,
  initChallenge,
  type InitProgress,
} from "../../src/init.ts";
import {
  completeInitializationReport,
  createInitializationReport,
  failInitializationReport,
  InitializationError,
  loadInitializationReport,
  saveInitializationReport,
  updateInitializationStep,
  type InitializationDiagnosticV1,
  type InitializationReportV1,
  type InitializationStepId,
} from "../../src/initialization.ts";
import {
  loadMetaHarnessStatus,
  MetaHarnessController,
  VerifierDriftError,
} from "../../src/metaharness.ts";
import type { OrchestratorEvent, StatusReport } from "../../src/orchestrator.ts";
import {
  loadRunOverviewStatus,
  Orchestrator,
} from "../../src/orchestrator.ts";
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
import {
  ALL_CONFIGURABLE_ROLES,
  applyConfigSetting,
  ConfigPanel,
} from "./config-ui.ts";
import { renderCandidateInspection, renderCandidateList } from "./inspect.ts";
import {
  activeProfileRoles,
  onboardingCheckpointMatches,
  renderSetupPlan,
  saveOnboardingCheckpoint,
  validateActiveProfiles,
} from "./onboarding.ts";
import {
  renderInitializationDashboardLines,
  renderInitializationLines,
  renderStatusDashboardLines,
  renderStatusLines,
  type InitializationRenderState,
  type StatusRenderOptions,
} from "./widget.ts";
import {
  AgentMonitorModel,
  renderAgentMonitor,
  type MonitorAgent,
} from "./agent-monitor.ts";
import {
  ResearchEditor,
  type ResearchEditorMode,
  type ResearchNavigationAction,
} from "./research-editor.ts";
import {
  PiTraceFileTailer,
  type MonitorTraceEvent,
} from "./trace-view.ts";

const WIDGET_KEY = "autoresearch";
const MONITOR_WIDGET_KEY = "autoresearch-agents";
export const MIN_PI_VERSION = "0.75.0";
type PiEditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

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
  monitor: AgentMonitorModel;
  traceTailers: Map<string, PiTraceFileTailer>;
  traceEvents: Map<string, MonitorTraceEvent[]>;
  monitorTimer?: NodeJS.Timeout;
  renderTimer?: NodeJS.Timeout;
  restoreEditor?: () => void;
  editorMode: ResearchEditorMode;
  maxVerifyAttempts: number;
}

/** Registers /autoresearch and its run, steering, inspection, and config controls. */
export function registerAutoresearchCommand(
  pi: ExtensionAPI,
  options: AutoresearchCommandOptions = {},
): {
  restoreWidget: (ctx: ExtensionContext) => void;
  resumeAfterSupervisorRestart: (ctx: ExtensionContext) => Promise<void>;
} {
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
    placement: "aboveEditor" | "belowEditor" = "belowEditor",
    key = WIDGET_KEY,
  ): void {
    if (!ctx.hasUI) return;
    const widgetPlacement = { placement };
    // Pi added ctx.mode after the custom widget API. Treat an absent mode from
    // older supported Pi releases as interactive; only RPC requires the
    // serializable string-array fallback.
    if (ctx.mode !== "rpc") {
      ctx.ui.setWidget(
        key,
        (_tui, theme) => ({
          render: (width: number) => themedLines(width, theme),
          invalidate() {},
        }),
        widgetPlacement,
      );
      return;
    }
    ctx.ui.setWidget(key, plainLines, widgetPlacement);
  }

  function setResearchDashboard(
    ctx: ExtensionContext,
    challengeName: string,
    report: StatusReport,
    options: StatusRenderOptions,
  ): void {
    const runtimeOptions = {
      ...options,
      oncallSupervised: process.env.KYDO_ONCALL_SUPERVISED === "1",
    };
    setPersistentWidget(
      ctx,
      renderStatusLines(challengeName, report, runtimeOptions),
      (width, theme) =>
        renderStatusDashboardLines(challengeName, report, width, theme, runtimeOptions),
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
    refreshAgentMonitor(active, false);
    setAgentMonitorWidget(ctx, active.monitor);
    setResearchDashboard(
      ctx,
      active.challengeName,
      active.orchestrator.status(),
      {
        recentActivity: active.recentActivity,
        operatorSteering: operatorSteeringForUi(active.stateDir),
        running: true,
        navigator: monitorNavigator(active),
      },
    );
  }

  function setAgentMonitorWidget(
    ctx: ExtensionContext,
    monitor: AgentMonitorModel,
  ): void {
    const height = monitor.mode === "focus" ? 10 : 8;
    setPersistentWidget(
      ctx,
      renderAgentMonitor(monitor, 100, { height }),
      (width) => renderAgentMonitor(monitor, width, { height }),
      "aboveEditor",
      MONITOR_WIDGET_KEY,
    );
  }

  function installResearchEditor(
    ctx: ExtensionContext,
    handle: RunHandle,
    render: () => void,
  ): boolean {
    if (
      !ctx.hasUI ||
      ctx.mode === "rpc" ||
      typeof ctx.ui.setEditorComponent !== "function" ||
      typeof ctx.ui.getEditorComponent !== "function"
    ) {
      handle.editorMode = "type";
      handle.monitor.setNavigationActive(false);
      return false;
    }
    const previous = ctx.ui.getEditorComponent();
    const factory: PiEditorFactory = (tui, theme, keybindings) =>
      new ResearchEditor(tui, theme, keybindings, {
        onAction: (action) => {
          applyResearchNavigation(handle, action);
          render();
        },
        onModeChange: (mode) => {
          handle.editorMode = mode;
          handle.monitor.setNavigationActive(mode === "nav");
          render();
        },
      });
    ctx.ui.setEditorComponent(factory);
    let restored = false;
    handle.restoreEditor = () => {
      if (restored) return;
      restored = true;
      if (ctx.ui.getEditorComponent() === factory) {
        ctx.ui.setEditorComponent(previous);
      }
    };
    return true;
  }

  function disposeResearchUi(
    _ctx: ExtensionContext,
    handle: RunHandle,
  ): void {
    if (handle.monitorTimer) clearInterval(handle.monitorTimer);
    if (handle.renderTimer) clearTimeout(handle.renderTimer);
    handle.monitorTimer = undefined;
    handle.renderTimer = undefined;
    handle.monitor.setNavigationActive(false);
    handle.restoreEditor?.();
    handle.restoreEditor = undefined;
  }

  function makeRunner(
    runnerKind: "mock" | "subprocess",
    stateDir: string,
    observer?: AgentActivityObserver,
  ): AgentRunner {
    const config = loadConfig(stateDir);
    const runner =
      runnerKind === "subprocess"
        ? new PiSubprocessRunner(config.roles)
        : new MockAgentRunner({
            activityDelayMs: Math.min(config.mockLoopDelayMs, 350),
          });
    if (!observer) return runner;
    return {
      run: (task) =>
        runner.run({
          ...task,
          activityObserver: combineActivityObservers(
            task.activityObserver,
            observer,
          ),
        }),
    };
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
        notify(
          ctx,
          `${ev.status === "pending" ? "submission queued" : "submitted"} ${ev.ideaId} ` +
            `(score ${ev.score})${ev.submissionId ? ` as ${ev.submissionId}` : ""}`,
        );
        break;
      case "submission-result":
        notify(
          ctx,
          `remote submission ${ev.status}: ${ev.candidateId}` +
            `${ev.submissionId ? ` (${ev.submissionId})` : ""}` +
            `${ev.officialScore === undefined ? "" : ` · official score ${ev.officialScore}`}`,
          ev.status === "rejected" ? "warning" : "info",
        );
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
    const existingState = loadState(stateDir);
    let preflightConfig = loadConfig(stateDir);
    const guided =
      !existingState && ctx.hasUI && ctx.mode !== "rpc";
    if (
      guided &&
      preflightConfig.runner === "mock" &&
      (detectedCli === "mlxfast" || detectedCli === "ecdsafail")
    ) {
      preflightConfig.runner = "subprocess";
    }

    // First run in this repo: configure active profiles, validate them, then
    // preview every side-effectful initialization step before running it.
    if (!existingState) {
      const checkpointMatches = onboardingCheckpointMatches(
        stateDir,
        manifest,
        preflightConfig,
      );
      if (guided && !checkpointMatches) {
        const onboardingDraft = structuredClone(preflightConfig);
        const initialRoles = activeProfileRoles(
          onboardingDraft,
        ) as ConfigurableRole[];
        const profileReview = await runConfigPanel(
          ctx,
          onboardingDraft,
          initialRoles,
          "first-run agent profiles",
          true,
          true,
        );
        if (profileReview !== "continue") return;
        if (
          onboardingDraft.metaHarness.enabled &&
          !initialRoles.includes("metaharness")
        ) {
          const metaReview = await runConfigPanel(
            ctx,
            onboardingDraft,
            ["metaharness"],
            "optional meta-harness profile",
            true,
            true,
          );
          if (metaReview !== "continue") return;
        }
        preflightConfig = onboardingDraft;
        excludeAutoresearchStateFromGit(repoRoot);
        fs.mkdirSync(stateDir, { recursive: true });
        saveConfig(stateDir, preflightConfig);
      }

      const availableModels =
        ctx.hasUI && ctx.modelRegistry
          ? new Set(
              ctx.modelRegistry
                .getAvailable()
                .map((model) => `${model.provider}/${model.id}`),
            )
          : undefined;
      const profileErrors = validateActiveProfiles(
        repoRoot,
        preflightConfig,
        availableModels,
      );
      if (detectedCli === "mlxfast" && !preflightConfig.submitModelName?.trim()) {
        profileErrors.push(
          'MLX Fast requires exact model attribution: enter the public name under settings → submit model (for this Codex agent: "GPT 5.6 Sol").',
        );
      }
      if (profileErrors.length > 0) {
        const diagnostic: InitializationDiagnosticV1 = {
          code: "profile-unavailable",
          step: "validate",
          title: "One or more active profiles are not ready",
          reason: profileErrors.join(" "),
          action:
            "Use /login or /autoresearch config to resolve every listed profile, then retry /autoresearch.",
          evidencePath: path.join(STATE_DIR_NAME, "config.json"),
          retryable: true,
          resumesFromCheckpoint: false,
        };
        excludeAutoresearchStateFromGit(repoRoot);
        const failedReport = persistPreflightFailure(
          stateDir,
          manifest.name,
          diagnostic,
        );
        if (ctx.hasUI) {
          setInitializationDashboard(
            ctx,
            manifest.name,
            initializationRenderState(failedReport),
          );
          ctx.ui.setStatus(WIDGET_KEY, "autoresearch: profile setup required");
        }
        notify(ctx, renderDiagnosticMessage(diagnostic), "error");
        return;
      }

      if (ctx.hasUI) {
        const title = checkpointMatches
          ? `Resume initialization for "${manifest.name}"?`
          : `Initialize autoresearch for "${manifest.name}"?`;
        const ok = await ctx.ui.confirm(
          title,
          renderSetupPlan(manifest, preflightConfig),
        );
        if (!ok) return;
      }
      saveOnboardingCheckpoint(stateDir, manifest, preflightConfig);
      const config = preflightConfig;
      let report =
        (checkpointMatches ? loadInitializationReport(stateDir) : null) ??
        createInitializationReport(manifest.name);
      saveInitializationReport(stateDir, report);
      let initialization: InitializationRenderState = {
        stage: "validate",
        status: "running",
        message: "preparing challenge validation",
        recentActivity: [],
        report,
      };
      const showInitialization = (progress: InitProgress): void => {
        const activity = initialization.recentActivity;
        const event = initializationActivity(progress);
        const stepId = initializationStepId(progress.stage);
        report = updateInitializationStep(
          report,
          {
            id: stepId,
            status: initializationStepStatus(progress.status),
            detail: progress.message,
            ...(progress.command ? { command: progress.command } : {}),
            ...(progress.logPath
              ? { logPath: displayPath(repoRoot, progress.logPath) }
              : {}),
            ...(progress.attempt !== undefined
              ? { attempt: progress.attempt }
              : {}),
            ...(progress.maxAttempts !== undefined
              ? { maxAttempts: progress.maxAttempts }
              : {}),
          },
          event,
        );
        if (
          progress.baselineScore !== undefined &&
          progress.direction &&
          progress.verifyCommand &&
          progress.benchCommand &&
          progress.localEvaluation &&
          progress.evidencePath
        ) {
          report = completeInitializationReport(report, {
            readiness:
              progress.localEvaluation.fidelity === "full"
                ? "ready"
                : "ready-with-limitations",
            baselineScore: progress.baselineScore,
            direction: progress.direction,
            verifyCommand: progress.verifyCommand,
            benchCommand: progress.benchCommand,
            localEvaluation: progress.localEvaluation,
            submissionReady: progress.submissionReady ?? false,
            evidencePath: displayPath(repoRoot, progress.evidencePath),
          });
        }
        saveInitializationReport(stateDir, report);
        initialization = {
          ...progress,
          logPath: progress.logPath
            ? displayPath(repoRoot, progress.logPath)
            : initialization.logPath,
          recentActivity: event
            ? [event, ...activity.filter((entry) => entry !== event)].slice(0, 3)
            : activity,
          report,
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
          emit: (msg) => {
            if (!ctx.hasUI) console.log(`[autoresearch] ${msg}`);
          },
          onProgress: showInitialization,
        });
      } catch (err) {
        const diagnostic = initializationDiagnostic(
          err,
          initializationStepId(initialization.stage),
          initialization.logPath,
        );
        report = failInitializationReport(report, diagnostic);
        saveInitializationReport(stateDir, report);
        initialization = {
          ...initialization,
          status: "failed",
          message: initializationFailureStage(initialization.stage),
          failure: diagnostic.reason,
          diagnostic,
          report,
          recentActivity: [
            `initialization stopped: ${diagnostic.title}`,
            ...initialization.recentActivity,
          ].slice(0, 3),
        };
        if (ctx.hasUI) {
          setInitializationDashboard(ctx, manifest.name, initialization);
          ctx.ui.setStatus(WIDGET_KEY, "autoresearch: initialization failed");
        }
        notify(ctx, renderDiagnosticMessage(diagnostic), "error");
        return;
      }

      if (guided && report.summary) {
        const startNow = await ctx.ui.confirm(
          report.summary.readiness === "ready"
            ? "Setup complete — start research?"
            : "Setup complete with limitations — start research?",
          renderReadinessSummary(report),
        );
        if (!startNow) {
          notify(
            ctx,
            "autoresearch setup is ready; run /autoresearch when you want to start the research loop",
          );
          return;
        }
      }
    }

    const config = loadConfig(stateDir);
    if (detectedCli === "mlxfast" && !config.submitModelName?.trim()) {
      notify(
        ctx,
        'MLX Fast requires exact model attribution before the loop can submit. ' +
          'Open /autoresearch config → settings → submit model and enter the underlying model name ' +
          '(for this Codex agent: "GPT 5.6 Sol"), then retry /autoresearch.',
        "error",
      );
      return;
    }
    // The scripted mock playlist covers ~6 loops (submit, god trigger,
    // post-god improvement) then idles forever; cap the demo so it terminates.
    if (config.runner === "mock" && config.maxLoops === null) config.maxLoops = 8;
    const state = loadState(stateDir)!;
    const controller = new AbortController();
    let runHandle: RunHandle | undefined;
    const runner = makeRunner(config.runner, stateDir, (_event) => {
      if (runHandle && active === runHandle) {
        scheduleResearchRender(ctx, runHandle, () => updateWidget(ctx));
      }
    });
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
        renderRunStartupFailure(error, config.metaHarness.enabled, state),
        "error",
      );
      return;
    }

    // Install the handle before starting so synchronous phase events are not
    // lost from the live activity feed.
    runHandle = {
      controller,
      orchestrator,
      challengeName: state.challenge.name,
      stateDir,
      running: Promise.resolve(),
      recentActivity: readRecentActivity(stateDir),
      monitor: new AgentMonitorModel(),
      traceTailers: new Map(),
      traceEvents: new Map(),
      editorMode: "nav",
      maxVerifyAttempts: config.maxVerifyAttempts,
    };
    active = runHandle;
    refreshAgentMonitor(runHandle, false);
    runHandle.monitor.setNavigationActive(true);
    installResearchEditor(ctx, runHandle, () => updateWidget(ctx));
    if (ctx.hasUI) {
      setAgentMonitorWidget(ctx, runHandle.monitor);
      runHandle.monitorTimer = setInterval(() => {
        if (active === runHandle) updateWidget(ctx);
      }, 250);
      runHandle.monitorTimer.unref();
    }

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
          disposeResearchUi(ctx, runHandle);
          refreshAgentMonitor(runHandle, true);
          const finalReport = orchestrator.status();
          if (ctx.hasUI) {
            setAgentMonitorWidget(ctx, runHandle.monitor);
            setResearchDashboard(
              ctx,
              state.challenge.name,
              finalReport,
              {
                recentActivity: runHandle.recentActivity,
                operatorSteering: operatorSteeringForUi(stateDir),
                running: false,
                navigator: monitorNavigator(runHandle),
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
          oncallSupervised: process.env.KYDO_ONCALL_SUPERVISED === "1",
        })
      : renderStatusLines(state.challenge.name, statusFromState(stateDir, state), {
          recentActivity: readRecentActivity(stateDir),
          operatorSteering: operatorSteeringForUi(stateDir),
          running: false,
          oncallSupervised: process.env.KYDO_ONCALL_SUPERVISED === "1",
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
      maxVerifyAttempts: [
        "Implementation/verification cycles after model-task retries:",
        String(config.maxVerifyAttempts),
      ],
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
        "Total fatal inner-loop attempts before fail-stop (including the first):",
        String(config.metaHarness.maxRecoveryAttempts),
      ],
      watchdogFile: ["Advisor watchdog file (repo-relative):", config.advisor.watchdogFile],
      submitModelName: ["Model name for submit --model (empty = none):", config.submitModelName ?? ""],
    };
    const [title, current] = prompts[field];
    const value = await ctx.ui.input(title, current);
    if (value === undefined) return;
    const update = applyConfigSetting(config, field, value);
    if (!update.ok) {
      notify(ctx, update.error ?? `invalid value for ${field}`, "warning");
    }
  }

  async function editConfig(ctx: ExtensionCommandContext): Promise<void> {
    const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
    const config = loadConfig(stateDir);
    const originalConfig = JSON.stringify(config);
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
        ...ALL_CONFIGURABLE_ROLES.map(
          (role) =>
            `role ${role}: ${config.roles[role].model}${config.roles[role].thinking ? ` (${config.roles[role].thinking})` : ""} · soul ${config.roles[role].soul ?? "SOUL.md"} · prompt ${config.roles[role].prompt ?? `${role}.md`}`,
        ),
      ].join("\n");
      console.log(summary);
      return;
    }

    await runConfigPanel(
      ctx,
      config,
      [...ALL_CONFIGURABLE_ROLES],
      "autoresearch config",
      true,
    );
    if (JSON.stringify(config) === originalConfig) {
      notify(ctx, "config closed without changes");
      return;
    }
    try {
      excludeAutoresearchStateFromGit(ctx.cwd);
      fs.mkdirSync(stateDir, { recursive: true });
      saveConfig(stateDir, config);
      notify(ctx, "config saved to .autoresearch/config.json");
    } catch (error) {
      notify(ctx, `config was not saved: ${errorMessage(error)}`, "error");
    }
  }

  async function runConfigPanel(
    ctx: ExtensionCommandContext,
    config: ReturnType<typeof loadConfig>,
    roles: ConfigurableRole[],
    title: string,
    describeRoles: boolean,
    onboardingActions = false,
  ): Promise<"close" | "continue" | "cancel"> {
    // Loop: the panel closes for input/select dialogs (they can't stack on
    // ui.custom) and reopens at the same nav position afterwards.
    let nav: NavState = { pane: "left", left: 0, right: 0 };
    for (;;) {
      const result = await ctx.ui.custom<ConfigPanelResult>(
        (tui, theme, _kb, done) =>
          new ConfigPanel(config, nav, tui, theme, done, {
            roles,
            title,
            describeRoles,
            onboardingActions,
          }),
      );
      if (
        result.type === "close" ||
        result.type === "continue" ||
        result.type === "cancel"
      ) {
        return result.type;
      }
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
        case "editTools": {
          const current = config.roles[result.role].tools?.join(", ") ?? "";
          const value = await ctx.ui.input(
            `Tools for ${result.role} (comma-separated; empty = no tools):`,
            current,
          );
          if (value !== undefined) {
            config.roles[result.role].tools = value
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean);
          }
          break;
        }
        case "editSetting":
          await editSettingDialog(ctx, config, result.field);
          break;
      }
    }
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
      const initializationReport = loadInitializationReport(stateDir);
      if (
        ctx.hasUI &&
        initializationReport &&
        (!state || state.phase === "ready")
      ) {
        setInitializationDashboard(
          ctx,
          initializationReport.challengeName,
          initializationRenderState(initializationReport),
        );
        ctx.ui.setStatus(
          WIDGET_KEY,
          initializationReport.status === "failed"
            ? "autoresearch: initialization failed"
            : "autoresearch: setup ready — /autoresearch to start",
        );
      } else if (state && ctx.hasUI) {
        const restoredStatus = statusFromState(stateDir, state);
        const restoredMonitor = new AgentMonitorModel(
          loadMonitorAgents(
            stateDir,
            state.loop,
            loadConfig(stateDir).maxVerifyAttempts,
            new Map(),
            new Map(),
            true,
            restoredStatus.ideas,
          ),
        );
        setAgentMonitorWidget(ctx, restoredMonitor);
        setResearchDashboard(
          ctx,
          state.challenge.name,
          restoredStatus,
          {
            recentActivity: readRecentActivity(stateDir),
            operatorSteering: operatorSteeringForUi(stateDir),
            running: false,
            navigator: navigatorFromMonitor(restoredMonitor, "nav"),
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
    resumeAfterSupervisorRestart: async (ctx: ExtensionContext) => {
      const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
      const state = loadState(stateDir);
      if (
        !state ||
        state.phase === "done" ||
        state.phase === "ready" ||
        active
      ) {
        return;
      }
      notify(
        ctx,
        `on-call supervisor restored Pi; resuming durable phase ${state.phase}`,
      );
      // startRun's existing-state path uses only the common ExtensionContext
      // surface. Session-start contexts intentionally omit user-only session
      // mutation methods, none of which are touched during durable resume.
      await startRun(ctx as ExtensionCommandContext);
    },
  };
}

function renderRunStartupFailure(
  error: unknown,
  metaharnessEnabled: boolean,
  state: NonNullable<ReturnType<typeof loadState>>,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    `failed to start ${metaharnessEnabled ? "metaharness" : "autoresearch"}: ${message}`,
  ];
  const recovery = state.recovery?.message?.trim();
  if (
    metaharnessEnabled &&
    error instanceof VerifierDriftError &&
    recovery &&
    !message.includes(recovery)
  ) {
    lines.push(
      "Last recorded loop failure (not retried because contract drift blocked startup first): " +
        recovery,
    );
    if (isProviderCreditOrAuthenticationFailure(recovery)) {
      lines.push(
        "Resolve the provider credit or authentication issue, restore the frozen runtime " +
          "setting, then retry /autoresearch.",
      );
    }
  }
  return lines.join("\n\n");
}

function isProviderCreditOrAuthenticationFailure(message: string): boolean {
  return /\b(?:401|402)\b|insufficient credits|authentication token|unauthori[sz]ed|sign in again/i
    .test(message);
}

function refreshAgentMonitor(
  handle: RunHandle,
  markRunningInterrupted: boolean,
): void {
  const report = handle.orchestrator.status();
  handle.monitor.updateAgents(
    loadMonitorAgents(
      handle.stateDir,
      report.loop,
      handle.maxVerifyAttempts,
      handle.traceTailers,
      handle.traceEvents,
      markRunningInterrupted,
      report.ideas,
    ),
  );
}

function loadMonitorAgents(
  stateDir: string,
  currentLoop: number,
  maxVerifyAttempts: number,
  traceTailers: Map<string, PiTraceFileTailer>,
  traceEvents: Map<string, MonitorTraceEvent[]>,
  markRunningInterrupted: boolean,
  ideas: StatusReport["ideas"] = [],
): MonitorAgent[] {
  let summaries: AgentInvocationSummary[];
  try {
    summaries = loadAgentInvocations(stateDir, {
      markRunningInterrupted,
    });
  } catch {
    summaries = [];
  }
  const current = summaries.filter(
    (summary) =>
      summary.loop === currentLoop || summary.status === "running",
  );
  const visible =
    current.length > 0
      ? current
      : [...summaries]
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 20);

  return visible.map((summary) => {
    let trace = traceEvents.get(summary.invocationId) ?? [];
    if (summary.tracePath) {
      let tailer = traceTailers.get(summary.invocationId);
      if (!tailer || tailer.filePath !== summary.tracePath) {
        tailer = new PiTraceFileTailer(
          summary.tracePath,
          summary.invocationId,
        );
        traceTailers.set(summary.invocationId, tailer);
        trace = [];
      }
      try {
        const poll = tailer.poll();
        trace = poll.reloaded
          ? [...poll.events]
          : [...trace, ...poll.events];
      } catch {
        // Trace display is advisory; the durable raw trace remains available.
      }
    }
    const boundedTrace = trace.slice(-2_000);
    traceEvents.set(summary.invocationId, boundedTrace);
    const agent = monitorAgentFromSummary(
      summary,
      boundedTrace,
      maxVerifyAttempts,
    );
    const idea = summary.candidateId
      ? ideas.find((candidate) => candidate.id === summary.candidateId)
      : undefined;
    if (!idea) return agent;
    return {
      ...agent,
      stage: idea.status,
      ...(idea.status === "implementing" || idea.status === "verifying"
        ? {
            attempt: idea.verifyAttempts + 1,
            maxAttempts: idea.maxVerifyAttempts ?? maxVerifyAttempts,
          }
        : {}),
    };
  });
}

function monitorAgentFromSummary(
  summary: AgentInvocationSummary,
  trace: readonly MonitorTraceEvent[],
  maxAttempts: number,
): MonitorAgent {
  const startedAt = Date.parse(summary.startedAt);
  const endedAt = Date.parse(summary.completedAt ?? summary.updatedAt);
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, endedAt - startedAt)
      : undefined;
  return {
    invocationId: summary.invocationId,
    role: summary.role,
    status: summary.status,
    ...(summary.activity ? { activity: summary.activity } : {}),
    stage: summary.kind,
    ...(summary.candidateId ? { candidateId: summary.candidateId } : {}),
    invocationGroup:
      summary.candidateId ?? `${summary.role}:${summary.kind}`,
    ...(summary.attempt === undefined ? {} : { attempt: summary.attempt }),
    ...(summary.attempt === undefined ? {} : { maxAttempts }),
    startedAt: summary.startedAt,
    updatedAt: summary.updatedAt,
    ...(summary.usage.tokens
      ? {
          tokens: summary.usage.tokens.total,
          tokensComplete: summary.usage.tokens.complete,
        }
      : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    trace,
  };
}

function monitorNavigator(
  handle: RunHandle,
): NonNullable<StatusRenderOptions["navigator"]> | undefined {
  return navigatorFromMonitor(handle.monitor, handle.editorMode);
}

function navigatorFromMonitor(
  monitor: AgentMonitorModel,
  inputMode: ResearchEditorMode,
): NonNullable<StatusRenderOptions["navigator"]> | undefined {
  const selected = monitor.selectedAgent;
  if (!selected) return undefined;
  const agents = monitor.orderedAgents;
  const index = agents.findIndex(
    (agent) => agent.invocationId === selected.invocationId,
  );
  const label = selected.candidateId
    ? `${selected.role} ${selected.candidateId}`
    : `${selected.role} ${compactInvocationId(selected.invocationId)}`;
  return {
    position: Math.max(1, index + 1),
    total: agents.length,
    label,
    state: selected.stage ?? selected.status,
    monitorMode: monitor.mode,
    inputMode,
  };
}

function applyResearchNavigation(
  handle: RunHandle,
  action: ResearchNavigationAction,
): void {
  switch (action.type) {
    case "select":
      handle.monitor.selectBy(action.direction);
      break;
    case "focus":
      handle.monitor.enterFocus();
      break;
    case "overview":
      if (handle.monitor.mode === "focus") {
        handle.monitor.exitFocus();
      } else {
        handle.monitor.selectFirstLive();
      }
      break;
    case "switchInvocation":
      handle.monitor.switchInvocation(action.direction);
      break;
    case "scroll":
      if (handle.monitor.mode === "focus") {
        handle.monitor.pageTrace(action.direction, 6);
      } else {
        handle.monitor.selectBy(action.direction * 6);
      }
      break;
    case "selectBoundary":
      if (handle.monitor.mode === "focus") {
        if (action.boundary === "first") handle.monitor.traceHome();
        else handle.monitor.traceEnd();
      } else if (action.boundary === "first") {
        handle.monitor.selectFirst();
      } else {
        handle.monitor.selectLast();
      }
      break;
  }
}

function scheduleResearchRender(
  _ctx: ExtensionContext,
  handle: RunHandle,
  render: () => void,
): void {
  if (handle.renderTimer) return;
  handle.renderTimer = setTimeout(() => {
    handle.renderTimer = undefined;
    render();
  }, 100);
  handle.renderTimer.unref();
}

function combineActivityObservers(
  first: AgentActivityObserver | undefined,
  second: AgentActivityObserver,
): AgentActivityObserver {
  return (event: AgentActivityEvent) => {
    try {
      first?.(event);
    } finally {
      second(event);
    }
  };
}

function compactInvocationId(invocationId: string): string {
  return invocationId.length <= 18
    ? invocationId
    : `${invocationId.slice(0, 15)}…`;
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
    runOverview: loadRunOverviewStatus(stateDir, state.loop),
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
      return `${event.ideaId} · ${event.status === "pending" ? "submission queued" : "submitted"} score ${event.score}`;
    case "submission-result":
      return `${event.candidateId} · remote ${event.status}`;
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
    case "validate":
      return "challenge validation failed";
    case "setup":
      return "challenge dependency setup failed";
    case "setup-agent":
      return "Setup agent could not complete its repository decision";
    case "baseline":
      return "local baseline benchmark failed";
    case "baseline-review":
      return "Setup could not choose a supported baseline recovery";
    case "archive":
      return "baseline archive could not be saved";
    case "ready":
      return "initialization failed while saving ready state";
  }
}

function initializationStepId(
  stage: InitializationRenderState["stage"],
): InitializationStepId {
  if (stage === "baseline-review") return "baseline";
  if (stage === "ready") return "archive";
  return stage;
}

function initializationStepStatus(
  status: InitProgress["status"],
): "running" | "retrying" | "resuming" | "passed" {
  return status === "succeeded" ? "passed" : status;
}

function initializationDiagnostic(
  error: unknown,
  step: InitializationStepId,
  evidencePath?: string,
): InitializationDiagnosticV1 {
  if (error instanceof InitializationError) return error.diagnostic;
  return {
    code: "unexpected",
    step,
    title: "Initialization stopped unexpectedly",
    reason: error instanceof Error ? firstDisplayLine(error.message) : String(error),
    action:
      "Inspect the referenced initialization evidence, correct the problem, then retry /autoresearch.",
    ...(evidencePath ? { evidencePath } : {}),
    retryable: true,
    resumesFromCheckpoint: step === "baseline" || step === "archive",
  };
}

function persistPreflightFailure(
  stateDir: string,
  challengeName: string,
  diagnostic: InitializationDiagnosticV1,
): InitializationReportV1 {
  const report = failInitializationReport(
    createInitializationReport(challengeName),
    diagnostic,
  );
  saveInitializationReport(stateDir, report);
  return report;
}

function renderDiagnosticMessage(
  diagnostic: InitializationDiagnosticV1,
): string {
  return [
    diagnostic.title,
    `What happened: ${diagnostic.reason}`,
    `What to do: ${diagnostic.action}`,
    diagnostic.command ? `Command: ${diagnostic.command}` : undefined,
    diagnostic.exitCode !== undefined
      ? `Exit code: ${diagnostic.exitCode}`
      : undefined,
    diagnostic.evidencePath
      ? `Evidence: ${diagnostic.evidencePath}`
      : undefined,
    diagnostic.resumesFromCheckpoint
      ? "Retry behavior: /autoresearch resumes from the saved Setup checkpoint."
      : "Retry behavior: /autoresearch rechecks this step before continuing.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderReadinessSummary(report: InitializationReportV1): string {
  const summary = report.summary;
  if (!summary) return "Initialization completed.";
  return [
    summary.readiness === "ready"
      ? "Ready: full local evaluation is available."
      : "Ready with limitations: local evaluation is reduced.",
    `Baseline: ${summary.baselineScore} (${summary.direction === "+" ? "higher" : "lower"} wins)`,
    `Verify: ${summary.verifyCommand}`,
    `Benchmark: ${summary.benchCommand}`,
    `Submission: ${summary.submissionReady ? "configured" : "not configured"}`,
    `Evidence: ${summary.evidencePath}`,
    ...summary.localEvaluation.limitations.map(
      (limitation) => `Limitation: ${limitation}`,
    ),
  ].join("\n");
}

function initializationRenderState(
  report: InitializationReportV1,
): InitializationRenderState {
  const current =
    report.steps.find((step) => step.id === report.currentStep) ??
    report.steps[0];
  const status: InitializationRenderState["status"] =
    report.status === "failed"
      ? "failed"
      : report.status === "ready" ||
          report.status === "ready-with-limitations"
        ? "succeeded"
        : current?.status === "retrying"
          ? "retrying"
          : current?.status === "resuming"
            ? "resuming"
            : "running";
  return {
    stage: report.currentStep,
    status,
    message:
      report.diagnostic?.title ??
      current?.detail ??
      (report.summary ? "initialization complete" : "initialization in progress"),
    ...(current?.command ? { command: current.command } : {}),
    ...(current?.logPath ? { logPath: current.logPath } : {}),
    ...(current?.attempt !== undefined ? { attempt: current.attempt } : {}),
    ...(current?.maxAttempts !== undefined
      ? { maxAttempts: current.maxAttempts }
      : {}),
    ...(report.diagnostic
      ? { diagnostic: report.diagnostic, failure: report.diagnostic.reason }
      : {}),
    ...(report.summary
      ? { localEvaluation: report.summary.localEvaluation }
      : {}),
    recentActivity: report.recentActivity,
    report,
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
