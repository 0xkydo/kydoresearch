import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner, ProposedIdea } from "./agents/types.ts";
import type { AdvisorNote } from "./advisor.ts";
import { filterByThreshold, loadWatchdog } from "./advisor.ts";
import {
  appendLedgerRecord,
  candidateRunPaths,
  createCandidateRun,
  isCandidateRunSealed,
  readLedger,
  readRunRecord,
  sealCandidateRun,
  snapshotEditableSource,
  writeCandidateDiff,
  writeCandidateIntegrity,
  writeCandidateMetrics,
  writeCandidateParent,
  writeCandidatePostmortem,
  writeCandidateProposal,
  writeCandidateTask,
} from "./archive.ts";
import type { ChallengeAdapter, LeaderboardEntry } from "./challenge/types.ts";
import type { HarnessConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import type {
  AdvisorTaskV1,
  CandidateIntegrityV1,
  CandidateMetricsV1,
  CandidateParentV1,
  CandidateProposalV1,
  CandidateTerminalStatus,
  EvaluationCommandV1,
  GodConversationTaskV1,
  PhdImplementationTaskV1,
  PhdPostmortemTaskV1,
  ProfessorProposalTaskV1,
  ProfessorProposalResultV1,
} from "./experiments.ts";
import {
  EXPERIMENT_SCHEMA_VERSION,
  normalizeProposal,
  validateResearchTask,
} from "./experiments.ts";
import { auditCandidateIntegrity } from "./integrity.ts";
import type { Phase } from "./phases.ts";
import { isIdeaTerminal } from "./phases.ts";
import type { Idea, LoopState, LoopSummary } from "./state.ts";
import type { MetaHarnessStatus } from "./metaharness.ts";
import { loadState, saveState, statePaths } from "./state.ts";
import { Taskboard } from "./taskboard.ts";
import { appendJournal, atomicWriteJson, betterScore, isImprovement, Mutex } from "./util.ts";
import { WorktreePool } from "./worktree.ts";

const STATE_DIRECTORY_SENTINEL = ".autoresearch/**";

export type OrchestratorEvent =
  | { type: "phase"; phase: Phase; loop: number }
  | { type: "idea"; idea: Idea; message: string }
  | { type: "advice"; notes: AdvisorNote[]; loop: number }
  | { type: "god"; loop: number; noteFile: string }
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
  godTriggerThreshold: number;
  ideas: { id: string; title: string; status: string; verifyAttempts: number; localScore?: number }[];
  taskboardOpen: number;
  lastAdvisorNotes: string[];
  metaHarness?: MetaHarnessStatus;
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
      godTriggerThreshold: this.config.godTriggerThreshold,
      ideas: this.state.ideas.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        verifyAttempts: i.verifyAttempts,
        localScore: i.localScore,
      })),
      taskboardOpen: this.taskboard.openCount(),
      lastAdvisorNotes: lastSummary?.advisorNotes ?? [],
    };
  }

  /** Run loops until maxLoops, done, abort, or advisor blocker. */
  async runUntilDone(): Promise<void> {
    while (true) {
      if (this.aborted()) return this.pause("aborted");
      if (this.config.maxLoops !== null && this.state.loop >= this.config.maxLoops) {
        this.transition("done");
        return;
      }
      const summary = await this.runLoop();
      if ((this.state.phase as Phase) === "paused" || (this.state.phase as Phase) === "done") return;
      if (summary === null) return; // aborted mid-loop
      await this.waitAfterMockLoop();
    }
  }

  /**
   * One full loop: sync → propose → parallel idea pipelines → finalize winner
   * → advisor → streak/god bookkeeping. Returns null if aborted mid-loop.
   */
  async runLoop(): Promise<LoopSummary | null> {
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
    const resumeAtFinalizing =
      resumePhase === "loop.finalizing" ||
      resumePhase === "loop.end" ||
      resumePhase === "god";
    const resumeAtEnd = resumePhase === "loop.end" || resumePhase === "god";

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
    } else {
      this.transition("loop.finalizing");
      if (this.aborted()) return this.abortLoop();
      improved = await this.finalizeLoop();
      if (this.aborted()) return this.abortLoop();
    }

    // Seal every terminal candidate before advisor/search consumers inspect
    // this loop, and before successful worktrees are pruned.
    for (const idea of this.state.ideas) {
      if (!isIdeaTerminal(idea.status)) continue;
      await this.archiveIdea(idea);
    }
    this.persist();

    // Loop end: summary, advisor, streak, god.
    let summary = this.state.pendingSummary;
    if (!summary || (resumePhase !== "loop.end" && resumePhase !== "god")) {
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

      const advisorNotes = await this.runAdvisor(summary);
      if (this.aborted()) return this.abortLoop();
      summary.advisorNotes = advisorNotes.map((note) => `[${note.severity}] ${note.text}`);
      this.state.dryLoopStreak = improved ? 0 : this.state.dryLoopStreak + 1;
      this.state.pendingSummary = summary;
      this.persist();
    }

    if (
      resumePhase === "god" ||
      (this.config.godTriggerThreshold > 0 &&
        this.state.dryLoopStreak >= this.config.godTriggerThreshold)
    ) {
      summary.godConversation = await this.godConversation();
      if (this.aborted()) return this.abortLoop();
      this.state.dryLoopStreak = 0;
      this.state.pendingSummary = summary;
      this.persist();
    }

    // Prune before committing loop completion. If cleanup is interrupted, the
    // pending summary and idea IDs remain durable so resume can retry it.
    // Failed worktrees are intentionally kept for debugging.
    for (const idea of summary.ideas) {
      if (idea.status !== "failed") await this.worktrees.remove(idea.id).catch(() => {});
    }

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
    const [entries, syncResult] = await Promise.all([
      this.ports.adapter.listSubmissions(true, this.ports.signal),
      this.ports.adapter.sync(this.ports.signal),
    ]);
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
    const currentBestCandidateId = this.state.bestCandidateId ?? "baseline";
    this.ensureParentArtifact(currentBestCandidateId);
    const loopDir = path.join(
      this.paths.loopsDir,
      `loop-${String(this.state.loop).padStart(3, "0")}`,
    );
    fs.mkdirSync(loopDir, { recursive: true });
    const professorTaskPath = path.join(loopDir, "professor-task.json");
    const professorTask: ProfessorProposalTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `L${String(this.state.loop).padStart(3, "0")}-professor`,
      kind: "propose",
      role: "professor",
      taskPath: professorTaskPath,
      stateDir: this.stateDir,
      resultPath: path.join(loopDir, "professor-result.json"),
      input: {
        loop: this.state.loop,
        objective: {
          score: this.state.bestScore,
          direction: this.state.challenge.direction,
          minimumImprovement: this.config.minImprovement,
        },
        maxIdeas: this.config.maxIdeasPerLoop,
        ledgerPath: this.paths.ledger,
        knowledgeBasePath: this.paths.knowledgeBase,
        runsDirectory: this.paths.runsDir,
        currentBestCandidateId,
        inFlightCandidateIds: this.state.ideas.map((idea) => idea.id),
      },
    };
    validateResearchTask(professorTask);
    if (!fs.existsSync(professorTaskPath)) atomicWriteJson(professorTaskPath, professorTask);
    type PersistedProfessorResult = ProfessorProposalResultV1 & { baseRevision: string };
    let proposals: CandidateProposalV1[];
    let baseRevision: string;
    if (fs.existsSync(professorTask.resultPath)) {
      const persisted = JSON.parse(
        fs.readFileSync(professorTask.resultPath, "utf8"),
      ) as PersistedProfessorResult;
      if (
        persisted.schemaVersion !== EXPERIMENT_SCHEMA_VERSION ||
        persisted.taskId !== professorTask.taskId ||
        persisted.kind !== "propose.result" ||
        !persisted.ok ||
        !Array.isArray(persisted.proposals) ||
        typeof persisted.baseRevision !== "string" ||
        persisted.baseRevision.trim() === ""
      ) {
        throw new Error(`Invalid persisted professor result at ${professorTask.resultPath}`);
      }
      proposals = persisted.proposals.map((proposal) =>
        normalizeProposal(proposal, { parentCandidateId: currentBestCandidateId })
      );
      baseRevision = persisted.baseRevision;
      this.emitLog(`resuming materialization from ${path.relative(this.stateDir, professorTask.resultPath)}`);
    } else {
      const result = await this.ports.runner.run({
        role: "professor",
        kind: "propose",
        cwd: this.repoRoot,
        stateDir: this.stateDir,
        input: {
          ...professorTask.input,
          taskPath: professorTaskPath,
          traceDir: path.join(loopDir, "professor-agent"),
          loop: this.state.loop,
          maxIdeasPerLoop: this.config.maxIdeasPerLoop,
          bestScore: this.state.bestScore,
          direction: this.state.challenge.direction,
          dryLoopStreak: this.state.dryLoopStreak,
          history: this.state.history,
        },
        signal: this.ports.signal,
      });
      if (!result.ok) {
        if (this.aborted()) return;
        throw new Error(`Professor propose failed: ${result.error ?? result.output}`);
      }
      const rawProposals = ((result.structured?.ideas as ProposedIdea[] | undefined) ?? []).slice(
        0,
        this.config.maxIdeasPerLoop,
      );
      if (rawProposals.length === 0) {
        throw new Error("Professor proposed zero ideas; cannot continue the loop.");
      }
      proposals = rawProposals.map((raw) =>
        normalizeProposal(raw, {
          parentCandidateId: currentBestCandidateId,
          searchMode: "exploration",
          editFamily: "legacy-proposal",
        })
      );
      for (const proposal of proposals) this.assertUsableParent(proposal.parentCandidateId);
      baseRevision = await this.gitRevision();
      const persisted: PersistedProfessorResult = {
        schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        taskId: professorTask.taskId,
        kind: "propose.result",
        ok: true,
        summary: result.output,
        proposals,
        baseRevision,
      };
      atomicWriteJson(professorTask.resultPath, persisted);
    }

    const loopDirName = `loop-${String(this.state.loop).padStart(3, "0")}`;
    fs.mkdirSync(path.join(this.paths.ideasDir, loopDirName), { recursive: true });
    this.state.ideas = proposals.map((proposal, index) => {
      const id = `L${String(this.state.loop).padStart(3, "0")}-I${index + 1}`;
      this.assertUsableParent(proposal.parentCandidateId);
      const parentPaths = candidateRunPaths(this.stateDir, proposal.parentCandidateId);
      const runPaths = createCandidateRun(this.stateDir, {
        candidateId: id,
        parentCandidateId: proposal.parentCandidateId,
        baseRevision,
      });
      this.writeProposalIfAbsentOrMatching(id, proposal);
      const parent: CandidateParentV1 = {
        schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        candidateId: id,
        parentCandidateId: proposal.parentCandidateId,
        baseRevision,
        parentSourcePath: parentPaths.source,
      };
      this.writeParentIfAbsentOrMatching(id, parent);
      if (!fs.existsSync(runPaths.verifyLog)) fs.writeFileSync(runPaths.verifyLog, "");
      if (!fs.existsSync(runPaths.benchmarkLog)) fs.writeFileSync(runPaths.benchmarkLog, "");
      const specRel = path.join("ideas", loopDirName, `idea-${index + 1}.md`);
      fs.writeFileSync(path.join(this.stateDir, specRel), `# ${proposal.title}\n\n${proposal.spec}\n`);
      return {
        id,
        loop: this.state.loop,
        title: proposal.title,
        parentCandidateId: proposal.parentCandidateId,
        specFile: specRel,
        proposalFile: path.relative(this.stateDir, runPaths.proposal),
        taskFile: path.relative(this.stateDir, runPaths.task),
        status: "proposed" as const,
        verifyAttempts: 0,
        comparisonScore: this.state.bestScore,
        verifyRecords: [],
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
      const runPaths = await this.ensureCandidateRun(idea);
      if (!idea.worktreePath) {
        const parentCandidateId = idea.parentCandidateId ?? this.state.bestCandidateId ?? "baseline";
        const parentSource = this.ensureParentArtifact(parentCandidateId);
        idea.parentCandidateId = parentCandidateId;
        idea.worktreePath = await this.worktrees.create(idea.id, {
          parentArtifactDir: parentSource,
          editablePaths: this.state.challenge.editablePaths,
        });
        await this.worktrees.seedUntracked(idea.id);
        this.persist();
      }

      while (idea.verifyAttempts < this.config.maxVerifyAttempts) {
        if (this.aborted()) return;
        idea.status = "implementing";
        this.persist();
        this.emitIdea(idea, `implementing (attempt ${idea.verifyAttempts + 1}/${this.config.maxVerifyAttempts})`);

        const task = this.materializePhdTask(idea);
        const impl = await this.ports.runner.run({
          role: "phd",
          kind: "implement",
          cwd: idea.worktreePath,
          stateDir: this.stateDir,
          input: {
            ...task.input,
            taskPath: task.taskPath,
            traceDir: path.join(
              runPaths.agentDir,
              `attempt-${String(idea.verifyAttempts + 1).padStart(2, "0")}`,
            ),
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
        });
        if (!impl.ok) {
          if (this.aborted()) return;
          idea.lastVerifyError = impl.error ?? impl.output;
          idea.verifyAttempts += 1;
          this.persist();
          continue;
        }

        const integrity = await auditCandidateIntegrity({
          repoRoot: this.repoRoot,
          candidateWorktree: idea.worktreePath,
          editablePaths: this.state.challenge.editablePaths,
          exec: this.ports.exec,
        });
        const integrityArtifact: CandidateIntegrityV1 = {
          schemaVersion: EXPERIMENT_SCHEMA_VERSION,
          candidateId: idea.id,
          parentCandidateId: idea.parentCandidateId ?? "baseline",
          checkedAt: new Date().toISOString(),
          passed: integrity.ok,
          changedFiles: integrity.changedPaths,
          unexpectedFiles: integrity.violations.map(
            (violation) => `${violation.path} (${violation.reason}; ${violation.status})`,
          ),
        };
        writeCandidateIntegrity(this.stateDir, idea.id, integrityArtifact);
        if (!integrity.ok) {
          idea.lastVerifyError =
            "Candidate integrity check failed before evaluation:\n" +
            integrityArtifact.unexpectedFiles.map((entry) => `- ${entry}`).join("\n");
          idea.verifyAttempts = this.config.maxVerifyAttempts;
          this.persist();
          break;
        }

        idea.status = "verifying";
        this.persist();
        const verifyStartedAt = new Date().toISOString();
        const verify = await this.ports.adapter.verify(
          idea.worktreePath,
          this.ports.signal,
          runPaths.verifyLog,
        );
        const verifyEndedAt = new Date().toISOString();
        idea.verifyRecords ??= [];
        idea.verifyRecords.push(
          this.evaluationRecord(
            this.state.challenge.verifyCommand,
            idea.worktreePath,
            verifyStartedAt,
            verifyEndedAt,
            verify.exitCode,
            runPaths.verifyLog,
            this.config.execution.verifyTimeoutMs,
            verify.timedOut ?? false,
          ),
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
        return;
      }

      // Bench serialized across ideas: honest scores, no resource contention.
      idea.status = "benching";
      this.persist();
      const benchStartedAt = new Date().toISOString();
      const bench = await this.benchLock.runExclusive(() =>
        this.ports.adapter.bench(idea.worktreePath, this.ports.signal, runPaths.benchmarkLog),
      );
      const benchEndedAt = new Date().toISOString();
      idea.benchmarkRecord = this.evaluationRecord(
        this.state.challenge.benchCommand,
        idea.worktreePath,
        benchStartedAt,
        benchEndedAt,
        bench.exitCode,
        runPaths.benchmarkLog,
        this.config.execution.benchmarkTimeoutMs,
        bench.timedOut ?? false,
      );
      if (this.aborted()) return;
      if (!bench.ok || bench.score === undefined) {
        idea.status = "failed";
        idea.lastVerifyError = bench.raw;
        this.persist();
        this.emitIdea(idea, "benchmark failed; worktree kept for debugging");
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

  /** Pick the best improving idea, apply to main, re-verify + re-bench there, submit. */
  private async finalizeLoop(): Promise<boolean> {
    const benched = this.state.ideas.filter((i) => i.status === "benching" && i.localScore !== undefined);
    const improving = benched.filter((i) =>
      isImprovement(this.state.bestScore, i.localScore!, this.state.challenge.direction, this.config.minImprovement),
    );
    improving.sort((a, b) =>
      this.state.challenge.direction === "+" ? b.localScore! - a.localScore! : a.localScore! - b.localScore!,
    );
    const winner = improving[0];

    // Non-winners that verified fine but didn't improve (or lost) get notes.
    for (const idea of benched) {
      if (idea === winner) continue;
      idea.status = improving.includes(idea) ? "done-superseded" : "done-no-improvement";
      this.persist();
    }

    if (!winner) return false;

    // Apply the winner to the main repo and re-measure there to guard against
    // worktree-only artifacts.
    this.worktrees.applyToMain(winner.id, this.state.challenge.editablePaths);
    const winnerPaths = candidateRunPaths(this.stateDir, winner.id);
    const mainVerifyStartedAt = new Date().toISOString();
    const verify = await this.ports.adapter.verify(
      undefined,
      this.ports.signal,
      winnerPaths.verifyLog,
    );
    winner.verifyRecords ??= [];
    winner.verifyRecords.push(
      this.evaluationRecord(
        this.state.challenge.verifyCommand,
        this.repoRoot,
        mainVerifyStartedAt,
        new Date().toISOString(),
        verify.exitCode,
        winnerPaths.verifyLog,
        this.config.execution.verifyTimeoutMs,
        verify.timedOut ?? false,
      ),
    );
    if (!verify.ok) {
      winner.status = "failed";
      winner.lastVerifyError = `Re-verify on main repo failed after applying worktree diff:\n${verify.raw}`;
      this.persist();
      this.emitIdea(winner, "re-verify on main failed; not submitting");
      return false;
    }
    const mainBenchStartedAt = new Date().toISOString();
    const bench = await this.ports.adapter.bench(
      undefined,
      this.ports.signal,
      winnerPaths.benchmarkLog,
    );
    winner.benchmarkRecord = this.evaluationRecord(
      this.state.challenge.benchCommand,
      this.repoRoot,
      mainBenchStartedAt,
      new Date().toISOString(),
      bench.exitCode,
      winnerPaths.benchmarkLog,
      this.config.execution.benchmarkTimeoutMs,
      bench.timedOut ?? false,
    );
    if (!bench.ok || bench.score === undefined) {
      winner.status = "failed";
      winner.lastVerifyError = `Re-bench on main repo failed:\n${bench.raw}`;
      this.persist();
      this.emitIdea(winner, "re-bench on main failed; not submitting");
      return false;
    }
    if (
      !isImprovement(this.state.bestScore, bench.score, this.state.challenge.direction, this.config.minImprovement)
    ) {
      winner.status = "done-no-improvement";
      winner.localScore = bench.score;
      this.persist();
      return false;
    }

    winner.localScore = bench.score;
    this.state.bestScore =
      this.state.bestScore === null
        ? bench.score
        : betterScore(this.state.bestScore, bench.score, this.state.challenge.direction);
    this.state.bestCandidateId = winner.id;

    // Submission note is required and public in yukon challenges.
    const noteRel = path.join("notes", `submission-loop-${String(this.state.loop).padStart(3, "0")}-${winner.id}.md`);
    const notePath = path.join(this.stateDir, noteRel);
    fs.writeFileSync(
      notePath,
      [
        `# ${winner.title}`,
        "",
        `Local score: ${bench.score}. Idea ${winner.id}, loop ${this.state.loop}.`,
        "",
        fs.readFileSync(path.join(this.stateDir, winner.specFile), "utf8"),
      ].join("\n"),
    );

    const submit = await this.ports.adapter.submit(
      {
        noteFile: notePath,
        model: this.state.challenge.submitNeedsModel ? this.config.submitModelName ?? "unknown" : undefined,
      },
      this.ports.signal,
    );
    winner.status = "done-improved";
    winner.submitted = { submissionId: submit.submissionId, noteFile: noteRel };
    if (submit.ok) {
      this.state.bestSubmittedScore =
        this.state.bestSubmittedScore === null
          ? bench.score
          : betterScore(this.state.bestSubmittedScore, bench.score, this.state.challenge.direction);
    }
    this.persist();
    this.ports.emit({
      type: "submitted",
      loop: this.state.loop,
      ideaId: winner.id,
      score: bench.score,
      submissionId: submit.submissionId,
    });
    this.appendKnowledge(
      `\n### Loop ${this.state.loop} submission\n- ${winner.id} "${winner.title}" · local score ${bench.score} · ${
        submit.ok ? `submitted (${submit.submissionId ?? "id unknown"})` : `SUBMIT FAILED: ${submit.raw.split("\n")[0]}`
      }\n`,
    );
    return true;
  }

  private async writeIdeaNote(idea: Idea, ideaIndex: number): Promise<void> {
    const noteRel = path.join("notes", `loop-${String(this.state.loop).padStart(3, "0")}-${idea.id}.md`);
    const runPaths = await this.ensureCandidateRun(idea);
    const postmortemTaskPath = path.join(runPaths.agentDir, "postmortem-task.json");
    const postmortemTask: PhdPostmortemTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `${idea.id}-postmortem`,
      kind: "postmortem",
      role: "phd",
      taskPath: postmortemTaskPath,
      stateDir: this.stateDir,
      resultPath: path.join(runPaths.agentDir, "postmortem-result.json"),
      input: {
        candidateId: idea.id,
        proposalPath: runPaths.proposal,
        implementationTaskPath: runPaths.task,
        sourcePath: runPaths.source,
        diffPath: runPaths.diff,
        metricsPath: runPaths.metrics,
        integrityPath: runPaths.integrity,
        verifyLogPath: runPaths.verifyLog,
        benchmarkLogPath: runPaths.benchmarkLog,
        terminalStatus: idea.status as CandidateTerminalStatus,
        ...(idea.localScore === undefined ? {} : { score: idea.localScore }),
        comparisonScore: idea.comparisonScore ?? this.state.bestScore,
        ...(idea.lastVerifyError ? { failure: idea.lastVerifyError } : {}),
        postmortemPath: path.join(this.stateDir, noteRel),
      },
    };
    validateResearchTask(postmortemTask);
    if (!fs.existsSync(postmortemTaskPath)) atomicWriteJson(postmortemTaskPath, postmortemTask);
    const result = await this.ports.runner.run({
      role: "phd",
      kind: "write-note",
      cwd: runPaths.root,
      stateDir: this.stateDir,
      tools: ["read"],
      input: {
        ...postmortemTask.input,
        taskPath: postmortemTaskPath,
        traceDir: path.join(runPaths.agentDir, "postmortem"),
        notePath: path.join(this.stateDir, noteRel),
        ideaTitle: idea.title,
        ideaIndex,
        localScore: idea.localScore,
        bestScore: this.state.bestScore,
        status: idea.status,
        lastVerifyError: idea.lastVerifyError,
      },
      signal: this.ports.signal,
    });
    if (result.ok && result.output.trim() !== "") {
      const notePath = path.join(this.stateDir, noteRel);
      fs.mkdirSync(path.dirname(notePath), { recursive: true });
      fs.writeFileSync(notePath, `${result.output.trim()}\n`);
      idea.noteFile = noteRel;
      fs.writeFileSync(runPaths.agentFinal, `${result.output.trim()}\n`);
      this.persist();
      this.appendKnowledge(
        `\n### ${idea.id} "${idea.title}" → ${idea.status}\n${result.output
          .split("\n")
          .slice(0, 6)
          .join("\n")}\n`,
      );
    }
  }

  /** Materialize one immutable task per Pi invocation attempt. */
  private materializePhdTask(idea: Idea, requestedAttempt?: number): PhdImplementationTaskV1 {
    const runPaths = candidateRunPaths(this.stateDir, idea.id);
    const attempt = requestedAttempt ?? Math.max(1, idea.verifyAttempts + 1);
    const taskPath =
      attempt === 1
        ? runPaths.task
        : path.join(runPaths.agentDir, `attempt-${String(attempt).padStart(2, "0")}-task.json`);
    if (fs.existsSync(taskPath)) {
      return JSON.parse(fs.readFileSync(taskPath, "utf8")) as PhdImplementationTaskV1;
    }
    const proposal = JSON.parse(
      fs.readFileSync(runPaths.proposal, "utf8"),
    ) as CandidateProposalV1;
    const repositoryInstructionPaths = this.snapshotRepositoryInstructions(idea, runPaths);
    const task: PhdImplementationTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `${idea.id}-implement-${attempt}`,
      kind: "implement",
      role: "phd",
      taskPath,
      stateDir: this.stateDir,
      resultPath: path.join(
        runPaths.agentDir,
        `attempt-${String(attempt).padStart(2, "0")}-result.json`,
      ),
      input: {
        candidateId: idea.id,
        parentCandidateId: idea.parentCandidateId ?? "baseline",
        attempt,
        maximumAttempts: this.config.maxVerifyAttempts,
        proposalPath: runPaths.proposal,
        requiredEvidence: proposal.evidenceRefs,
        repositoryInstructionPaths,
        editablePaths: this.state.challenge.editablePaths,
        readOnlyPaths: [
          "benchmark.json",
          this.state.challenge.verifyCommand,
          this.state.challenge.benchCommand,
          STATE_DIRECTORY_SENTINEL,
          ...repositoryInstructionPaths,
        ],
        verifyCommand: this.state.challenge.verifyCommand,
        benchmarkProhibited: true,
        ...(idea.lastVerifyError
          ? { previousVerifierReport: idea.lastVerifyError }
          : {}),
        requiredCompletionFields: [
          "changedFiles",
          "checks",
          "assumptions",
          "deviations",
        ],
      },
    };
    validateResearchTask(task);
    if (attempt === 1) writeCandidateTask(this.stateDir, idea.id, task);
    else atomicWriteJson(taskPath, task);
    return task;
  }

  private snapshotRepositoryInstructions(
    idea: Idea,
    runPaths: ReturnType<typeof candidateRunPaths>,
  ): string[] {
    const sourceRoot =
      idea.worktreePath && fs.existsSync(idea.worktreePath)
        ? idea.worktreePath
        : this.repoRoot;
    const relativeCandidates = new Set<string>([
      "AGENTS.md",
      "CLAUDE.md",
      path.join(".github", "copilot-instructions.md"),
    ]);
    for (const editablePath of this.state.challenge.editablePaths) {
      const editableNode = path.join(sourceRoot, editablePath);
      const editableIsDirectory =
        fs.existsSync(editableNode) && fs.statSync(editableNode).isDirectory();
      let directory = editableIsDirectory ? editablePath : path.dirname(editablePath);
      while (directory !== "." && directory !== path.dirname(directory)) {
        relativeCandidates.add(path.join(directory, "AGENTS.md"));
        relativeCandidates.add(path.join(directory, "CLAUDE.md"));
        directory = path.dirname(directory);
      }
      if (editableIsDirectory) {
        collectRepositoryInstructions(sourceRoot, editablePath, relativeCandidates);
      }
    }
    const snapshotRoot = path.join(runPaths.agentDir, "repository-instructions");
    const snapshots: string[] = [];
    for (const relativePath of [...relativeCandidates].sort()) {
      const source = path.join(sourceRoot, relativePath);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const destination = path.join(snapshotRoot, relativePath);
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
      snapshots.push(destination);
    }
    return snapshots;
  }

  private async ensureCandidateRun(
    idea: Idea,
  ): Promise<ReturnType<typeof candidateRunPaths>> {
    const runPaths = candidateRunPaths(this.stateDir, idea.id);
    if (fs.existsSync(runPaths.record)) return runPaths;

    const parentCandidateId = idea.parentCandidateId ?? this.state.bestCandidateId ?? "baseline";
    const parentSourcePath = this.ensureParentArtifact(parentCandidateId);
    const baseRevision = await this.gitRevision();
    createCandidateRun(this.stateDir, {
      candidateId: idea.id,
      parentCandidateId,
      baseRevision,
    });
    const legacyProposal = normalizeProposal(
      {
        title: idea.title,
        spec: fs.readFileSync(path.join(this.stateDir, idea.specFile), "utf8"),
      },
      {
        parentCandidateId,
        searchMode: "exploration",
        editFamily: "legacy-resume",
      },
    );
    writeCandidateProposal(this.stateDir, idea.id, legacyProposal);
    writeCandidateParent(this.stateDir, idea.id, {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      candidateId: idea.id,
      parentCandidateId,
      baseRevision,
      parentSourcePath,
    });
    fs.writeFileSync(runPaths.verifyLog, "");
    fs.writeFileSync(runPaths.benchmarkLog, "");
    idea.parentCandidateId = parentCandidateId;
    idea.proposalFile = path.relative(this.stateDir, runPaths.proposal);
    idea.taskFile = path.relative(this.stateDir, runPaths.task);
    idea.comparisonScore ??= this.state.bestScore;
    idea.verifyRecords ??= [];
    this.persist();
    return runPaths;
  }

  private assertUsableParent(candidateId: string): void {
    const parentPaths = candidateRunPaths(this.stateDir, candidateId);
    const usable =
      fs.existsSync(parentPaths.source) &&
      (candidateId === "baseline" ||
        (fs.existsSync(parentPaths.record) &&
          isCandidateRunSealed(this.stateDir, candidateId)));
    if (!usable) {
      throw new Error(`Professor selected unavailable or unsealed parent ${candidateId}`);
    }
  }

  private writeProposalIfAbsentOrMatching(
    candidateId: string,
    proposal: CandidateProposalV1,
  ): void {
    const proposalPath = candidateRunPaths(this.stateDir, candidateId).proposal;
    if (!fs.existsSync(proposalPath)) {
      writeCandidateProposal(this.stateDir, candidateId, proposal);
      return;
    }
    const existing = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as CandidateProposalV1;
    if (!sameJson(existing, proposal)) {
      throw new Error(`Candidate ${candidateId} has a conflicting immutable proposal`);
    }
  }

  private writeParentIfAbsentOrMatching(
    candidateId: string,
    parent: CandidateParentV1,
  ): void {
    const parentPath = candidateRunPaths(this.stateDir, candidateId).parent;
    if (!fs.existsSync(parentPath)) {
      writeCandidateParent(this.stateDir, candidateId, parent);
      return;
    }
    const existing = JSON.parse(fs.readFileSync(parentPath, "utf8")) as CandidateParentV1;
    if (!sameJson(existing, parent)) {
      throw new Error(`Candidate ${candidateId} has conflicting immutable lineage`);
    }
  }

  /**
   * The archive snapshot is the source of truth for lineage. Legacy states
   * get one baseline snapshot of the current editable surface on first use.
   */
  private ensureParentArtifact(candidateId: string): string {
    const parentSource = candidateRunPaths(this.stateDir, candidateId).source;
    if (fs.existsSync(parentSource)) return parentSource;
    if (candidateId !== "baseline") {
      throw new Error(`Missing archived source for parent candidate ${candidateId}`);
    }
    snapshotEditableSource(this.repoRoot, parentSource, this.state.challenge.editablePaths);
    this.state.bestCandidateId = "baseline";
    this.persist();
    return parentSource;
  }

  private async gitRevision(): Promise<string> {
    const result = await this.ports.exec("git", ["rev-parse", "HEAD"], { cwd: this.repoRoot });
    const revision = result.stdout.trim();
    if (result.code !== 0 || revision === "") {
      throw new Error(`Unable to resolve challenge Git revision: ${result.stderr.trim()}`);
    }
    return revision;
  }

  private evaluationRecord(
    command: string,
    cwd: string,
    startedAt: string,
    endedAt: string,
    exitCode: number,
    outputPath: string,
    timeoutMs: number,
    timedOut: boolean,
  ): EvaluationCommandV1 {
    return {
      command,
      cwd,
      startedAt,
      endedAt,
      timeoutMs,
      exitCode,
      timedOut,
      outputPath,
    };
  }

  private async archiveIdea(idea: Idea): Promise<void> {
    const runPaths = await this.ensureCandidateRun(idea);
    if (isCandidateRunSealed(this.stateDir, idea.id)) {
      await this.ensureLedgerEntry(idea, runPaths);
      idea.archivedAt = readRunRecord(this.stateDir, idea.id).sealedAt;
      return;
    }
    const terminalStatus = idea.status as CandidateTerminalStatus;
    const parentCandidateId = idea.parentCandidateId ?? "baseline";
    const parentSource = this.ensureParentArtifact(parentCandidateId);

    // Preserve the exact evaluated surface before any worktree cleanup. When
    // setup failed before worktree creation, archive the unchanged parent.
    const candidateSource = idea.worktreePath && fs.existsSync(idea.worktreePath)
      ? idea.worktreePath
      : parentSource;
    snapshotEditableSource(candidateSource, runPaths.source, this.state.challenge.editablePaths);
    writeCandidateDiff(
      this.stateDir,
      idea.id,
      parentSource,
      candidateSource,
      this.state.challenge.editablePaths,
    );

    if (!fs.existsSync(runPaths.task)) this.materializePhdTask(idea, 1);
    if (!fs.existsSync(runPaths.integrity)) {
      const integrity: CandidateIntegrityV1 = {
        schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        candidateId: idea.id,
        parentCandidateId,
        checkedAt: new Date().toISOString(),
        passed: false,
        changedFiles: [],
        unexpectedFiles: [
          idea.lastVerifyError ?? "Candidate did not reach the pre-evaluation integrity gate.",
        ],
      };
      writeCandidateIntegrity(this.stateDir, idea.id, integrity);
    }

    const metrics: CandidateMetricsV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      candidateId: idea.id,
      terminalStatus,
      comparisonScore: idea.comparisonScore ?? this.state.bestScore,
      ...(idea.localScore === undefined ? {} : { score: idea.localScore }),
      improved: terminalStatus === "done-improved",
      verify: idea.verifyRecords ?? [],
      ...(idea.benchmarkRecord ? { benchmark: idea.benchmarkRecord } : {}),
      ...(idea.lastVerifyError ? { failure: idea.lastVerifyError } : {}),
    };
    writeCandidateMetrics(this.stateDir, idea.id, metrics);

    if (!idea.noteFile) {
      await this.writeIdeaNote(idea, this.state.ideas.indexOf(idea));
    }
    const notePath = idea.noteFile ? path.join(this.stateDir, idea.noteFile) : undefined;
    const postmortem =
      notePath && fs.existsSync(notePath)
        ? fs.readFileSync(notePath, "utf8")
        : [
            `# ${idea.id}: ${idea.title}`,
            "",
            `Terminal status: ${terminalStatus}.`,
            idea.lastVerifyError ? `Failure: ${idea.lastVerifyError}` : "No agent postmortem was produced.",
          ].join("\n");
    writeCandidatePostmortem(this.stateDir, idea.id, postmortem);

    const sealed = sealCandidateRun(this.stateDir, idea.id, { terminalStatus });
    await this.ensureLedgerEntry(idea, runPaths);
    idea.archivedAt = sealed.sealedAt;
  }

  private async ensureLedgerEntry(
    idea: Idea,
    runPaths: ReturnType<typeof candidateRunPaths>,
  ): Promise<void> {
    if (readLedger(this.stateDir).some((entry) => entry.candidateId === idea.id)) return;
    const run = readRunRecord(this.stateDir, idea.id);
    if (run.status !== "sealed" || !run.terminalStatus) {
      throw new Error(`Cannot index unsealed candidate ${idea.id}`);
    }
    const proposal = JSON.parse(
      fs.readFileSync(runPaths.proposal, "utf8"),
    ) as CandidateProposalV1;
    const metrics = JSON.parse(
      fs.readFileSync(runPaths.metrics, "utf8"),
    ) as CandidateMetricsV1;
    await appendLedgerRecord(this.stateDir, {
      candidateId: idea.id,
      parentCandidateId: run.parentCandidateId,
      title: proposal.title,
      terminalStatus: run.terminalStatus,
      searchMode: proposal.searchMode,
      editFamily: proposal.editFamily,
      ...(metrics.score === undefined ? {} : { score: metrics.score }),
      comparisonScore: metrics.comparisonScore,
      improved: metrics.improved,
    });
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
    const loopDir = path.join(
      this.paths.loopsDir,
      `loop-${String(this.state.loop).padStart(3, "0")}`,
    );
    const taskPath = path.join(loopDir, "advisor-task.json");
    const candidatePaths = this.state.ideas.map(
      (idea) => candidateRunPaths(this.stateDir, idea.id).root,
    );
    const task: AdvisorTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `L${String(this.state.loop).padStart(3, "0")}-advisor`,
      kind: "advise",
      role: "advisor",
      taskPath,
      stateDir: this.stateDir,
      resultPath: path.join(loopDir, "advisor-result.json"),
      input: {
        loop: this.state.loop,
        watchdogPath: path.join(this.repoRoot, this.config.advisor.watchdogFile),
        statePath: this.paths.state,
        candidateRunPaths: candidatePaths,
      },
    };
    validateResearchTask(task);
    if (!fs.existsSync(taskPath)) atomicWriteJson(taskPath, task);
    const result = await this.ports.runner.run({
      role: "advisor",
      kind: "advise",
      cwd: this.repoRoot,
      stateDir: this.stateDir,
      input: {
        ...task.input,
        taskPath,
        traceDir: path.join(loopDir, "advisor-agent"),
        rules: watchdog.rules,
        stateDiff,
        summary,
        watchdogFile: this.config.advisor.watchdogFile,
      },
      signal: this.ports.signal,
    });
    if (!result.ok) return [];
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

  private async godConversation(): Promise<string> {
    this.transition("god");
    const noteRel = path.join("notes", `god-${String(this.state.loop).padStart(3, "0")}.md`);
    const loopDir = path.join(
      this.paths.loopsDir,
      `loop-${String(this.state.loop).padStart(3, "0")}`,
    );
    const taskPath = path.join(loopDir, "god-task.json");
    const task: GodConversationTaskV1 = {
      schemaVersion: EXPERIMENT_SCHEMA_VERSION,
      taskId: `L${String(this.state.loop).padStart(3, "0")}-god`,
      kind: "god-conversation",
      role: "god",
      taskPath,
      stateDir: this.stateDir,
      resultPath: path.join(loopDir, "god-result.json"),
      input: {
        loop: this.state.loop,
        dryLoopStreak: this.state.dryLoopStreak,
        recentRunPaths: this.state.ideas.map(
          (idea) => candidateRunPaths(this.stateDir, idea.id).root,
        ),
        notePath: path.join(this.stateDir, noteRel),
      },
    };
    validateResearchTask(task);
    if (!fs.existsSync(taskPath)) atomicWriteJson(taskPath, task);
    const result = await this.ports.runner.run({
      role: "god",
      kind: "god-conversation",
      cwd: this.repoRoot,
      stateDir: this.stateDir,
      input: {
        ...task.input,
        taskPath,
        traceDir: path.join(loopDir, "god-agent"),
        loop: this.state.loop,
        streak: this.state.dryLoopStreak,
        history: this.state.history,
      },
      signal: this.ports.signal,
    });
    if (result.ok) {
      this.appendKnowledge(`\n### After loop ${this.state.loop}: the professor spoke with God\nSee ${noteRel}. Hope restored; strategy refocused.\n`);
      this.ports.emit({ type: "god", loop: this.state.loop, noteFile: noteRel });
    }
    return noteRel;
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectRepositoryInstructions(
  sourceRoot: string,
  relativeDirectory: string,
  target: Set<string>,
): void {
  const absoluteDirectory = path.join(sourceRoot, relativeDirectory);
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isFile() && (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md")) {
      target.add(relativePath);
    } else if (entry.isDirectory()) {
      collectRepositoryInstructions(sourceRoot, relativePath, target);
    }
  }
}
