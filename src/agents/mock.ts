import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentActivityRecorder,
  emptyAgentUsage,
  resolveAgentInvocationIdentity,
  resolveAgentTracePath,
} from "../agent-activity.ts";
import type {
  AgentResult,
  AgentRunner,
  AgentTask,
  ProposedIdea,
  TaskKind,
} from "./types.ts";
import {
  loadMockScenario,
  mockScenarioEdit,
  mockScenarioKnowledgeBase,
  mockScenarioNote,
  mockScenarioProposals,
  scriptedChurchConversation,
  scriptedEdit,
  scriptedKnowledgeBase,
  scriptedNote,
  scriptedProposals,
} from "./mock-scripts.ts";

export interface MockAgentRunnerOptions {
  /**
   * Demo-only pause after publishing the running activity. Tests keep the
   * default of zero; the interactive mock launcher derives a short pause from
   * mockLoopDelayMs so the Agent Monitor can render the live state.
   */
  activityDelayMs?: number;
}

/**
 * Deterministic scripted agents. No LLM calls. The mock PhD makes REAL file
 * edits in its (worktree) cwd and the real verify/bench scripts judge them —
 * the mock only replaces the thinking, not the data flow.
 */
export class MockAgentRunner implements AgentRunner {
  constructor(private readonly options: MockAgentRunnerOptions = {}) {}

  async run(task: AgentTask): Promise<AgentResult> {
    if (task.signal?.aborted) {
      return mockFailure("mock agent aborted before start");
    }

    const tracePath = prepareMockTrace(task);
    const identity = resolveAgentInvocationIdentity(task, tracePath);
    const recorder = createAgentActivityRecorder(
      task.stateDir,
      identity,
      task.activityObserver,
    );
    recorder.start();
    recorder.activity(mockActivity(task));
    appendMockTrace(tracePath, {
      type: "agent_start",
      timestamp: new Date().toISOString(),
    });

    const delayMs = Math.max(0, this.options.activityDelayMs ?? 0);
    if (!(await waitForMockActivity(delayMs, task.signal))) {
      const result = mockFailure("mock agent aborted");
      appendMockTrace(tracePath, {
        type: "agent_end",
        timestamp: new Date().toISOString(),
      });
      recorder.terminal("interrupted", emptyAgentUsage(), result.error);
      return result;
    }

    try {
      const result = this.runScript(task);
      appendMockTrace(tracePath, mockAssistantEvent(task, result));
      appendMockTrace(tracePath, {
        type: "agent_end",
        timestamp: new Date().toISOString(),
      });
      recorder.terminal(
        result.ok ? "complete" : "failed",
        result.usage ?? emptyAgentUsage(),
        result.error,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMockTrace(tracePath, mockAssistantEvent(task, mockFailure(message)));
      appendMockTrace(tracePath, {
        type: "agent_end",
        timestamp: new Date().toISOString(),
      });
      recorder.terminal("failed", emptyAgentUsage(), message);
      throw error;
    }
  }

  private runScript(task: AgentTask): AgentResult {
    switch (task.kind) {
      case "init.explore":
        return this.initExplore(task);
      case "init.review":
        return this.initReview(task);
      case "init.decide":
        return this.initDecide(task);
      case "propose":
        return this.propose(task);
      case "implement":
        return this.implement(task);
      case "write-note":
        return this.writeNote(task);
      case "church":
      case "god-conversation":
        return this.goToChurch(task);
      case "advise":
        return this.advise(task);
      case "evolve-harness":
        return this.evolveHarness(task);
    }
  }

  private initExplore(task: AgentTask): AgentResult {
    const manifest = JSON.parse(fs.readFileSync(path.join(task.cwd, "benchmark.json"), "utf8")) as {
      name: string;
      benchmarkCommand: string;
      preSubmitCommand?: string;
    };
    const scenario = this.scenario(task);
    const subjectArea =
      scenario?.subjectArea ??
      "2D quadratic optimization (toy research space for harness development).";
    const kbPath = path.join(task.stateDir, "knowledge-base.md");
    const knowledgeBase = scenario
      ? mockScenarioKnowledgeBase(scenario, manifest.name)
      : scriptedKnowledgeBase(subjectArea, manifest.name);
    fs.writeFileSync(kbPath, `${knowledgeBase}\n`);
    // The mock "reads the repo" by trusting the manifest: preSubmitCommand is the
    // fast correctness gate when present (mlxfast-style), else the benchmark itself.
    return {
      ok: true,
      output: `Explored repo. Subject area: ${subjectArea}`,
      structured: {
        status: "ready",
        subjectArea,
        verifyCommand: manifest.preSubmitCommand ?? manifest.benchmarkCommand,
        benchCommand: manifest.benchmarkCommand,
        localEvaluation: {
          fidelity: "full",
          decision: "Use the manifest-backed local verification and benchmark commands.",
          limitations: [],
          officialValidationRequired: false,
        },
      },
      filesWritten: [kbPath],
    };
  }

  private initReview(task: AgentTask): AgentResult {
    return {
      ok: true,
      output: "No documented command revision is needed for the fixture.",
      structured: {
        status: "ready",
        verifyCommand: task.input.previousVerifyCommand,
        benchCommand: task.input.previousBenchCommand,
        localEvaluation: {
          fidelity: "full",
          decision: "Retain the manifest-backed commands for a transient retry.",
          limitations: [],
          officialValidationRequired: false,
        },
      },
      filesWritten: [],
    };
  }

  private initDecide(task: AgentTask): AgentResult {
    return {
      ok: true,
      output: "Selected the safest documented local mode without user interaction.",
      structured: {
        status: "ready",
        verifyCommand: task.input.previousVerifyCommand,
        benchCommand: task.input.previousBenchCommand,
        localEvaluation: {
          fidelity: "reduced",
          decision: "Continue with the documented local mode selected by Setup.",
          limitations: ["The local mode does not exercise the complete official evaluator."],
          officialValidationRequired: true,
        },
      },
      filesWritten: [],
    };
  }

  private propose(task: AgentTask): AgentResult {
    const loop = task.input.loop as number;
    const cap = (task.input.maxIdeasPerLoop as number) ?? 5;
    const scenario = this.scenario(task);
    const ideas: ProposedIdea[] = (
      scenario
        ? mockScenarioProposals(scenario, loop)
        : scriptedProposals(loop)
    ).slice(0, cap);
    return {
      ok: true,
      output: `Proposed ${ideas.length} idea(s) for loop ${loop}.`,
      structured: { ideas },
      filesWritten: [],
    };
  }

  private implement(task: AgentTask): AgentResult {
    const loop = task.input.loop as number;
    const ideaIndex = task.input.ideaIndex as number;
    const attempt = task.input.attempt as number;
    const scenario = this.scenario(task);
    const edit = scenario
      ? mockScenarioEdit(scenario, loop, ideaIndex, attempt)
      : scriptedEdit(loop, ideaIndex, attempt);
    const solutionPath = path.join(
      task.cwd,
      scenario?.solutionPath ?? "src/solution/params.json",
    );
    const content =
      typeof edit === "string" ? edit : `${JSON.stringify(edit, null, 2)}\n`;
    fs.mkdirSync(path.dirname(solutionPath), { recursive: true });
    fs.writeFileSync(solutionPath, content);
    return {
      ok: true,
      output: `Implemented idea L${loop}-I${ideaIndex + 1} (attempt ${attempt}).`,
      filesWritten: [solutionPath],
    };
  }

  private writeNote(task: AgentTask): AgentResult {
    const notePath = task.input.notePath as string;
    const scenario = this.scenario(task);
    const note = scenario
      ? mockScenarioNote(
          scenario,
          task.input.ideaTitle as string,
          task.input.localScore as number | undefined,
          task.input.bestScore as number | null,
        )
      : scriptedNote(
          task.input.ideaTitle as string,
          task.input.localScore as number | undefined,
          task.input.bestScore as number | null,
        );
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, note + "\n");
    return { ok: true, output: note, filesWritten: [notePath] };
  }

  private goToChurch(task: AgentTask): AgentResult {
    const notePath = task.input.notePath as string;
    const scenario = this.scenario(task);
    const conversation =
      scenario?.churchConversation ??
      scriptedChurchConversation(
        task.input.loop as number,
        task.input.streak as number,
      );
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, conversation + "\n");
    return { ok: true, output: conversation, filesWritten: [notePath] };
  }

  private advise(task: AgentTask): AgentResult {
    // The mock advisor evaluates WATCHDOG-style conditions computed by the
    // orchestrator (stateDiff) and returns matching canned notes.
    const rules = task.input.rules as { if: string; severity: string; text: string }[];
    const diff = task.input.stateDiff as Record<string, unknown>;
    const notes = rules
      .filter((rule) => evaluateCondition(rule.if, diff))
      .map((rule) => ({ severity: rule.severity, text: rule.text }));
    return {
      ok: true,
      output: notes.map((n) => `[${n.severity}] ${n.text}`).join("\n") || "No advisor notes this loop.",
      structured: { notes },
      filesWritten: [],
    };
  }

  private evolveHarness(task: AgentTask): AgentResult {
    const profilePath = task.input.profilePath as string;
    const candidateDirectory = task.input.candidateDirectory as string;
    const candidateId = task.input.candidateId as string;
    const generation = task.input.generation as number;
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
      hypothesis: {
        observation: string;
        mechanism: string;
        intervention: string;
        expectedResult: string;
        falsifiedWhen: string;
        risks: string[];
        evidenceRefs: string[];
      };
      roles: { professor: { prompt: string } };
    };
    const professorPrompt = path.join(
      candidateDirectory,
      profile.roles.professor.prompt,
    );
    fs.appendFileSync(
      professorPrompt,
      `\n\n<!-- mock metaharness generation ${generation}: inspect raw failure evidence before proposing -->\n`,
    );
    profile.hypothesis = {
      observation: `Generation ${generation} has access to completed inner-loop evidence.`,
      mechanism: "Explicit raw-evidence inspection should reduce blind proposal repetition.",
      intervention: "Add a generation-tagged evidence-inspection reminder to the professor prompt.",
      expectedResult: "Maintain verifier validity while improving proposal grounding.",
      falsifiedWhen: "The evaluation window produces no verified objective gain.",
      risks: ["The reminder may be redundant with the professor soul."],
      evidenceRefs: ["ledger.ndjson", "runs/"],
    };
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    return {
      ok: true,
      output: `Prepared metaharness candidate ${candidateId}.`,
      structured: { candidateId, profilePath },
      filesWritten: [profilePath, professorPrompt],
    };
  }

  private scenario(task: AgentTask) {
    return loadMockScenario(path.dirname(task.stateDir));
  }
}

function prepareMockTrace(task: AgentTask): string | undefined {
  const configured =
    optionalInputPath(task.input, "tracePath") ??
    optionalInputPath(task.input, "runTracePath") ??
    task.invocation?.tracePath;
  const traceDir = optionalInputPath(task.input, "traceDir");
  if (configured === undefined && traceDir === undefined) return undefined;

  const tracePath = resolveAgentTracePath(
    configured ?? path.join(traceDir!, "events.ndjson"),
    task.stateDir,
  );
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  return tracePath;
}

function appendMockTrace(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  if (tracePath === undefined) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function mockAssistantEvent(
  task: AgentTask,
  result: AgentResult,
): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "thinking",
          thinking: `Following the deterministic mock playlist for ${task.role}/${task.kind}.`,
        },
        {
          type: "text",
          text: result.error ?? result.output,
        },
      ],
    },
  };
}

function mockActivity(task: AgentTask): string {
  const activities: Record<TaskKind, string> = {
    "init.explore": "reviewing repository and setup evidence",
    "init.review": "reviewing failed baseline evidence",
    "init.decide": "selecting a documented local mode",
    propose: "forming evidence-backed experiment proposals",
    implement: "editing the candidate worktree",
    "write-note": "writing the candidate postmortem",
    church: "reflecting on the dry-loop plateau",
    "god-conversation": "reflecting on the dry-loop plateau",
    advise: "checking watchdog conditions",
    "evolve-harness": "drafting a candidate harness profile",
  };
  return activities[task.kind];
}

function optionalInputPath(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`task input ${key} must be a non-empty path string`);
  }
  return value.trim();
}

function waitForMockActivity(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs === 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function mockFailure(error: string): AgentResult {
  return {
    ok: false,
    output: "",
    filesWritten: [],
    error,
  };
}

/** Evaluate a WATCHDOG condition like "dryLoopStreak >= 2" or "ideaFailed" against a diff object. */
export function evaluateCondition(condition: string, diff: Record<string, unknown>): boolean {
  const comparison = condition.match(/^(\w+)\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/);
  if (comparison) {
    const [, key, op, rhsText] = comparison;
    const lhs = diff[key!];
    const rhs = Number(rhsText);
    if (typeof lhs !== "number") return false;
    switch (op) {
      case ">=": return lhs >= rhs;
      case "<=": return lhs <= rhs;
      case ">": return lhs > rhs;
      case "<": return lhs < rhs;
      case "==": return lhs === rhs;
    }
  }
  return diff[condition.trim()] === true;
}
