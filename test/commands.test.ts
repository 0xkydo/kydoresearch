import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAutoresearchCommand } from "../extensions/autoresearch/commands.ts";
import { createCandidateRun, writeCandidateProposal } from "../src/archive.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { EXPERIMENT_SCHEMA_VERSION } from "../src/experiments.ts";
import { newLoopState, saveState, STATE_DIR_NAME } from "../src/state.ts";
import { loadOperatorSteering } from "../src/steering.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

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
      expect.stringContaining("╭─ AUTORESEARCH · status-challenge"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("○ LOOP 0 · READY TO START"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("score  42 local"), "info");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("/autoresearch steer", () => {
  it("persists and surfaces a direction for the next Professor proposal", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-steer-"));
    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    const state = newLoopState({
      name: "steer-challenge",
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
    saveState(stateDir, state);

    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: {
          handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
        },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);
    const notify = vi.fn();
    const setWidget = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      mode: "rpc",
      ui: { notify, setWidget },
    } as unknown as ExtensionCommandContext;

    try {
      await handler!(
        "steer prioritize cache locality before changing algorithms",
        ctx,
      );

      expect(loadOperatorSteering(stateDir)?.text).toBe(
        "prioritize cache locality before changing algorithms",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(/operator direction saved.*next Professor proposal/),
        "info",
      );
      expect(setWidget).toHaveBeenLastCalledWith(
        "autoresearch",
        expect.arrayContaining([
          expect.stringContaining("Operator direction"),
          expect.stringContaining("prioritize cache locality"),
        ]),
        { placement: "belowEditor" },
      );

      await handler!("steer clear", ctx);
      expect(loadOperatorSteering(stateDir)).toBeNull();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("autoresearch persistent dashboard", () => {
  it("uses Pi's uncapped custom-component path below the editor in TUI mode", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-dashboard-"));
    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    const state = newLoopState({
      name: "dashboard-challenge",
      cli: "",
      direction: "-",
      setupCommand: "./setup.sh",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      submitNeedsModel: false,
      editablePaths: ["src"],
      scorePath: "score.json",
    });
    state.phase = "paused";
    saveState(stateDir, state);

    const pi = {
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI;
    const { restoreWidget } = registerAutoresearchCommand(pi);
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      mode: "tui",
      ui: { setWidget, setStatus },
    } as unknown as ExtensionContext;

    try {
      restoreWidget(ctx);

      expect(setWidget).toHaveBeenCalledWith(
        "autoresearch",
        expect.any(Function),
        { placement: "belowEditor" },
      );
      expect(setStatus).toHaveBeenCalledWith(
        "autoresearch",
        expect.stringContaining("paused"),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("/autoresearch telemetry", () => {
  it("summarizes local timing spans without requiring initialized state", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-telemetry-command-"));
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const notify = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    try {
      await handler!("telemetry", ctx);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("no completed flows recorded yet"),
        "info",
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("/autoresearch inspect", () => {
  it("surfaces a candidate's scientific intent and evidence paths inside Pi", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-inspect-"));
    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    const state = newLoopState({
      name: "inspect-challenge",
      cli: "",
      direction: "-",
      setupCommand: "./setup.sh",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      submitNeedsModel: false,
      editablePaths: ["src"],
      scorePath: "score.json",
    });
    state.loop = 1;
    state.phase = "loop.ideas";
    state.bestScore = 10;
    state.ideas = [
      {
        id: "L001-I1",
        loop: 1,
        title: "Fuse the lookup passes",
        parentCandidateId: "baseline",
        specFile: "ideas/loop-001/idea-1.md",
        proposalFile: "runs/L001-I1/proposal.json",
        status: "verifying",
        verifyAttempts: 1,
        comparisonScore: 10,
        lastVerifyError: "first verification found an off-by-one error",
      },
    ];
    saveState(stateDir, state);
    createCandidateRun(stateDir, {
      candidateId: "L001-I1",
      parentCandidateId: "baseline",
      baseRevision: "abc123",
    });
    writeCandidateProposal(stateDir, "L001-I1", {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      title: "Fuse the lookup passes",
      parentCandidateId: "baseline",
      searchMode: "refinement",
      editFamily: "lookup-loop",
      evidenceRefs: ["runs/baseline/metrics.json"],
      observation: "Two passes traverse the same input.",
      hypothesis: "One fused pass will remove redundant work.",
      intervention: "Combine lookup and normalization.",
      expectedResult: "At least a five percent runtime reduction.",
      falsifiedWhen: "The benchmark does not improve.",
      risks: ["May change iteration order."],
      nonGoals: ["Do not change the verifier."],
      spec: "Implement a single fused loop.",
    });

    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const notify = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    try {
      await handler!("inspect L001-I1", ctx);
      const rendered = notify.mock.calls.flat().join("\n");
      expect(rendered).toContain("L001-I1 · Fuse the lookup passes");
      expect(rendered).toContain("Hypothesis: One fused pass will remove redundant work.");
      expect(rendered).toContain("Intervention: Combine lookup and normalization.");
      expect(rendered).toContain("Last failure: first verification found an off-by-one error");
      expect(rendered).toContain(".autoresearch/runs/L001-I1/proposal.json");
      expect(rendered).toContain(".autoresearch/runs/L001-I1/logs/verify.log");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("/autoresearch compatibility", () => {
  it("turns an unsupported Pi version into an actionable notification", async () => {
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi, { piVersion: "0.74.9" });

    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    await handler!("run", ctx);

    expect(notify).toHaveBeenCalledWith(
      "kydoresearch requires Pi 0.75.0 or newer (running 0.74.9). Run `pi update`, restart Pi, then retry /autoresearch.",
      "error",
    );
    expect(notify.mock.calls.flat().join("\n")).not.toMatch(/\n\s+at\s/);
  });
});

describe("/autoresearch config", () => {
  it("creates a complete default config when closed in a fresh repo", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-fresh-config-"));
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const stateDir = path.join(repoRoot, STATE_DIR_NAME);
    const notify = vi.fn();
    const custom = vi.fn().mockResolvedValue({ type: "close" });
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      ui: { custom, notify },
    } as unknown as ExtensionCommandContext;

    try {
      expect(fs.existsSync(stateDir)).toBe(false);
      await handler!("config", ctx);

      expect(custom).toHaveBeenCalledOnce();
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8")),
      ).toEqual(DEFAULT_CONFIG);
      expect(notify).toHaveBeenCalledWith(
        "config saved to .autoresearch/config.json",
        "info",
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("selects role models from Pi's available model registry", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-model-config-"));
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const custom = vi
      .fn()
      .mockResolvedValueOnce({
        type: "editModel",
        role: "professor",
        nav: { pane: "right", left: 0, right: 0 },
      })
      .mockResolvedValueOnce({ type: "close" });
    const select = vi.fn().mockResolvedValue("openai/gpt-5.6 — GPT 5.6");
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { provider: "openai", id: "gpt-5.6", name: "GPT 5.6" },
        ],
      },
      ui: { custom, notify: vi.fn(), select },
    } as unknown as ExtensionCommandContext;

    try {
      await handler!("config", ctx);

      expect(select).toHaveBeenCalledWith(
        `Model for professor (current: ${DEFAULT_CONFIG.roles.professor.model})`,
        [
          "anthropic/claude-sonnet-5 — Claude Sonnet 5",
          "openai/gpt-5.6 — GPT 5.6",
        ],
      );
      const saved = JSON.parse(
        fs.readFileSync(path.join(repoRoot, STATE_DIR_NAME, "config.json"), "utf8"),
      );
      expect(saved.roles.professor.model).toBe("openai/gpt-5.6");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("/autoresearch startup errors", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function commandHarness(repoRoot: string) {
    let handler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
      | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
      ) => {
        handler = options.handler;
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerAutoresearchCommand(pi);

    const notify = vi.fn();
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      cwd: repoRoot,
      hasUI: true,
      mode: "rpc",
      ui: {
        notify,
        confirm: vi.fn().mockResolvedValue(true),
        setWidget,
        setStatus,
      },
    } as unknown as ExtensionCommandContext;
    return { run: () => handler!("run", ctx), notify, setWidget, setStatus };
  }

  it("surfaces actionable repo and manifest guidance without a stack trace", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-empty-"));
    cleanups.push(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
    const missingManifest = commandHarness(emptyDir);
    await missingManifest.run();
    expect(missingManifest.notify).toHaveBeenCalledWith(
      expect.stringMatching(/No benchmark\.json.*cd into a cloned Yukon challenge repo.*retry \/autoresearch/s),
      "error",
    );

    const staleChallenge = makeTmpChallenge();
    cleanups.push(staleChallenge.cleanup);
    const staleStateDir = path.join(staleChallenge.repoRoot, STATE_DIR_NAME);
    saveState(
      staleStateDir,
      newLoopState({
        name: "stale-challenge",
        cli: "",
        direction: "-",
        setupCommand: "./setup.sh",
        verifyCommand: "./verify.sh",
        benchCommand: "./benchmark.sh",
        submitNeedsModel: false,
        editablePaths: ["src"],
        scorePath: "score.json",
      }),
    );
    fs.rmSync(path.join(staleChallenge.repoRoot, "benchmark.json"));
    const staleManifest = commandHarness(staleChallenge.repoRoot);
    await expect(staleManifest.run()).resolves.toBeUndefined();
    expect(staleManifest.notify).toHaveBeenCalledWith(
      expect.stringMatching(/No benchmark\.json.*retry \/autoresearch/s),
      "error",
    );

    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    fs.rmSync(path.join(challenge.repoRoot, ".git"), { recursive: true, force: true });
    const notGit = commandHarness(challenge.repoRoot);
    await notGit.run();
    expect(notGit.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Not a git repository.*clone the challenge.*retry \/autoresearch/is),
      "error",
    );

    expect(
      [
        ...missingManifest.notify.mock.calls,
        ...staleManifest.notify.mock.calls,
        ...notGit.notify.mock.calls,
      ].flat().join("\n"),
    ).not.toMatch(/\n\s+at\s/);
  });

  it("blocks MLX Fast startup until an exact submission model is configured", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const manifestPath = path.join(challenge.repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.name = "MLX Fast Challenge";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const mlx = commandHarness(challenge.repoRoot);
    await mlx.run();

    expect(mlx.notify).toHaveBeenCalledWith(
      expect.stringMatching(/MLX Fast requires exact model attribution.*submit model.*GPT 5\.6 Sol/is),
      "error",
    );
    expect(fs.existsSync(path.join(challenge.repoRoot, STATE_DIR_NAME, "state.json"))).toBe(false);
  });

  it("surfaces actionable setup and missing-benchmark guidance without a stack trace", async () => {
    const setupChallenge = makeTmpChallenge();
    cleanups.push(setupChallenge.cleanup);
    fs.writeFileSync(
      path.join(setupChallenge.repoRoot, "setup.sh"),
      "#!/usr/bin/env bash\necho setup exploded >&2\nexit 7\n",
    );
    const setupFailure = commandHarness(setupChallenge.repoRoot);
    await setupFailure.run();
    expect(setupFailure.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Dependency setup failed.*Run "\.\/setup\.sh" manually.*retry \/autoresearch/s),
      "error",
    );
    expect(setupFailure.setWidget).toHaveBeenCalledWith(
      "autoresearch",
      expect.arrayContaining([
        expect.stringContaining("╭─ AUTORESEARCH · mock-challenge"),
        expect.stringContaining("! STOPPED · INITIALIZATION"),
        expect.stringContaining(".autoresearch/logs/setup.log"),
      ]),
      { placement: "belowEditor" },
    );
    expect(setupFailure.setStatus).toHaveBeenLastCalledWith(
      "autoresearch",
      "autoresearch: initialization failed",
    );

    const benchmarkChallenge = makeTmpChallenge();
    cleanups.push(benchmarkChallenge.cleanup);
    const manifestPath = path.join(benchmarkChallenge.repoRoot, "benchmark.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.benchmarkCommand = "./missing-benchmark.sh";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const benchmarkFailure = commandHarness(benchmarkChallenge.repoRoot);
    await benchmarkFailure.run();
    expect(benchmarkFailure.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Benchmark command "\.\/missing-benchmark\.sh" was not found.*fix benchmarkCommand.*retry \/autoresearch/s),
      "error",
    );

    expect(
      [...setupFailure.notify.mock.calls, ...benchmarkFailure.notify.mock.calls].flat().join("\n"),
    ).not.toMatch(/\n\s+at\s/);
  });

  it("shows setup, Setup-agent, and baseline stages in the persistent widget", async () => {
    const challenge = makeTmpChallenge();
    cleanups.push(challenge.cleanup);
    const stateDir = path.join(challenge.repoRoot, STATE_DIR_NAME);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ version: 1, runner: "mock", maxLoops: 0 }),
    );
    const visible = commandHarness(challenge.repoRoot);

    await visible.run();

    const widgets = visible.setWidget.mock.calls
      .map((call) => (call[1] as string[]).join("\n"))
      .join("\n---\n");
    expect(widgets).toContain("running challenge dependency setup");
    expect(widgets).toContain(
      "Setup agent is reviewing repository and hardware evidence",
    );
    expect(widgets).toContain("measuring the local baseline");
    expect(widgets).toContain("initialization complete");
    expect(visible.setStatus).toHaveBeenCalledWith(
      "autoresearch",
      "autoresearch: initializing (setup-agent)",
    );
  });
});
