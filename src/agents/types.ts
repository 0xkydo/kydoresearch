import type { RoleSpec } from "../config.ts";
import type { CandidateProposalV1 } from "../experiments.ts";

export type Role = "setup" | "professor" | "phd" | "god" | "advisor" | "metaharness";

export type TaskKind =
  | "init.explore" // setup: classify existing commands and confirm readiness
  | "init.review" // setup: review failed baseline evidence and revise effective commands
  | "init.decide" // setup: resolve its own prior judgment call without user interaction
  | "propose" // professor: emit ideas for this loop
  | "implement" // phd: implement idea (or fix after verify failure)
  | "write-note" // phd: hypothesis note after no-improvement
  | "church" // professor reflects in church and speaks with God
  | "god-conversation" // legacy alias for church
  | "advise" // advisor: review loop diff against WATCHDOG rules
  | "evolve-harness"; // metaharness: propose one immutable outer-loop profile

export interface AgentInvocationIdentity {
  invocationId: string;
  role: Role;
  kind: TaskKind;
  loop?: number;
  candidateId?: string;
  attempt?: number;
  /** Absolute path to the invocation's raw JSONL trace, always under stateDir. */
  tracePath?: string;
}

export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the four token categories above. */
  total: number;
  /** False when at least one contributing turn omitted a token category. */
  complete: boolean;
}

export interface AgentUsage {
  cost: number;
  turns: number;
  /** Detailed token accounting. Older AgentRunner implementations may omit it. */
  tokens?: AgentTokenUsage;
}

export type AgentActivityStatus =
  | "running"
  | "waiting"
  | "complete"
  | "failed"
  | "interrupted";

export type AgentActivityEvent =
  | {
      type: "started";
      invocation: AgentInvocationIdentity;
      timestamp: string;
    }
  | {
      type: "activity";
      invocationId: string;
      activity: string;
      timestamp: string;
    }
  | {
      type: "usage";
      invocationId: string;
      usage: AgentUsage;
      timestamp: string;
    }
  | {
      type: "terminal";
      invocationId: string;
      status: Extract<AgentActivityStatus, "complete" | "failed" | "interrupted">;
      usage: AgentUsage;
      error?: string;
      timestamp: string;
    };

export type AgentActivityObserver = (event: AgentActivityEvent) => void;

export interface AgentTask {
  role: Role;
  kind: TaskKind;
  /** Working dir: the challenge repo root, or the idea's worktree for "implement". */
  cwd: string;
  /** Absolute path of the .autoresearch state dir (always in the MAIN repo). */
  stateDir: string;
  /** Kind-specific payload (idea spec, verify error, streak, leaderboard, ...). */
  input: Record<string, unknown>;
  /** Optional per-invocation Pi tool override; narrows the role default. */
  tools?: string[];
  /** Optional role settings supplied by an active, validated harness profile. */
  roleOverride?: Partial<RoleSpec>;
  /** Stable identity supplied by the harness. The runner creates one for legacy callers. */
  invocation?: AgentInvocationIdentity;
  /** Optional live feed. Durable activity is written before this callback runs. */
  activityObserver?: AgentActivityObserver;
  signal?: AbortSignal;
}

export interface AgentResult {
  ok: boolean;
  /** Final agent text (markdown). */
  output: string;
  /** Parsed structured payload when the task kind demands one (e.g. proposed ideas). */
  structured?: Record<string, unknown>;
  filesWritten: string[];
  usage?: AgentUsage;
  error?: string;
}

export interface AgentRunner {
  run(task: AgentTask): Promise<AgentResult>;
}

/**
 * Professor output accepted at the runtime boundary. The scientific fields
 * are optional here only for compatibility with older custom prompts; they
 * become required when normalizeProposal persists the candidate.
 */
export type ProposedIdea = Pick<CandidateProposalV1, "title" | "spec"> &
  Partial<
    Omit<CandidateProposalV1, "schemaVersion" | "title" | "spec">
  >;
