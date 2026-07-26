import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentResult, AgentRunner, AgentTask, ProposedIdea } from "./types.ts";
import {
  scriptedChurchConversation,
  scriptedEdit,
  scriptedKnowledgeBase,
  scriptedNote,
  scriptedProposals,
} from "./mock-scripts.ts";

/**
 * Deterministic scripted agents. No LLM calls. The mock PhD makes REAL file
 * edits in its (worktree) cwd and the real verify/bench scripts judge them —
 * the mock only replaces the thinking, not the data flow.
 */
export class MockAgentRunner implements AgentRunner {
  async run(task: AgentTask): Promise<AgentResult> {
    switch (task.kind) {
      case "init.explore":
        return this.initExplore(task);
      case "propose":
        return this.propose(task);
      case "implement":
        return this.implement(task);
      case "write-note":
        return this.writeNote(task);
      case "church":
        return this.goToChurch(task);
      case "advise":
        return this.advise(task);
    }
  }

  private initExplore(task: AgentTask): AgentResult {
    const manifest = JSON.parse(fs.readFileSync(path.join(task.cwd, "benchmark.json"), "utf8")) as {
      name: string;
      benchmarkCommand: string;
      preSubmitCommand?: string;
    };
    const subjectArea = "2D quadratic optimization (toy research space for harness development).";
    const kbPath = path.join(task.stateDir, "knowledge-base.md");
    fs.writeFileSync(kbPath, scriptedKnowledgeBase(subjectArea, manifest.name) + "\n");
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
      },
      filesWritten: [kbPath],
    };
  }

  private propose(task: AgentTask): AgentResult {
    const loop = task.input.loop as number;
    const cap = (task.input.maxIdeasPerLoop as number) ?? 5;
    const ideas: ProposedIdea[] = scriptedProposals(loop).slice(0, cap);
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
    const edit = scriptedEdit(loop, ideaIndex, attempt);
    const paramsPath = path.join(task.cwd, "src/solution/params.json");
    const content = typeof edit === "string" ? edit : JSON.stringify(edit, null, 2) + "\n";
    fs.writeFileSync(paramsPath, content);
    return {
      ok: true,
      output: `Implemented idea L${loop}-I${ideaIndex + 1} (attempt ${attempt}).`,
      filesWritten: [paramsPath],
    };
  }

  private writeNote(task: AgentTask): AgentResult {
    const notePath = task.input.notePath as string;
    const note = scriptedNote(
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
    const conversation = scriptedChurchConversation(task.input.loop as number, task.input.streak as number);
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
