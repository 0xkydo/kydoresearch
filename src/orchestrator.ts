import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner, ProposedIdea } from "./agents/types.ts";
import type { AdvisorNote } from "./advisor.ts";
import { filterByThreshold, hasBlocker, loadWatchdog } from "./advisor.ts";
import type { ChallengeAdapter, LeaderboardEntry } from "./challenge/types.ts";
import type { HarnessConfig } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import type { Phase } from "./phases.ts";
import { isIdeaTerminal } from "./phases.ts";
import type { Idea, LoopState, LoopSummary } from "./state.ts";
import { loadState, saveState, statePaths } from "./state.ts";
import { Taskboard } from "./taskboard.ts";
import { appendJournal, atomicWriteJson, betterScore, isImprovement, Mutex } from "./util.ts";
import { WorktreePool } from "./worktree.ts";

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
    }
  }

  /**
   * One full loop: sync → propose → parallel idea pipelines → finalize winner
   * → advisor → streak/god bookkeeping. Returns null if aborted mid-loop.
   */
  async runLoop(): Promise<LoopSummary | null> {
    // Resume support: if a previous run left in-flight ideas, finish them;
    // otherwise start a fresh loop.
    const resuming = this.state.ideas.some((i) => !isIdeaTerminal(i.status));
    if (!resuming) {
      this.state.loop += 1;
      this.state.ideas = [];
      await this.syncLeaderboard();
      if (this.aborted()) return this.abortLoop();
      await this.propose();
    } else {
      this.emitLog(`resuming loop ${this.state.loop} with ${this.state.ideas.length} idea(s)`);
    }
    if (this.aborted()) return this.abortLoop();

    // Parallel idea pipelines (implement → verify×N → bench-in-worktree).
    this.transition("loop.ideas");
    await Promise.all(this.state.ideas.map((idea) => this.runIdeaPipeline(idea)));
    if (this.aborted()) return this.abortLoop();

    // Winner selection + apply + re-verify + re-bench on main + submit.
    this.transition("loop.finalizing");
    const improved = await this.finalizeLoop();
    if (this.aborted()) return this.abortLoop();

    // Loop end: summary, advisor, streak, god.
    this.transition("loop.end");
    const summary: LoopSummary = {
      loop: this.state.loop,
      improved,
      bestScoreAfter: this.state.bestScore,
      ideas: this.state.ideas.map((i) => ({ id: i.id, title: i.title, status: i.status, localScore: i.localScore })),
    };

    const advisorNotes = await this.runAdvisor(summary);
    summary.advisorNotes = advisorNotes.map((n) => `[${n.severity}] ${n.text}`);

    this.state.dryLoopStreak = improved ? 0 : this.state.dryLoopStreak + 1;

    if (
      this.config.godTriggerThreshold > 0 &&
      this.state.dryLoopStreak >= this.config.godTriggerThreshold
    ) {
      summary.godConversation = await this.godConversation();
      this.state.dryLoopStreak = 0;
    }

    this.state.history.push(summary);
    this.state.ideas = [];
    this.persist();

    // Prune successful worktrees; failures were already kept for debugging.
    for (const idea of summary.ideas) {
      if (idea.status !== "failed") await this.worktrees.remove(idea.id).catch(() => {});
    }

    if (hasBlocker(advisorNotes)) {
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
    const result = await this.ports.runner.run({
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
    });
    if (!result.ok) throw new Error(`Professor propose failed: ${result.error ?? result.output}`);
    const proposed = ((result.structured?.ideas as ProposedIdea[] | undefined) ?? []).slice(
      0,
      this.config.maxIdeasPerLoop,
    );
    if (proposed.length === 0) throw new Error("Professor proposed zero ideas; cannot continue the loop.");

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
    const ideaIndex = this.state.ideas.indexOf(idea);
    try {
      if (!idea.worktreePath) {
        idea.worktreePath = await this.worktrees.create(idea.id);
        await this.worktrees.seedUntracked(idea.id);
        this.persist();
      }

      while (idea.verifyAttempts < this.config.maxVerifyAttempts) {
        if (this.aborted()) return;
        idea.status = "implementing";
        this.persist();
        this.emitIdea(idea, `implementing (attempt ${idea.verifyAttempts + 1}/${this.config.maxVerifyAttempts})`);

        const impl = await this.ports.runner.run({
          role: "phd",
          kind: "implement",
          cwd: idea.worktreePath,
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
        });
        if (!impl.ok) {
          idea.lastVerifyError = impl.error ?? impl.output;
          idea.verifyAttempts += 1;
          this.persist();
          continue;
        }

        idea.status = "verifying";
        this.persist();
        const verify = await this.ports.adapter.verify(idea.worktreePath, this.ports.signal);
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
        this.ports.adapter.bench(idea.worktreePath, this.ports.signal),
      );
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
      const ideaIndex = this.state.ideas.indexOf(idea);
      await this.writeIdeaNote(idea, ideaIndex);
    }

    if (!winner) return false;

    // Apply the winner to the main repo and re-measure there to guard against
    // worktree-only artifacts.
    this.worktrees.applyToMain(winner.id, this.state.challenge.editablePaths);
    const verify = await this.ports.adapter.verify(undefined, this.ports.signal);
    if (!verify.ok) {
      winner.status = "failed";
      winner.lastVerifyError = `Re-verify on main repo failed after applying worktree diff:\n${verify.raw}`;
      this.persist();
      this.emitIdea(winner, "re-verify on main failed; not submitting");
      return false;
    }
    const bench = await this.ports.adapter.bench(undefined, this.ports.signal);
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
      const ideaIndex = this.state.ideas.indexOf(winner);
      await this.writeIdeaNote(winner, ideaIndex);
      return false;
    }

    winner.localScore = bench.score;
    this.state.bestScore =
      this.state.bestScore === null
        ? bench.score
        : betterScore(this.state.bestScore, bench.score, this.state.challenge.direction);

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
    const result = await this.ports.runner.run({
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
    });
    if (result.ok) {
      idea.noteFile = noteRel;
      this.persist();
      this.appendKnowledge(
        `\n### ${idea.id} "${idea.title}" → ${idea.status}\n${result.output
          .split("\n")
          .slice(0, 6)
          .join("\n")}\n`,
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
    const result = await this.ports.runner.run({
      role: "advisor",
      kind: "advise",
      cwd: this.repoRoot,
      stateDir: this.stateDir,
      input: { rules: watchdog.rules, stateDiff, summary, watchdogFile: this.config.advisor.watchdogFile },
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
    const result = await this.ports.runner.run({
      role: "god",
      kind: "god-conversation",
      cwd: this.repoRoot,
      stateDir: this.stateDir,
      input: {
        notePath: path.join(this.stateDir, noteRel),
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

  private abortLoop(): null {
    this.pause("aborted");
    return null;
  }

  private pause(reason: string): void {
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
