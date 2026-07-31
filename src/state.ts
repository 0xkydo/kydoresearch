import * as path from "node:path";
import type { EvaluationCommandV1, LocalEvaluationV1 } from "./experiments.ts";
import type { RemoteSubmissionStatus } from "./challenge/types.ts";
import type { IdeaStatus, Phase } from "./phases.ts";
import type { Direction } from "./util.ts";
import { atomicWriteJson, readJsonIfExists } from "./util.ts";

export interface Idea {
  id: string; // "L003-I2"
  loop: number;
  title: string;
  /** Explicit archived artifact this candidate was materialized from. */
  parentCandidateId?: string;
  specFile: string; // ideas/loop-003/idea-2.md (relative to stateDir)
  /** Canonical versioned experiment proposal (relative to stateDir). */
  proposalFile?: string;
  /** Immutable PhD task contract (relative to stateDir). */
  taskFile?: string;
  status: IdeaStatus;
  verifyAttempts: number; // completed deterministic verification attempts
  lastVerifyError?: string;
  localScore?: number;
  /** Score this candidate was required to beat when it was proposed. */
  comparisonScore?: number | null;
  /** Durable evaluator provenance, retained across pause/resume. */
  verifyRecords?: EvaluationCommandV1[];
  benchmarkRecord?: EvaluationCommandV1;
  worktreePath?: string; // present while in flight (or kept on failure for debugging)
  noteFile?: string; // notes/<...>.md (relative to stateDir)
  /** Brief implementation report, sanitized before inclusion in public notes. */
  implementationSummary?: string;
  /** ISO timestamp written after the candidate evidence bundle is sealed. */
  archivedAt?: string;
  submitted?: { submissionId?: string; noteFile: string };
}

/** Durable local tracking for an asynchronously reviewed remote submission. */
export interface SubmissionReview {
  candidateId: string;
  submissionId?: string;
  localScore: number;
  noteFile: string;
  submittedAt: string;
  status: RemoteSubmissionStatus;
  /** Exact status text from the most recent remote snapshot. */
  remoteStatus?: string;
  remoteMetrics?: string;
  officialScore?: number;
  promoted?: boolean;
  lastCheckedAt?: string;
  resolvedAt?: string;
  /** Terminal state already appended to the knowledge base. */
  feedbackRecordedStatus?: Exclude<RemoteSubmissionStatus, "pending">;
}

export interface LoopSummary {
  loop: number;
  improved: boolean;
  bestScoreAfter: number | null;
  /** Candidates that reached the deterministic verifier at least once. */
  evaluatedCandidates?: number;
  ideas: {
    id: string;
    title: string;
    status: IdeaStatus;
    localScore?: number;
    /** Missing on legacy v1 summaries; new summaries always persist it. */
    evaluated?: boolean;
  }[];
  churchNote?: string; // notes file path
  /** Legacy v1 snapshots used this field name. */
  godConversation?: string;
  advisorNotes?: string[];
}

export interface ChallengeInfo {
  name: string;
  cli: string; // "ecdsafail" | "mlxfast" | "./bin/mockchal"
  direction: Direction;
  setupCommand: string;
  verifyCommand: string; // may equal benchCommand (ecdsafail case)
  benchCommand: string;
  preSubmitCommand?: string;
  submitNeedsModel: boolean;
  editablePaths: string[];
  scorePath: string;
  subjectArea?: string; // from init.explore
  /** Setup's durable statement of what local verification can and cannot establish. */
  localEvaluation?: LocalEvaluationV1;
}

export interface RecoveryState {
  scope: string;
  message: string;
  consecutiveFailures: number;
  failedAt: string;
  nextRetryAt?: string;
}

export interface LoopState {
  version: 1;
  phase: Phase;
  loop: number; // current loop number, 1-based; 0 before first loop
  bestScore: number | null; // best LOCAL score (direction-aware)
  /** Candidate ID whose archived source produced bestScore. Optional for legacy v1 state. */
  bestCandidateId?: string;
  bestSubmittedScore: number | null;
  dryLoopStreak: number;
  ideas: Idea[]; // current loop's ideas
  history: LoopSummary[];
  /** Active phase to re-enter when phase is "paused". Optional for v1 state compatibility. */
  resumePhase?: Phase;
  /** Loop-end bookkeeping persisted before church or final history commit. */
  pendingSummary?: LoopSummary;
  /** Last systemic loop failure and its automatic recovery status. */
  recovery?: RecoveryState;
  /** Worktree cleanup intents, persisted before removal and retried at checkpoints. */
  pendingCleanup?: string[];
  /** Submission queue and later official review results. Optional for legacy v1 state. */
  submissionReviews?: SubmissionReview[];
  challenge: ChallengeInfo;
  startedAt: string;
  updatedAt: string;
}

export const STATE_DIR_NAME = ".autoresearch";

export function statePaths(stateDir: string) {
  return {
    state: path.join(stateDir, "state.json"),
    config: path.join(stateDir, "config.json"),
    journal: path.join(stateDir, "journal.ndjson"),
    telemetry: path.join(stateDir, "telemetry.ndjson"),
    knowledgeBase: path.join(stateDir, "knowledge-base.md"),
    operatorSteering: path.join(stateDir, "operator-steering.json"),
    taskboard: path.join(stateDir, "taskboard.json"),
    leaderboard: path.join(stateDir, "leaderboard.json"),
    ledger: path.join(stateDir, "ledger.ndjson"),
    agentInvocations: path.join(stateDir, "agent-invocations.ndjson"),
    loopsDir: path.join(stateDir, "loops"),
    runsDir: path.join(stateDir, "runs"),
    resolvedAgentsDir: path.join(stateDir, "resolved-agents"),
    ideasDir: path.join(stateDir, "ideas"),
    logsDir: path.join(stateDir, "logs"),
    notesDir: path.join(stateDir, "notes"),
    mainSnapshotsDir: path.join(stateDir, "main-snapshots"),
    worktreesDir: path.join(stateDir, "worktrees"),
    metaHarnessDir: path.join(stateDir, "metaharness"),
  };
}

export function newLoopState(challenge: ChallengeInfo): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    phase: "uninitialized",
    loop: 0,
    bestScore: null,
    bestCandidateId: "baseline",
    bestSubmittedScore: null,
    dryLoopStreak: 0,
    ideas: [],
    history: [],
    challenge,
    startedAt: now,
    updatedAt: now,
  };
}

export function loadState(stateDir: string): LoopState | null {
  const state = readJsonIfExists<LoopState>(statePaths(stateDir).state);
  if (state && state.version !== 1) {
    throw new Error(`Unsupported state.json version ${String(state.version)} in ${stateDir}`);
  }
  return state;
}

export function saveState(stateDir: string, state: LoopState): void {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(statePaths(stateDir).state, state);
}
