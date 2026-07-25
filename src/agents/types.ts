export type Role = "setup" | "professor" | "phd" | "god" | "advisor";

export type TaskKind =
  | "init.explore" // setup: build knowledge base, detect verify/bench commands
  | "propose" // professor: emit ideas for this loop
  | "implement" // phd: implement idea (or fix after verify failure)
  | "write-note" // phd: hypothesis note after no-improvement
  | "god-conversation" // professor prays; God inspires
  | "advise"; // advisor: review loop diff against WATCHDOG rules

export interface AgentTask {
  role: Role;
  kind: TaskKind;
  /** Working dir: the challenge repo root, or the idea's worktree for "implement". */
  cwd: string;
  /** Absolute path of the .autoresearch state dir (always in the MAIN repo). */
  stateDir: string;
  /** Kind-specific payload (idea spec, verify error, streak, leaderboard, ...). */
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentResult {
  ok: boolean;
  /** Final agent text (markdown). */
  output: string;
  /** Parsed structured payload when the task kind demands one (e.g. proposed ideas). */
  structured?: Record<string, unknown>;
  filesWritten: string[];
  usage?: { cost: number; turns: number };
  error?: string;
}

export interface AgentRunner {
  run(task: AgentTask): Promise<AgentResult>;
}

/** Shape of the professor's "propose" structured output. */
export interface ProposedIdea {
  title: string;
  /** Markdown body written to the idea spec file. */
  spec: string;
}
