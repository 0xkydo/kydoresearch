import * as path from "node:path";
import type { IdeaStatus, Phase } from "./phases.ts";
import type { Direction } from "./util.ts";
import { atomicWriteJson, readJsonIfExists } from "./util.ts";

export interface Idea {
  id: string; // "L003-I2"
  loop: number;
  title: string;
  specFile: string; // ideas/loop-003/idea-2.md (relative to stateDir)
  status: IdeaStatus;
  verifyAttempts: number; // 0..maxVerifyAttempts
  lastVerifyError?: string;
  localScore?: number;
  worktreePath?: string; // present while in flight (or kept on failure for debugging)
  noteFile?: string; // notes/<...>.md (relative to stateDir)
  submitted?: { submissionId?: string; noteFile: string };
}

export interface LoopSummary {
  loop: number;
  improved: boolean;
  bestScoreAfter: number | null;
  ideas: { id: string; title: string; status: IdeaStatus; localScore?: number }[];
  godConversation?: string; // notes file path
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
}

export interface LoopState {
  version: 1;
  phase: Phase;
  loop: number; // current loop number, 1-based; 0 before first loop
  bestScore: number | null; // best LOCAL score (direction-aware)
  bestSubmittedScore: number | null;
  dryLoopStreak: number;
  ideas: Idea[]; // current loop's ideas
  history: LoopSummary[];
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
    knowledgeBase: path.join(stateDir, "knowledge-base.md"),
    taskboard: path.join(stateDir, "taskboard.json"),
    leaderboard: path.join(stateDir, "leaderboard.json"),
    ideasDir: path.join(stateDir, "ideas"),
    logsDir: path.join(stateDir, "logs"),
    notesDir: path.join(stateDir, "notes"),
    worktreesDir: path.join(stateDir, "worktrees"),
  };
}

export function newLoopState(challenge: ChallengeInfo): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    phase: "uninitialized",
    loop: 0,
    bestScore: null,
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
