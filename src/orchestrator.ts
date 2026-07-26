import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner, ProposedIdea } from "./agents/types.ts";
import type { AdvisorNote } from "./advisor.ts";
import { filterByThreshold, loadWatchdog } from "./advisor.ts";
import type {
  ChallengeAdapter,
  LeaderboardEntry,
  SubmitResult,
} from "./challenge/types.ts";
import type { HarnessConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import type { Phase } from "./phases.ts";
import { isIdeaTerminal } from "./phases.ts";
import { abortableDelay, retryBackoffMs, retryOperation } from "./retry.ts";
import type { Idea, LoopState, LoopSummary } from "./state.ts";
import { loadState, saveState, statePaths } from "./state.ts";
import { Taskboard } from "./taskboard.ts";
import { appendJournal, atomicWriteJson, betterScore, isImprovement, Mutex } from "./util.ts";
import { WorktreePool } from "./worktree.ts";

export type OrchestratorEvent =
  | { type: "phase"; phase: Phase; loop: number }
  | { type: "idea"; idea: Idea; message: string }
  | { type: "advice"; notes: AdvisorNote[]; loop: number }
  | { type: "church"; loop: number; noteFile: string }
  | { type: "submitted"; loop: number; ideaId: string; score: number; submissionId?: string }
  | { type: "log"; message: string };

export interface OrchestratorPorts {
  runner: AgentRunner;
  adapter: ChallengeAdapter;
  exec: ExecPort;
  emit: (ev: OrchestratorEvent) => void;
  signal?: AbortSignal;
  /** Injectable wait for deterministic tests; defaults to an abort-aware timer. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StatusReport {
  phase: Phase;
  loop: number;
  bestScore: number | null;
  bestSubmittedScore: number | null;
  dryLoopStreak: number;
  churchTriggerThreshold: number;
  ideas: { id: string; title: string; status: string; verifyAttempts: number; localScore?: number }[];
  taskboardOpen: number;
  lastAdvisorNotes: string[];
  recovery?: {
    scope: string;
    message: string;
    consecutiveFailures: number;
    nextRetryAt?: string;
  };
}

export class Orchestrator {
  private state: LoopState;
  private readonly paths: ReturnType<typeof statePaths>;
  private readonly worktrees: WorktreePool;
  private readonly benchLock = new Mutex();
  private readonly taskboard: Taskboard;

  constructor(
    private readonly repoRoot: string,
    private readonly stateDir: string,
    private readonly config: HarnessConfig,
    private readonly ports: OrchestratorPorts,
  ) {
    const state = loadState(stateDir);
    if (!state) throw new Error(`No state.json in ${stateDir}; run init first.`);
    this.state = state;
    this.paths = statePaths(stateDir);
    this.worktrees = new WorktreePool(repoRoot, this.paths.worktreesDir, ports.exec);
    this.taskboard = new Taskboard(stateDir);
  }

  status(): StatusReport {
    const lastSummary = this.state.history[this.state.history.length - 1];
    return {
      phase: this.state.phase,
      loop: this.state.loop,
      bestScore: this.state.bestScore,
      bestSubmittedScore: this.state.bestSubmittedScore,
      dryLoopStreak: this.state.dryLoopStreak,
      churchTriggerThreshold: this.config.churchTriggerThreshold,
      ideas: this.state.ideas.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        verifyAttempts: i.verifyAttempts,
        localScore: i.localScore,
      })),
      taskboardOpen: this.taskboard.openCount(),
      lastAdvisorNotes: lastSummary?.advisorNotes ?? [],
      ...(this.state.recovery
        ? {
            recovery: {
              scope: this.state.recovery.scope,
              message: this.state.recovery.message,
              consecutiveFailures: this.state.recovery.consecutiveFailures,
              nextRetryAt: this.state.recovery.nextRetryAt,
            },
          }
        : {}),
    };
  }

  /**
   * Run loops until maxLoops, done, abort, advisor blocker, or the systemic
   * failure circuit breaker. An unexpected failure resumes the same durable
   * loop checkpoint automatically instead of escaping to the extension.
   */
  async runUntilDone(): Promise<void> {
    let consecutiveFailures = 0;
    while (true) {
      if (this.aborted()) return this.pause("aborted");
      const loopInProgress = this.state.loop > this.state.history.length;
      if (
        !loopInProgress &&
        this.config.maxLoops !== null &&
        this.state.loop >= this.config.maxLoops
      ) {
        this.transition("done");
        return;
      }
      let summary: LoopSummary | null;
      try {
        summary = await this.runLoop();
      } catch (error) {
        if (this.aborted()) return this.pause("aborted");
        consecutiveFailures += 1;
        const message = errorMessage(error);
        const maxFailures = Math.max(1, this.config.resilience.maxConsecutiveLoopFailures);
        if (consecutiveFailures >= maxFailures) {
          this.recordRecovery(message, consecutiveFailures);
          this.emitLog(
            `recovery circuit open after ${consecutiveFailures} consecutive failure(s): ${message}`,
          );
          this.pause("recovery-circuit-breaker");
          return;
        }

        const delayMs = retryBackoffMs(
          this.config.resilience.loopFailureBaseDelayMs,
          this.config.resilience.loopFailureMaxDelayMs,
          consecutiveFailures,
        );
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        this.recordRecovery(message, consecutiveFailures, nextRetryAt);
        this.emitLog(
          `loop checkpoint failed (${consecutiveFailures}/${maxFailures}): ${message}; ` +
            `resuming the same checkpoint in ${delayMs}ms`,
        );
        await (this.ports.delay ?? abortableDelay)(delayMs, this.ports.signal);
        continue;
      }
      if ((this.state.phase as Phase) === "paused" || (this.state.phase as Phase) === "done") return;
      if (summary === null) return; // aborted mid-loop
      consecutiveFailures = 0;
      this.clearRecovery();
      await this.waitAfterMockLoop();
    }
  }

  /**
   * One full loop: sync → propose → parallel idea pipelines → finalize winner
   * → advisor → streak/church bookkeeping. Returns null if aborted mid-loop.
   */
  async runLoop(): Promise<LoopSummary | null> {
    await this.drainPendingCleanup();
    const loopInProgress = this.state.loop > this.state.history.length;
    const inferredResumePhase: Phase =
      this.state.ideas.length === 0
        ? "loop.proposing"
        : this.state.ideas.every((idea) => isIdeaTerminal(idea.status))
          ? "loop.finalizing"
          : "loop.ideas";
    const resumePhase = loopInProgress
      ? this.state.resumePhase ??
        (this.state.phase === "paused" ? inferredResumePhase : this.state.phase)
      : undefined;
    const resumeAtChurch = resumePhase === "church" || resumePhase === "god";
    const resumeAtFinalizing =
      resumePhase === "loop.finalizing" ||
      resumePhase === "loop.end" ||
      resumeAtChurch;
    const resumeAtEnd = resumePhase === "loop.end" || resumeAtChurch;

    if (!loopInProgress) {
      this.state.loop += 1;
      this.state.ideas = [];
      await this.syncLeaderboard();
      if (this.aborted()) return this.abortLoop();
      await this.propose();
    } else {
      this.emitLog(
        `resuming loop ${this.state.loop} from ${resumePhase ?? "saved state"} ` +
          `with ${this.state.ideas.length} idea(s)`,
      );
      if (this.state.ideas.length === 0) {
        if (resumePhase === "loop.syncing") {
          await this.syncLeaderboard();
          if (this.aborted()) return this.abortLoop();
        }
        await this.propose();
      }
    }
    if (this.aborted()) return this.abortLoop();

    // Parallel idea pipelines (implement → verify×N → bench-in-worktree).
    if (!resumeAtFinalizing) {
      this.transition("loop.ideas");
      if (this.aborted()) return this.abortLoop();
      await Promise.all(this.state.ideas.map((idea) => this.runIdeaPipeline(idea)));
      if (this.aborted()) return this.abortLoop();
    }

    // Winner selection + apply + re-verify + re-bench on main + submit.
    let improved: boolean;
    if (resumeAtEnd) {
      improved =
        this.state.pendingSummary?.improved ??
        this.state.ideas.some((idea) => idea.status === "done-improved");
    } else if (
      resumePhase === "loop.finalizing" &&
      this.state.ideas.every((idea) => isIdeaTerminal(idea.status))
    ) {
      // Submission may have completed immediately before the process stopped.
      // A terminal winner is the durable idempotency marker: never submit it again.
      improved = this.state.ideas.some((idea) => idea.status === "done-improved");
      if (!improved) this.restoreFinalizationSnapshot();
    } else {
      this.transition("loop.finalizing");
      if (this.aborted()) return this.abortLoop();
      improved = await this.finalizeLoop();
      if (this.aborted()) return this.abortLoop();
    }

    // Loop end: summary, advisor, streak, church.
    let summary = this.state.pendingSummary;
    if (!summary || (resumePhase !== "loop.end" && !resumeAtChurch)) {
      this.transition("loop.end");
      if (this.aborted()) return this.abortLoop();
      summary = {
        loop: this.state.loop,
        improved,
        bestScoreAfter: this.state.bestScore,
        ideas: this.state.ideas.map((idea) => ({
          id: idea.id,
          title: idea.title,
          status: idea.status,
          localScore: idea.localScore,
        })),
      };

      let advisorNotes: AdvisorNote[] = [];
      try {
        advisorNotes = await this.runAdvisor(summary);
      } catch (error) {
        if (this.aborted()) return this.abortLoop();
        this.emitLog(`advisor failed unexpectedly; continuing without advice · ${errorMessage(error)}`);
      }
      if (this.aborted()) return this.abortLoop();
      summary.advisorNotes = advisorNotes.map((note) => `[${note.severity}] ${note.text}`);
      this.state.dryLoopStreak = improved ? 0 : this.state.dryLoopStreak + 1;
      this.state.pendingSummary = summary;
      this.persist();
    }

    if (
      resumeAtChurch ||
      (this.config.churchTriggerThreshold > 0 &&
        this.state.dryLoopStreak >= this.config.churchTriggerThreshold)
    ) {
      let churchNote: string | undefined;
      try {
        churchNote = await this.goToChurch();
      } catch (error) {
        if (this.aborted()) return this.abortLoop();
        this.emitLog(
          `church reflection failed unexpectedly; continuing and preserving the dry-loop streak · ${errorMessage(error)}`,
        );
      }
      if (this.aborted()) return this.abortLoop();
      if (churchNote) {
        summary.churchNote = churchNote;
        this.state.dryLoopStreak = 0;
      }
      this.state.pendingSummary = summary;
      this.persist();
    }

    // Prune before committing loop completion. If cleanup is interrupted, the
    // pending summary and idea IDs remain durable so resume can retry it.
    // Failed worktrees are intentionally kept for debugging.
    for (const idea of summary.ideas) {
      if (idea.status !== "failed") await this.cleanupWorktree(idea.id);
    }
    this.discardFinalizationSnapshot();

    this.state.history.push(summary);
    this.state.ideas = [];
    this.state.pendingSummary = undefined;
    this.state.resumePhase = undefined;
    this.persist();

    if (summary.advisorNotes?.some((note) => note.startsWith("[blocker]"))) {
      this.emitLog("advisor blocker raised; pausing the loop");
      this.pause("advisor-blocker");
      return summary;
    }

    return summary;
  }

  // ---------------------------------------------------------------- phases

  private async syncLeaderboard(): Promise<void> {
    this.transition("loop.syncing");
    if (this.aborted()) return;
    let syncResult: { ok: boolean; raw: string };
    try {
      syncResult = await this.retryResult(
        "leaderboard sync",
        this.config.resilience.commandMaxAttempts,
        () => this.ports.adapter.sync(this.ports.signal),
        (result) => result.ok,
      );
    } catch (error) {
      if (this.aborted()) return;
      const cached = this.loadCachedLeaderboard();
      this.emitLog(
        `leaderboard sync threw after ${this.config.resilience.commandMaxAttempts} attempt(s); ` +
          `continuing with ${cached.length} cached submission(s) · ${errorMessage(error)}`,
      );
      if (cached.length > 0) this.appendKnowledge(this.leaderboardDigest(cached));
      return;
    }
    if (!syncResult.ok) {
      const cached = this.loadCachedLeaderboard();
      this.emitLog(
        `leaderboard sync unavailable after ${this.config.resilience.commandMaxAttempts} attempt(s); ` +
          `continuing with ${cached.length} cached submission(s) · ${firstLine(syncResult.raw)}`,
      );
      if (cached.length > 0) this.appendKnowledge(this.leaderboardDigest(cached));
      return;
    }

    let entries: LeaderboardEntry[];
    try {
      entries = await this.retryResult(
        "leaderboard fetch",
        this.config.resilience.commandMaxAttempts,
        () => this.ports.adapter.listSubmissions(true, this.ports.signal),
        () => true,
      );
    } catch (error) {
      entries = this.loadCachedLeaderboard();
      this.emitLog(
        `leaderboard fetch unavailable; continuing with ${entries.length} cached submission(s) · ${errorMessage(error)}`,
      );
    }
    atomicWriteJson(this.paths.leaderboard, { fetchedAt: new Date().toISOString(), entries });
    this.appendKnowledge(this.leaderboardDigest(entries));
    this.emitLog(`sync: ${entries.length} submissions on leaderboard · ${syncResult.raw.split("\n")[0] ?? ""}`);
  }

  private leaderboardDigest(entries: LeaderboardEntry[]): string {
    if (entries.length === 0) return `\n### Loop ${this.state.loop} leaderboard\n(no submissions yet)\n`;
    const sorted = [...entries].sort((a, b) =>
      this.state.challenge.direction === "+" ? b.score - a.score : a.score - b.score,
    );
    const top = sorted
      .slice(0, 5)
      .map((e) => `- ${e.id} · score ${e.score} · ${e.author}${e.promoted ? " · promoted" : ""}`)
      .join("\n");
    return `\n### Loop ${this.state.loop} leaderboard (top ${Math.min(5, sorted.length)})\n${top}\n`;
  }

  private async propose(): Promise<void> {
    this.transition("loop.proposing");
    if (this.aborted()) return;
    const result = await this.retryResult(
      "professor proposal",
      this.config.resilience.agentMaxAttempts,
      () =>
        this.ports.runner.run({
          role: "professor",
          kind: "propose",
          cwd: this.repoRoot,
          stateDir: this.stateDir,
          input: {
            loop: this.state.loop,
            maxIdeasPerLoop: this.config.maxIdeasPerLoop,
            bestScore: this.state.bestScore,
            direction: this.state.challenge.direction,
            dryLoopStreak: this.state.dryLoopStreak,
            history: this.state.history,
          },
          signal: this.ports.signal,
        }),
      (candidate) => {
        if (!candidate.ok) return false;
        const ideas = candidate.structured?.ideas;
        return Array.isArray(ideas) && ideas.length > 0;
      },
    );
    if (!result.ok) {
      if (this.aborted()) return;
      throw new Error(
        `Professor propose failed after ${this.config.resilience.agentMaxAttempts} attempt(s): ${
          result.error ?? result.output
        }`,
      );
    }
    const proposed = ((result.structured?.ideas as ProposedIdea[] | undefined) ?? []).slice(
      0,
      this.config.maxIdeasPerLoop,
    );
    if (proposed.length === 0) {
      throw new Error(
        `Professor proposed zero ideas after ${this.config.resilience.agentMaxAttempts} attempt(s); ` +
          "the same loop checkpoint will be retried.",
      );
    }

    const loopDirName = `loop-${String(this.state.loop).padStart(3, "0")}`;
    fs.mkdirSync(path.join(this.paths.ideasDir, loopDirName), { recursive: true });
    this.state.ideas = proposed.map((p, index) => {
      const id = `L${String(this.state.loop).padStart(3, "0")}-I${index + 1}`;
      const specRel = path.join("ideas", loopDirName, `idea-${index + 1}.md`);
      fs.writeFileSync(path.join(this.stateDir, specRel), `# ${p.title}\n\n${p.spec}\n`);
      return {
        id,
        loop: this.state.loop,
        title: p.title,
        specFile: specRel,
        status: "proposed" as const,
        verifyAttempts: 0,
      };
    });
    this.persist();
    this.emitLog(`professor proposed ${this.state.ideas.length} idea(s) for loop ${this.state.loop}`);
  }

  /** implement → verify (retry up to maxVerifyAttempts) → bench, all inside the idea's worktree. */
  private async runIdeaPipeline(idea: Idea): Promise<void> {
    if (isIdeaTerminal(idea.status)) return;
    if (idea.status === "benching" && idea.localScore !== undefined) return;
    const ideaIndex = this.state.ideas.indexOf(idea);
    try {
      if (!idea.worktreePath) {
        idea.worktreePath = await this.retryResult(
          `worktree create ${idea.id}`,
          this.config.resilience.commandMaxAttempts,
          () => this.worktrees.create(idea.id),
          () => true,
        );
        await this.retryResult(
          `worktree seed ${idea.id}`,
          this.config.resilience.commandMaxAttempts,
          () => this.worktrees.seedUntracked(idea.id),
          () => true,
        );
        this.persist();
      }

      while (idea.verifyAttempts < this.config.maxVerifyAttempts) {
        if (this.aborted()) return;
        idea.status = "implementing";
        this.persist();
        this.emitIdea(idea, `implementing (attempt ${idea.verifyAttempts + 1}/${this.config.maxVerifyAttempts})`);

        const impl = await this.retryResult(
          `PhD implementation ${idea.id}`,
          this.config.resilience.agentMaxAttempts,
          () =>
            this.ports.runner.run({
              role: "phd",
              kind: "implement",
              cwd: idea.worktreePath!,
              stateDir: this.stateDir,
              input: {
                loop: this.state.loop,
                ideaIndex,
                attempt: idea.verifyAttempts + 1,
                ideaId: idea.id,
                specFile: path.join(this.stateDir, idea.specFile),
                maxVerifyAttempts: this.config.maxVerifyAttempts,
                editablePaths: this.state.challenge.editablePaths,
                verifyCommand: this.state.challenge.verifyCommand,
                lastVerifyError: idea.lastVerifyError,
              },
              signal: this.ports.signal,
            }),
          (result) => result.ok,
        );
        if (!impl.ok) {
          if (this.aborted()) return;
          idea.lastVerifyError = impl.error ?? impl.output;
          idea.verifyAttempts += 1;
          this.persist();
          continue;
        }

        idea.status = "verifying";
        this.persist();
        const verify = await this.retryResult(
          `verify ${idea.id}`,
          this.config.resilience.commandMaxAttempts,
          () => this.ports.adapter.verify(idea.worktreePath, this.ports.signal),
          (result) => result.ok,
        );
        if (this.aborted()) return;
        idea.verifyAttempts += 1;
        if (verify.ok) {
          idea.lastVerifyError = undefined;
          break;
        }
        idea.lastVerifyError = verify.raw;
        this.persist();
        this.emitIdea(idea, `verify failed (attempt ${idea.verifyAttempts}/${this.config.maxVerifyAttempts})`);
      }

      if (idea.lastVerifyError !== undefined || idea.status === "implementing") {
        idea.status = "failed";
        this.persist();
        this.emitIdea(idea, `failed after ${idea.verifyAttempts} verify attempt(s); worktree kept for debugging`);
        await this.writeIdeaNote(idea, ideaIndex);
        return;
      }

      // Bench serialized across ideas: honest scores, no resource contention.
      idea.status = "benching";
      this.persist();
      const bench = await this.benchLock.runExclusive(() =>
        this.retryResult(
          `benchmark ${idea.id}`,
          this.config.resilience.commandMaxAttempts,
          () => this.ports.adapter.bench(idea.worktreePath, this.ports.signal),
          (result) => result.ok && result.score !== undefined,
        ),
      );
      if (this.aborted()) return;
      if (!bench.ok || bench.score === undefined) {
        idea.status = "failed";
        idea.lastVerifyError = bench.raw;
        this.persist();
        this.emitIdea(idea, "benchmark failed; worktree kept for debugging");
        await this.writeIdeaNote(idea, ideaIndex);
        return;
      }
      idea.localScore = bench.score;
      // Terminal status decided in finalizeLoop (needs cross-idea comparison).
      idea.status = "benching";
      this.persist();
      this.emitIdea(idea, `benched: local score ${bench.score}`);
    } catch (err) {
      if (this.aborted()) return;
      idea.status = "failed";
      idea.lastVerifyError = err instanceof Error ? err.message : String(err);
      this.persist();
      this.emitIdea(idea, `pipeline error: ${idea.lastVerifyError}`);
    }
  }

  /**
   * Try improving candidates in score order. A candidate-specific main-checkout
   * gate failure falls through to the next candidate; a systemic submit outage
   * leaves the candidate resumable and lets runUntilDone retry this checkpoint.
   */
  private async finalizeLoop(): Promise<boolean> {
    const benched = this.state.ideas.filter(
      (idea) => idea.status === "benching" && idea.localScore !== undefined,
    );
    const improving = benched.filter((idea) =>
      isImprovement(
        this.state.bestScore,
        idea.localScore!,
        this.state.challenge.direction,
        this.config.minImprovement,
      ),
    );
    improving.sort((left, right) =>
      this.state.challenge.direction === "+"
        ? right.localScore! - left.localScore!
        : left.localScore! - right.localScore!,
    );

    if (improving.length > 0) {
      await this.retryResult(
        `snapshot main checkout for loop ${this.state.loop}`,
        this.config.resilience.commandMaxAttempts,
        async () =>
          this.worktrees.ensureMainSnapshot(
            this.finalizationSnapshotDir(),
            this.state.challenge.editablePaths,
          ),
        () => true,
      );
    }

    for (const idea of benched.filter((candidate) => !improving.includes(candidate))) {
      idea.status = "done-no-improvement";
      this.persist();
      await this.writeIdeaNote(idea, this.state.ideas.indexOf(idea));
    }

    for (const candidate of improving) {
      if (this.aborted()) return false;

      try {
        await this.retryResult(
          `apply ${candidate.id} to main`,
          this.config.resilience.commandMaxAttempts,
          async () => {
            this.worktrees.applyToMain(candidate.id, this.state.challenge.editablePaths);
          },
          () => true,
        );
      } catch (error) {
        await this.failFinalist(
          candidate,
          `Applying the worktree to main failed: ${errorMessage(error)}`,
          "apply to main failed; trying the next qualifying idea",
        );
        continue;
      }

      const verify = await this.retryResult(
        `main verify ${candidate.id}`,
        this.config.resilience.commandMaxAttempts,
        () => this.ports.adapter.verify(undefined, this.ports.signal),
        (result) => result.ok,
      );
      if (this.aborted()) return false;
      if (!verify.ok) {
        await this.failFinalist(
          candidate,
          `Re-verify on main repo failed after applying worktree diff:\n${verify.raw}`,
          "re-verify on main failed; trying the next qualifying idea",
        );
        continue;
      }

      const bench = await this.retryResult(
        `main benchmark ${candidate.id}`,
        this.config.resilience.commandMaxAttempts,
        () => this.ports.adapter.bench(undefined, this.ports.signal),
        (result) => result.ok && result.score !== undefined,
      );
      if (this.aborted()) return false;
      if (!bench.ok || bench.score === undefined) {
        await this.failFinalist(
          candidate,
          `Re-bench on main repo failed:\n${bench.raw}`,
          "re-bench on main failed; trying the next qualifying idea",
        );
        continue;
      }
      if (
        !isImprovement(
          this.state.bestScore,
          bench.score,
          this.state.challenge.direction,
          this.config.minImprovement,
        )
      ) {
        candidate.status = "done-no-improvement";
        candidate.localScore = bench.score;
        this.persist();
        await this.writeIdeaNote(candidate, this.state.ideas.indexOf(candidate));
        continue;
      }

      candidate.localScore = bench.score;

      // Submission notes are required and public in Yukon challenges.
      const noteRel = path.join(
        "notes",
        `submission-loop-${String(this.state.loop).padStart(3, "0")}-${candidate.id}.md`,
      );
      const notePath = path.join(this.stateDir, noteRel);
      fs.writeFileSync(
        notePath,
        [
          `# ${candidate.title}`,
          "",
          `Local score: ${bench.score}. Idea ${candidate.id}, loop ${this.state.loop}.`,
          "",
          fs.readFileSync(path.join(this.stateDir, candidate.specFile), "utf8"),
        ].join("\n"),
      );

      const submit = await this.submitWithReconciliation(notePath, bench.score);
      if (this.aborted()) return false;
      if (!submit.ok) {
        candidate.lastVerifyError =
          `Submission failed after ${this.config.resilience.submitMaxAttempts} attempt(s):\n${submit.raw}`;
        // Keep it nonterminal so finalization resumes this exact candidate.
        candidate.status = "benching";
        this.persist();
        this.emitIdea(
          candidate,
          `submission unavailable after ${this.config.resilience.submitMaxAttempts} attempt(s); ` +
            "preserving the candidate and retrying the loop checkpoint",
        );
        throw new Error(
          `Submission for ${candidate.id} failed after ${this.config.resilience.submitMaxAttempts} attempt(s): ` +
            firstLine(submit.raw),
        );
      }

      candidate.lastVerifyError = undefined;
      candidate.status = "done-improved";
      candidate.submitted = { submissionId: submit.submissionId, noteFile: noteRel };
      this.state.bestScore =
        this.state.bestScore === null
          ? bench.score
          : betterScore(this.state.bestScore, bench.score, this.state.challenge.direction);
      this.state.bestSubmittedScore =
        this.state.bestSubmittedScore === null
          ? bench.score
          : betterScore(
              this.state.bestSubmittedScore,
              bench.score,
              this.state.challenge.direction,
            );

      for (const other of improving) {
        if (other === candidate || other.status !== "benching") continue;
        other.status = "done-superseded";
        this.persist();
        await this.writeIdeaNote(other, this.state.ideas.indexOf(other));
      }

      this.persist();
      this.ports.emit({
        type: "submitted",
        loop: this.state.loop,
        ideaId: candidate.id,
        score: bench.score,
        submissionId: submit.submissionId,
      });
      this.appendKnowledge(
        `\n### Loop ${this.state.loop} submission\n- ${candidate.id} "${candidate.title}" · ` +
          `local score ${bench.score} · submitted (${submit.submissionId ?? "id unknown"})\n`,
      );
      this.discardFinalizationSnapshot();
      return true;
    }

    this.restoreFinalizationSnapshot();
    return false;
  }

  private async failFinalist(
    idea: Idea,
    diagnostic: string,
    message: string,
  ): Promise<void> {
    idea.status = "failed";
    idea.lastVerifyError = diagnostic;
    this.persist();
    this.emitIdea(idea, message);
    await this.writeIdeaNote(idea, this.state.ideas.indexOf(idea));
  }

  /**
   * Reconcile before every submit call. If a previous ambiguous CLI failure
   * actually reached the server, the matching "my submissions" score acts as
   * the remote idempotency marker and prevents a duplicate submission.
   */
  private async submitWithReconciliation(
    notePath: string,
    score: number,
  ): Promise<SubmitResult> {
    return this.retryResult(
      "submission",
      this.config.resilience.submitMaxAttempts,
      async () => {
        try {
          const mine = await this.retryResult(
            "submission reconciliation",
            this.config.resilience.commandMaxAttempts,
            () => this.ports.adapter.listSubmissions(false, this.ports.signal),
            () => true,
          );
          const existing = mine.find((entry) => sameScore(entry.score, score));
          if (existing) {
            return {
              ok: true,
              submissionId: existing.id,
              promoted: existing.promoted,
              raw: `Reconciled existing submission ${existing.id} at score ${existing.score}.`,
            };
          }
        } catch (error) {
          if (this.aborted()) throw error;
          this.emitLog(`submission reconciliation unavailable: ${errorMessage(error)}`);
        }

        return this.ports.adapter.submit(
          {
            noteFile: notePath,
            model: this.state.challenge.submitNeedsModel
              ? this.config.submitModelName ?? "unknown"
              : undefined,
          },
          this.ports.signal,
        );
      },
      (result) => result.ok,
    );
  }

  private async writeIdeaNote(idea: Idea, ideaIndex: number): Promise<void> {
    const noteRel = path.join("notes", `loop-${String(this.state.loop).padStart(3, "0")}-${idea.id}.md`);
    let result;
    try {
      result = await this.retryResult(
        `hypothesis note ${idea.id}`,
        this.config.resilience.agentMaxAttempts,
        () =>
          this.ports.runner.run({
            role: "phd",
            kind: "write-note",
            cwd: this.repoRoot,
            stateDir: this.stateDir,
            input: {
              notePath: path.join(this.stateDir, noteRel),
              ideaTitle: idea.title,
              ideaIndex,
              localScore: idea.localScore,
              bestScore: this.state.bestScore,
              status: idea.status,
              lastVerifyError: idea.lastVerifyError,
            },
            signal: this.ports.signal,
          }),
        (candidate) => candidate.ok,
      );
    } catch (error) {
      if (!this.aborted()) {
        this.emitLog(`hypothesis note ${idea.id} skipped · ${errorMessage(error)}`);
      }
      return;
    }
    if (result.ok) {
      idea.noteFile = noteRel;
      this.persist();
      this.appendKnowledge(
        `\n### ${idea.id} "${idea.title}" → ${idea.status}\n${result.output
          .split("\n")
          .slice(0, 6)
          .join("\n")}\n`,
      );
    } else if (!this.aborted()) {
      this.emitLog(
        `hypothesis note ${idea.id} skipped after ${this.config.resilience.agentMaxAttempts} attempt(s): ` +
          firstLine(result.error ?? result.output),
      );
    }
  }

  private async runAdvisor(summary: LoopSummary): Promise<AdvisorNote[]> {
    if (!this.config.advisor.enabled) return [];
    const watchdog = loadWatchdog(this.repoRoot, this.config.advisor.watchdogFile);
    const prev = this.state.history[this.state.history.length - 1];
    const stateDiff = {
      dryLoopStreak: summary.improved ? 0 : this.state.dryLoopStreak + 1,
      improved: summary.improved,
      submitted: summary.ideas.some((i) => i.status === "done-improved"),
      ideaFailed: summary.ideas.some((i) => i.status === "failed"),
      scoreDelta:
        prev?.bestScoreAfter != null && summary.bestScoreAfter != null
          ? summary.bestScoreAfter - prev.bestScoreAfter
          : 0,
    };
    const result = await this.retryResult(
      "advisor review",
      this.config.resilience.agentMaxAttempts,
      () =>
        this.ports.runner.run({
          role: "advisor",
          kind: "advise",
          cwd: this.repoRoot,
          stateDir: this.stateDir,
          input: {
            rules: watchdog.rules,
            stateDiff,
            summary,
            watchdogFile: this.config.advisor.watchdogFile,
          },
          signal: this.ports.signal,
        }),
      (candidate) => candidate.ok,
    );
    if (!result.ok) {
      if (!this.aborted()) {
        this.emitLog(
          `advisor unavailable after ${this.config.resilience.agentMaxAttempts} attempt(s); ` +
            `continuing without advice · ${firstLine(result.error ?? result.output)}`,
        );
      }
      return [];
    }
    const notes = filterByThreshold(
      ((result.structured?.notes as AdvisorNote[] | undefined) ?? []).filter(
        (n) => n && typeof n.text === "string",
      ),
      watchdog.severityThreshold,
    );
    if (notes.length > 0) {
      const noteRel = path.join("notes", `advisor-${String(this.state.loop).padStart(3, "0")}.md`);
      fs.writeFileSync(
        path.join(this.stateDir, noteRel),
        `# Advisor notes, loop ${this.state.loop}\n\n${notes.map((n) => `- **${n.severity}**: ${n.text}`).join("\n")}\n`,
      );
      this.appendKnowledge(
        `\n### Advisor, loop ${this.state.loop}\n${notes.map((n) => `- [${n.severity}] ${n.text}`).join("\n")}\n`,
      );
      this.ports.emit({ type: "advice", notes, loop: this.state.loop });
    }
    return notes;
  }

  private async goToChurch(): Promise<string | undefined> {
    this.transition("church");
    if (this.aborted()) return undefined;
    const noteRel = path.join("notes", `church-${String(this.state.loop).padStart(3, "0")}.md`);
    const result = await this.retryResult(
      "church reflection",
      this.config.resilience.agentMaxAttempts,
      () =>
        this.ports.runner.run({
          role: "god",
          kind: "church",
          cwd: this.repoRoot,
          stateDir: this.stateDir,
          input: {
            notePath: path.join(this.stateDir, noteRel),
            loop: this.state.loop,
            streak: this.state.dryLoopStreak,
            history: this.state.history,
          },
          signal: this.ports.signal,
        }),
      (candidate) => candidate.ok,
    );
    if (result.ok) {
      this.appendKnowledge(
        `\n### After loop ${this.state.loop}: the Professor went to church\n` +
          `See ${noteRel}. The plateau was reflected on and the strategy was refocused.\n`,
      );
      this.ports.emit({ type: "church", loop: this.state.loop, noteFile: noteRel });
      return noteRel;
    }
    if (!this.aborted()) {
      this.emitLog(
        `church reflection unavailable after ${this.config.resilience.agentMaxAttempts} attempt(s); ` +
          `continuing and preserving the dry-loop streak · ${firstLine(result.error ?? result.output)}`,
      );
    }
    return undefined;
  }

  // ------------------------------------------------------------- plumbing

  private transition(phase: Phase): void {
    this.state.phase = phase;
    this.state.resumePhase = undefined;
    this.persist();
    appendJournal(this.paths.journal, { phase, loop: this.state.loop });
    this.ports.emit({ type: "phase", phase, loop: this.state.loop });
  }

  private persist(): void {
    saveState(this.stateDir, this.state);
  }

  private appendKnowledge(text: string): void {
    fs.appendFileSync(this.paths.knowledgeBase, text);
  }

  private async retryResult<T>(
    label: string,
    maxAttempts: number,
    operation: (attempt: number) => Promise<T>,
    isSuccess: (value: T) => boolean,
  ): Promise<T> {
    return retryOperation({
      maxAttempts,
      baseDelayMs: this.config.resilience.retryBaseDelayMs,
      maxDelayMs: this.config.resilience.retryMaxDelayMs,
      operation,
      isSuccess,
      signal: this.ports.signal,
      delay: this.ports.delay,
      onRetry: ({ attempt, maxAttempts: total, nextDelayMs, error, value }) => {
        const detail = error === undefined ? retryValueDetail(value) : errorMessage(error);
        this.emitLog(
          `${label} failed (attempt ${attempt}/${total}); retrying in ${nextDelayMs}ms` +
            (detail ? ` · ${firstLine(detail)}` : ""),
        );
      },
    });
  }

  private loadCachedLeaderboard(): LeaderboardEntry[] {
    if (!fs.existsSync(this.paths.leaderboard)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths.leaderboard, "utf8")) as {
        entries?: unknown;
      };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isLeaderboardEntry);
    } catch {
      return [];
    }
  }

  private finalizationSnapshotDir(): string {
    return path.join(
      this.paths.mainSnapshotsDir,
      `loop-${String(this.state.loop).padStart(3, "0")}`,
    );
  }

  private restoreFinalizationSnapshot(): void {
    const snapshotDir = this.finalizationSnapshotDir();
    if (!fs.existsSync(path.join(snapshotDir, ".complete"))) return;
    this.worktrees.restoreMainSnapshot(snapshotDir, this.state.challenge.editablePaths);
    this.worktrees.discardMainSnapshot(snapshotDir);
    this.emitLog(`restored main checkout after loop ${this.state.loop} produced no shippable winner`);
  }

  private discardFinalizationSnapshot(): void {
    this.worktrees.discardMainSnapshot(this.finalizationSnapshotDir());
  }

  private recordRecovery(
    message: string,
    consecutiveFailures: number,
    nextRetryAt?: string,
  ): void {
    this.state.recovery = {
      scope: this.state.phase,
      message,
      consecutiveFailures,
      failedAt: new Date().toISOString(),
      ...(nextRetryAt ? { nextRetryAt } : {}),
    };
    this.persist();
  }

  private clearRecovery(): void {
    if (!this.state.recovery) return;
    this.state.recovery = undefined;
    this.persist();
  }

  private async cleanupWorktree(ideaId: string): Promise<void> {
    try {
      await this.retryResult(
        `worktree cleanup ${ideaId}`,
        this.config.resilience.commandMaxAttempts,
        () => this.worktrees.remove(ideaId),
        () => true,
      );
      if (this.state.pendingCleanup?.includes(ideaId)) {
        this.state.pendingCleanup = this.state.pendingCleanup.filter((id) => id !== ideaId);
        this.persist();
      }
    } catch (error) {
      if (this.aborted()) return;
      this.state.pendingCleanup = Array.from(
        new Set([...(this.state.pendingCleanup ?? []), ideaId]),
      );
      this.persist();
      this.emitLog(
        `worktree cleanup ${ideaId} deferred to the next checkpoint · ${errorMessage(error)}`,
      );
    }
  }

  private async drainPendingCleanup(): Promise<void> {
    for (const ideaId of [...(this.state.pendingCleanup ?? [])]) {
      if (this.aborted()) return;
      await this.cleanupWorktree(ideaId);
    }
  }

  private aborted(): boolean {
    return this.ports.signal?.aborted ?? false;
  }

  private async waitAfterMockLoop(): Promise<void> {
    const delayMs = this.config.mockLoopDelayMs;
    if (this.config.runner !== "mock" || !Number.isFinite(delayMs) || delayMs <= 0) return;
    this.emitLog(`mock demo: waiting ${delayMs}ms after loop ${this.state.loop}`);
    await (this.ports.delay ?? abortableDelay)(delayMs, this.ports.signal);
  }

  private abortLoop(): null {
    this.pause("aborted");
    return null;
  }

  private pause(reason: string): void {
    if (this.state.phase !== "paused") this.state.resumePhase = this.state.phase;
    this.state.phase = "paused";
    this.persist();
    appendJournal(this.paths.journal, { phase: "paused", reason, loop: this.state.loop });
    this.ports.emit({ type: "phase", phase: "paused", loop: this.state.loop });
  }

  private emitIdea(idea: Idea, message: string): void {
    appendJournal(this.paths.journal, { idea: idea.id, status: idea.status, message });
    this.ports.emit({ type: "idea", idea, message });
  }

  private emitLog(message: string): void {
    appendJournal(this.paths.journal, { message });
    this.ports.emit({ type: "log", message });
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0] ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryValueDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["error", "raw", "output"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

function sameScore(left: number, right: number): boolean {
  const tolerance = Math.max(1, Math.abs(left), Math.abs(right)) * 1e-12;
  return Math.abs(left - right) <= tolerance;
}

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<LeaderboardEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.score === "number" &&
    Number.isFinite(entry.score) &&
    typeof entry.author === "string" &&
    typeof entry.promoted === "boolean"
  );
}
