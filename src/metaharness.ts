import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunner, AgentTask } from "./agents/types.ts";
import type { ChallengeAdapter } from "./challenge/types.ts";
import type { HarnessConfig, RoleSpec } from "./config.ts";
import type { ExecPort } from "./exec.ts";
import type { MetaHarnessEvolutionTaskV1 } from "./experiments.ts";
import { EXPERIMENT_SCHEMA_VERSION, validateResearchTask } from "./experiments.ts";
import type {
  OrchestratorEvent,
  OrchestratorPorts,
  StatusReport,
} from "./orchestrator.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { LoopState } from "./state.ts";
import { loadState, saveState, statePaths } from "./state.ts";
import {
  appendJournal,
  atomicWriteJson,
  readJson,
  readJsonIfExists,
} from "./util.ts";

export const META_HARNESS_SCHEMA_VERSION = 1 as const;
export const BASELINE_HARNESS_CANDIDATE_ID = "H0000";
const VERIFIER_FINGERPRINT_SCOPE = "declared-contract-v2" as const;

export const EVOLVING_HARNESS_ROLES = [
  "professor",
  "phd",
  "advisor",
] as const;
export type EvolvingHarnessRole = (typeof EVOLVING_HARNESS_ROLES)[number];

export interface HarnessRoleProfileV1 {
  soul: string;
  prompt: string;
  tools?: string[];
}

export interface HarnessHypothesisV1 {
  observation: string;
  mechanism: string;
  intervention: string;
  expectedResult: string;
  falsifiedWhen: string;
  risks: string[];
  evidenceRefs: string[];
}

/**
 * The mutable outer-loop artifact. Model identity, evaluator commands,
 * correctness/performance budgets, score parsing, and promotion thresholds are
 * deliberately absent: those stay fixed for the campaign.
 */
export interface HarnessProfileV1 {
  schemaVersion: typeof META_HARNESS_SCHEMA_VERSION;
  candidateId: string;
  parentCandidateId: string | null;
  createdAt: string;
  hypothesis: HarnessHypothesisV1;
  roles: Record<EvolvingHarnessRole, HarnessRoleProfileV1>;
}

export type MetaHarnessCandidateStatus =
  | "baseline"
  | "draft"
  | "ready"
  | "evaluating"
  | "accepted"
  | "rejected"
  | "failed";

export interface MetaHarnessCandidateRecordV1 {
  candidateId: string;
  parentCandidateId: string | null;
  generation: number;
  status: MetaHarnessCandidateStatus;
  profilePath: string;
  createdAt: string;
  proposalAttempts: number;
  profileHash?: string;
  behaviorHash?: string;
  evaluationPath?: string;
  error?: string;
  proposalUsage?: { cost: number; turns: number };
}

export interface ActiveHarnessEvaluationV1 {
  candidateId: string;
  startedAt: string;
  startScore: number | null;
  targetLoops: number;
  completedLoops: number[];
  lastRecordedLoop: number;
  totalIdeas: number;
  failedIdeas: number;
}

export interface MetaHarnessRecoveryV1 {
  loop: number;
  attempts: number;
  error: string;
  lastAttemptAt: string;
}

export type MetaHarnessPhase =
  | "ready"
  | "proposing"
  | "evaluating"
  | "recording"
  | "recovering"
  | "paused"
  | "done";

export interface MetaHarnessStateV1 {
  schemaVersion: typeof META_HARNESS_SCHEMA_VERSION;
  phase: MetaHarnessPhase;
  generation: number;
  championCandidateId: string;
  activeEvaluation?: ActiveHarnessEvaluationV1;
  candidates: MetaHarnessCandidateRecordV1[];
  consecutiveProposalFailures: number;
  proposalCooldownRemaining: number;
  recovery?: MetaHarnessRecoveryV1;
  startedAt: string;
  updatedAt: string;
}

export interface FrozenVerifierFileV1 {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
  mode?: number;
}

export interface FrozenRuntimeContractV1 {
  runner: HarnessConfig["runner"];
  evolvingRoleModels: Record<
    EvolvingHarnessRole,
    Pick<RoleSpec, "model" | "thinking">
  >;
  fixedRoles: {
    setup: RoleSpec;
    god: RoleSpec;
    metaharness: RoleSpec;
  };
  innerPolicy: {
    churchTriggerThreshold: number;
    maxVerifyAttempts: number;
    maxIdeasPerLoop: number;
    maxLoops: number | null;
    minImprovement: number;
    mockLoopDelayMs: number;
    execution: HarnessConfig["execution"];
    resilience: HarnessConfig["resilience"];
    advisor: HarnessConfig["advisor"];
    submitModelName?: string;
  };
  metaPolicy: HarnessConfig["metaHarness"];
}

export interface VerifierContractV1 {
  schemaVersion: typeof META_HARNESS_SCHEMA_VERSION;
  capturedAt: string;
  challenge: {
    name: string;
    direction: LoopState["challenge"]["direction"];
    verifyCommand: string;
    benchCommand: string;
    scorePath: string;
    editablePaths: string[];
    localEvaluation?: LoopState["challenge"]["localEvaluation"];
  };
  /** Legacy repository snapshot retained only while migrating older campaigns. */
  files?: FrozenVerifierFileV1[];
  runtime?: FrozenRuntimeContractV1;
  fingerprintScope?: typeof VERIFIER_FINGERPRINT_SCOPE;
  /** Older fingerprints retained when a contract is narrowed compatibly. */
  legacyFingerprints?: string[];
  fingerprint: string;
}

export interface MetaHarnessEvaluationV1 {
  schemaVersion: typeof META_HARNESS_SCHEMA_VERSION;
  candidateId: string;
  parentCandidateId: string;
  profileHash: string;
  verifierFingerprint: string;
  startedAt: string;
  endedAt: string;
  loops: number[];
  startScore: number | null;
  endScore: number | null;
  objectiveGain: number;
  relativeGain: number;
  totalIdeas: number;
  failedIdeas: number;
  candidateSuccessRate: number;
  wallTimeMs: number;
  accepted: boolean;
  failure?: string;
}

export interface MetaHarnessStatus {
  enabled: true;
  phase: MetaHarnessPhase;
  generation: number;
  championCandidateId: string;
  activeCandidateId?: string;
  recoveryAttempts: number;
  proposalCooldownRemaining: number;
  frontierSize: number;
}

export interface MetaHarnessControllerPorts {
  runner: AgentRunner;
  adapter: ChallengeAdapter;
  exec: ExecPort;
  emit: (event: OrchestratorEvent) => void;
  signal?: AbortSignal;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const EXTENSION_ROOT = path.resolve(import.meta.dirname, "../extensions/autoresearch");
const META_PROFILE_KEYS = [
  "schemaVersion",
  "candidateId",
  "parentCandidateId",
  "createdAt",
  "hypothesis",
  "roles",
] as const;
const HYPOTHESIS_KEYS = [
  "observation",
  "mechanism",
  "intervention",
  "expectedResult",
  "falsifiedWhen",
  "risks",
  "evidenceRefs",
] as const;
const ROLE_PROFILE_KEYS = ["soul", "prompt", "tools"] as const;

export function metaHarnessPaths(stateDir: string) {
  const root = statePaths(stateDir).metaHarnessDir;
  return {
    root,
    state: path.join(root, "state.json"),
    verifier: path.join(root, "verifier.json"),
    ledger: path.join(root, "ledger.ndjson"),
    frontier: path.join(root, "frontier.json"),
    journal: path.join(root, "journal.ndjson"),
    heartbeat: path.join(root, "heartbeat.json"),
    candidatesDir: path.join(root, "candidates"),
    generationsDir: path.join(root, "generations"),
  };
}

export function loadMetaHarnessStatus(stateDir: string): MetaHarnessStatus | undefined {
  const paths = metaHarnessPaths(stateDir);
  const state = readJsonIfExists<MetaHarnessStateV1>(paths.state);
  if (!state) return undefined;
  const frontier = readJsonIfExists<{ candidateIds?: string[] }>(paths.frontier);
  return {
    enabled: true,
    phase: state.phase,
    generation: state.generation,
    championCandidateId: state.championCandidateId,
    ...(state.activeEvaluation
      ? { activeCandidateId: state.activeEvaluation.candidateId }
      : {}),
    recoveryAttempts: state.recovery?.attempts ?? 0,
    proposalCooldownRemaining: state.proposalCooldownRemaining,
    frontierSize: frontier?.candidateIds?.length ?? 0,
  };
}

function candidatePaths(stateDir: string, candidateId: string) {
  assertCandidateId(candidateId);
  const root = path.join(metaHarnessPaths(stateDir).candidatesDir, candidateId);
  return {
    root,
    profile: path.join(root, "profile.json"),
    artifact: path.join(root, "artifact"),
    agentDir: path.join(root, "agent"),
    evaluation: path.join(root, "evaluation.json"),
  };
}

/**
 * Applies an already validated profile at the AgentRunner port. This keeps the
 * inner Orchestrator and deterministic evaluator unchanged.
 */
class ProfiledAgentRunner implements AgentRunner {
  private overrides: Partial<Record<EvolvingHarnessRole, Partial<RoleSpec>>> = {};

  constructor(private readonly base: AgentRunner) {}

  setProfile(
    repoRoot: string,
    candidateRoot: string,
    profile: HarnessProfileV1,
  ): void {
    this.overrides = Object.fromEntries(
      EVOLVING_HARNESS_ROLES.map((role) => {
        const roleProfile = profile.roles[role];
        return [
          role,
          {
            soul: repoRelativeRolePath(
              repoRoot,
              resolveProfileFile(candidateRoot, roleProfile.soul),
            ),
            prompt: repoRelativeRolePath(
              repoRoot,
              resolveProfileFile(candidateRoot, roleProfile.prompt),
            ),
            ...(roleProfile.tools === undefined ? {} : { tools: [...roleProfile.tools] }),
          },
        ];
      }),
    );
  }

  run(task: AgentTask) {
    const override = this.overrides[task.role as EvolvingHarnessRole];
    return this.base.run({
      ...task,
      ...(override
        ? { roleOverride: { ...(task.roleOverride ?? {}), ...override } }
        : {}),
    });
  }
}

/**
 * Durable bilevel supervisor. One harness profile wraps one or more complete
 * inner research loops; the unchanged challenge verifier supplies the outer
 * objective signal.
 */
export class MetaHarnessController {
  private readonly paths: ReturnType<typeof metaHarnessPaths>;
  private readonly profiledRunner: ProfiledAgentRunner;
  private readonly inner: Orchestrator;

  private constructor(
    private readonly repoRoot: string,
    private readonly stateDir: string,
    private readonly config: HarnessConfig,
    private readonly ports: MetaHarnessControllerPorts,
    private state: MetaHarnessStateV1,
    private readonly verifier: VerifierContractV1,
  ) {
    this.paths = metaHarnessPaths(stateDir);
    this.profiledRunner = new ProfiledAgentRunner(ports.runner);
    this.applyCurrentProfile();
    const innerPorts: OrchestratorPorts = {
      runner: this.profiledRunner,
      adapter: ports.adapter,
      exec: ports.exec,
      emit: (event) => {
        this.heartbeat(`inner.${event.type}`);
        ports.emit(event);
      },
      signal: ports.signal,
      delay: ports.delay,
    };
    this.inner = new Orchestrator(repoRoot, stateDir, config, innerPorts);
  }

  static async create(
    repoRoot: string,
    stateDir: string,
    config: HarnessConfig,
    ports: MetaHarnessControllerPorts,
  ): Promise<MetaHarnessController> {
    if (!config.metaHarness.enabled) {
      throw new Error("MetaHarnessController requires metaHarness.enabled");
    }
    const paths = metaHarnessPaths(stateDir);
    fs.mkdirSync(paths.candidatesDir, { recursive: true });
    fs.mkdirSync(paths.generationsDir, { recursive: true });
    if (!fs.existsSync(paths.ledger)) fs.writeFileSync(paths.ledger, "");
    if (!fs.existsSync(paths.frontier)) {
      atomicWriteJson(paths.frontier, {
        schemaVersion: META_HARNESS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        candidateIds: [],
      });
    }

    const innerState = loadState(stateDir);
    if (!innerState) throw new Error(`No state.json in ${stateDir}; run init first.`);

    let verifier = readJsonIfExists<VerifierContractV1>(paths.verifier);
    if (!verifier) {
      verifier = await captureVerifierContract(
        repoRoot,
        innerState,
        ports.exec,
        config,
      );
      atomicWriteJson(paths.verifier, verifier);
    } else {
      const normalized = normalizeVerifierContract(verifier);
      if (normalized.fingerprint !== verifier.fingerprint) {
        verifier = normalized;
        atomicWriteJson(paths.verifier, verifier);
        appendJournal(paths.journal, {
          event: "metaharness.verifier-migrated",
          fingerprint: verifier.fingerprint,
          legacyFingerprints: verifier.legacyFingerprints,
          reason: "narrowed fingerprint to the declared contract and runtime policy",
        });
      }
    }

    let state = readJsonIfExists<MetaHarnessStateV1>(paths.state);
    if (!state) {
      const baseline = createBaselineProfile(repoRoot, stateDir, config);
      const now = new Date().toISOString();
      state = {
        schemaVersion: META_HARNESS_SCHEMA_VERSION,
        phase: "ready",
        generation: 0,
        championCandidateId: BASELINE_HARNESS_CANDIDATE_ID,
        candidates: [
          {
            candidateId: BASELINE_HARNESS_CANDIDATE_ID,
            parentCandidateId: null,
            generation: 0,
            status: "baseline",
            profilePath: candidatePaths(
              stateDir,
              BASELINE_HARNESS_CANDIDATE_ID,
            ).profile,
            createdAt: baseline.createdAt,
            proposalAttempts: 0,
            profileHash: hashHarnessProfile(
              candidatePaths(stateDir, BASELINE_HARNESS_CANDIDATE_ID).root,
              baseline,
            ),
            behaviorHash: hashHarnessBehavior(
              candidatePaths(stateDir, BASELINE_HARNESS_CANDIDATE_ID).root,
              baseline,
            ),
          },
        ],
        consecutiveProposalFailures: 0,
        proposalCooldownRemaining: 0,
        startedAt: now,
        updatedAt: now,
      };
      atomicWriteJson(paths.state, state);
      appendJournal(paths.journal, {
        event: "metaharness.initialized",
        verifierFingerprint: verifier.fingerprint,
      });
    }
    validateMetaState(state);

    const current = await captureVerifierContract(
      repoRoot,
      innerState,
      ports.exec,
      config,
    );
    if (current.fingerprint !== verifier.fingerprint) {
      const drift = describeVerifierContractDrift(verifier, current);
      if (innerState.phase !== "paused") innerState.resumePhase = innerState.phase;
      innerState.phase = "paused";
      saveState(stateDir, innerState);
      state.phase = "paused";
      state.updatedAt = new Date().toISOString();
      atomicWriteJson(paths.state, state);
      appendJournal(paths.journal, {
        event: "metaharness.verifier-drift",
        expected: verifier.fingerprint,
        observed: current.fingerprint,
        drift,
      });
      throw new VerifierDriftError(
        verifier.fingerprint,
        current.fingerprint,
        drift,
      );
    }
    if (state.phase === "paused") {
      state.phase = state.activeEvaluation ? "evaluating" : "ready";
      state.updatedAt = new Date().toISOString();
      atomicWriteJson(paths.state, state);
      appendJournal(paths.journal, {
        event: "metaharness.resumed",
        verifierFingerprint: verifier.fingerprint,
      });
    }
    return new MetaHarnessController(
      repoRoot,
      stateDir,
      config,
      ports,
      state,
      verifier,
    );
  }

  status(): StatusReport {
    const metaHarness = loadMetaHarnessStatus(this.stateDir)!;
    const persisted = loadState(this.stateDir);
    return {
      ...this.inner.status(),
      ...(persisted ? { phase: persisted.phase } : {}),
      metaHarness,
    };
  }

  async runUntilDone(): Promise<void> {
    for (;;) {
      if (this.aborted()) {
        this.pauseInnerState("aborted");
        this.pauseMeta("aborted");
        return;
      }

      try {
        await this.assertVerifierUnchanged();
      } catch (error) {
        this.pauseForVerifierDrift(error);
        return;
      }

      await this.reconcileCompletedLoops();
      if (this.metaPaused()) return;
      if (this.state.activeEvaluation) {
        const active = this.state.activeEvaluation;
        if (active.completedLoops.length >= active.targetLoops) {
          await this.finishActiveEvaluation();
          if (this.metaPaused()) return;
          continue;
        }
      }

      if (this.shouldStop()) {
        if (this.state.activeEvaluation) {
          await this.finishActiveEvaluation("campaign budget ended the evaluation window");
          if (this.metaPaused()) return;
        }
        this.markDone();
        return;
      }

      if (!this.state.activeEvaluation && this.shouldPropose()) {
        await this.proposeHarnessCandidate();
        if (this.metaPaused()) return;
      }

      const profileId =
        this.state.activeEvaluation?.candidateId ??
        this.state.championCandidateId;
      this.applyProfile(profileId);
      this.state.phase = this.state.activeEvaluation ? "evaluating" : "ready";
      this.persist();
      this.heartbeat("inner-loop.start", { profileId });

      try {
        const summary = await this.inner.runLoop();
        if (summary === null || this.inner.status().phase === "paused") {
          this.pauseMeta("inner loop paused");
          return;
        }
        this.state.recovery = undefined;
        if (!this.state.activeEvaluation && this.state.proposalCooldownRemaining > 0) {
          this.state.proposalCooldownRemaining -= 1;
        }
        this.persist();
        await this.reconcileCompletedLoops();
        await this.waitAfterMockLoop();
      } catch (error) {
        const recovered = await this.handleInnerFailure(error);
        if (!recovered) return;
      }
    }
  }

  private shouldStop(): boolean {
    const innerState = loadState(this.stateDir)!;
    if (
      this.config.maxLoops !== null &&
      innerState.history.length >= this.config.maxLoops
    ) {
      return true;
    }
    const maximum = this.config.metaHarness.maxGenerations;
    if (
      maximum !== null &&
      this.state.generation >= maximum &&
      !this.state.activeEvaluation &&
      !this.pendingDraftCandidate()
    ) {
      return true;
    }
    const budget = this.config.metaHarness.maxWallTimeMs;
    return (
      budget !== null &&
      Date.now() - Date.parse(this.state.startedAt) >= budget
    );
  }

  private shouldPropose(): boolean {
    if (this.pendingDraftCandidate()) return true;
    if ((loadState(this.stateDir)?.history.length ?? 0) === 0) return false;
    if (this.state.proposalCooldownRemaining > 0) return false;
    const maximum = this.config.metaHarness.maxGenerations;
    return maximum === null || this.state.generation < maximum;
  }

  private async proposeHarnessCandidate(): Promise<void> {
    const pending = this.pendingDraftCandidate();
    const generation = pending?.generation ?? this.state.generation + 1;
    const candidateId = `H${String(generation).padStart(4, "0")}`;
    const parentCandidateId =
      pending?.parentCandidateId ?? this.state.championCandidateId;
    if (parentCandidateId === null) {
      throw new Error(`Draft metaharness candidate ${candidateId} has no parent`);
    }
    const paths = candidatePaths(this.stateDir, candidateId);
    const parentPaths = candidatePaths(this.stateDir, parentCandidateId);
    const createdAt = new Date().toISOString();

    this.state.generation = Math.max(this.state.generation, generation);
    this.state.phase = "proposing";
    let record = pending;
    if (!record) {
      record = {
        candidateId,
        parentCandidateId,
        generation,
        status: "draft",
        profilePath: paths.profile,
        createdAt,
        proposalAttempts: 0,
      };
      this.state.candidates.push(record);
    }
    record.status = "draft";
    record.error = undefined;
    record.proposalAttempts += 1;
    this.persist();
    this.heartbeat("proposal.start", { candidateId, parentCandidateId });

    try {
      resetDraftCandidate(
        parentPaths.root,
        paths.root,
        candidateId,
        parentCandidateId,
        record.createdAt,
      );
      const generationDir = path.join(
        this.paths.generationsDir,
        `generation-${String(generation).padStart(4, "0")}`,
      );
      fs.mkdirSync(generationDir, { recursive: true });
      const taskPath = path.join(generationDir, "task.json");
      const task: MetaHarnessEvolutionTaskV1 = {
        schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        taskId: `${candidateId}-evolve`,
        kind: "evolve-harness",
        role: "metaharness",
        taskPath,
        stateDir: this.stateDir,
        resultPath: path.join(generationDir, "result.json"),
        input: {
          generation,
          candidateId,
          parentCandidateId,
          candidateDirectory: paths.root,
          profilePath: paths.profile,
          parentProfilePath: parentPaths.profile,
          metaLedgerPath: this.paths.ledger,
          metaFrontierPath: this.paths.frontier,
          innerLedgerPath: statePaths(this.stateDir).ledger,
          innerRunsDirectory: statePaths(this.stateDir).runsDir,
          candidatesDirectory: this.paths.candidatesDir,
          verifierContractPath: this.paths.verifier,
          editableRoles: [...EVOLVING_HARNESS_ROLES],
          maxProfileBytes: this.config.metaHarness.maxProfileBytes,
        },
      };
      validateResearchTask(task);
      if (!fs.existsSync(taskPath)) atomicWriteJson(taskPath, task);

      const result = await this.ports.runner.run({
        role: "metaharness",
        kind: "evolve-harness",
        cwd: paths.root,
        stateDir: this.stateDir,
        tools: ["read", "write", "edit"],
        input: {
          ...task.input,
          taskPath,
          traceDir: path.join(
            paths.agentDir,
            `attempt-${String(record.proposalAttempts).padStart(2, "0")}`,
          ),
        },
        signal: this.ports.signal,
      });
      assertMetaHarnessWritesAllowed(
        paths.root,
        paths.profile,
        result.filesWritten,
      );
      if (!result.ok) {
        throw new Error(
          result.error ?? (result.output || "metaharness proposer failed"),
        );
      }

      const profile = validateHarnessProfile(
        paths.root,
        readJson<unknown>(paths.profile),
        {
          expectedCandidateId: candidateId,
          expectedParentCandidateId: parentCandidateId,
          maxBytes: this.config.metaHarness.maxProfileBytes,
        },
      );
      const behaviorHash = hashHarnessBehavior(paths.root, profile);
      const parentProfile = validateHarnessProfile(
        parentPaths.root,
        readJson<unknown>(parentPaths.profile),
        {
          expectedCandidateId: parentCandidateId,
          expectedParentCandidateId:
            this.requireCandidate(parentCandidateId).parentCandidateId,
          maxBytes: this.config.metaHarness.maxProfileBytes,
        },
      );
      const parentRecord = this.requireCandidate(parentCandidateId);
      const parentProfileHash = hashHarnessProfile(
        parentPaths.root,
        parentProfile,
      );
      if (
        parentRecord.profileHash &&
        parentRecord.profileHash !== parentProfileHash
      ) {
        throw new Error(
          `Parent harness profile ${parentCandidateId} changed after validation ` +
            `(${parentRecord.profileHash} != ${parentProfileHash})`,
        );
      }
      if (behaviorHash === hashHarnessBehavior(parentPaths.root, parentProfile)) {
        throw new Error("metaharness candidate is a no-op relative to its parent");
      }
      await this.assertVerifierUnchanged();

      record.status = "ready";
      record.profileHash = hashHarnessProfile(paths.root, profile);
      record.behaviorHash = behaviorHash;
      record.proposalUsage = result.usage;
      this.state.consecutiveProposalFailures = 0;
      this.beginEvaluation(record);
      this.persist();
      this.heartbeat("proposal.accepted", { candidateId, parentCandidateId });
      appendJournal(this.paths.journal, {
        event: "metaharness.candidate-ready",
        candidateId,
        parentCandidateId,
        profileHash: record.profileHash,
      });
    } catch (error) {
      if (error instanceof VerifierContractCheckError) {
        record.status = "failed";
        record.error = errorMessage(error);
        this.pauseForVerifierDrift(error);
        return;
      }
      record.status = "failed";
      record.error = errorMessage(error);
      this.state.consecutiveProposalFailures += 1;
      this.state.proposalCooldownRemaining =
        this.state.consecutiveProposalFailures >=
        this.config.metaHarness.maxConsecutiveProposalFailures
          ? this.config.metaHarness.proposalCooldownLoops
          : 1;
      this.state.phase = "ready";
      this.heartbeat("proposal.rejected", { candidateId });
      appendJournal(this.paths.journal, {
        event: "metaharness.proposal-failed",
        candidateId,
        error: record.error,
        cooldownLoops: this.state.proposalCooldownRemaining,
      });
      this.emitLog(`metaharness ${candidateId} rejected before evaluation: ${record.error}`);
    }
    this.persist();
  }

  private beginEvaluation(candidate: MetaHarnessCandidateRecordV1): void {
    const innerState = loadState(this.stateDir)!;
    const lastCompletedLoop =
      innerState.history[innerState.history.length - 1]?.loop ?? 0;
    candidate.status = "evaluating";
    this.state.activeEvaluation = {
      candidateId: candidate.candidateId,
      startedAt: new Date().toISOString(),
      startScore: innerState.bestScore,
      targetLoops: this.config.metaHarness.evaluationLoops,
      completedLoops: [],
      lastRecordedLoop: lastCompletedLoop,
      totalIdeas: 0,
      failedIdeas: 0,
    };
    this.state.phase = "evaluating";
  }

  private pendingDraftCandidate(): MetaHarnessCandidateRecordV1 | undefined {
    return this.state.candidates.find(
      (candidate) =>
        candidate.generation === this.state.generation &&
        candidate.status === "draft",
    );
  }

  private async reconcileCompletedLoops(): Promise<void> {
    const active = this.state.activeEvaluation;
    if (!active) return;
    const innerState = loadState(this.stateDir)!;
    const completed = innerState.history
      .filter((summary) => summary.loop > active.lastRecordedLoop)
      .sort((left, right) => left.loop - right.loop);
    if (completed.length === 0) return;

    for (const summary of completed) {
      if (active.completedLoops.length >= active.targetLoops) break;
      active.lastRecordedLoop = summary.loop;
      const evaluatedIdeas =
        summary.evaluatedCandidates === undefined
          ? summary.ideas
          : summary.ideas.filter((idea) => idea.evaluated === true);
      if (evaluatedIdeas.length === 0) {
        appendJournal(this.paths.journal, {
          event: "metaharness.loop-not-evaluable",
          loop: summary.loop,
          reason: "no candidate reached deterministic evaluation",
        });
        continue;
      }
      active.completedLoops.push(summary.loop);
      active.totalIdeas += evaluatedIdeas.length;
      active.failedIdeas += evaluatedIdeas.filter(
        (idea) => idea.status === "failed",
      ).length;
    }
    this.persist();
    if (active.completedLoops.length >= active.targetLoops) {
      await this.finishActiveEvaluation();
    }
  }

  private async finishActiveEvaluation(failure?: string): Promise<void> {
    const active = this.state.activeEvaluation;
    if (!active) return;
    this.state.phase = "recording";
    this.persist();
    try {
      await this.assertVerifierUnchanged();
    } catch (error) {
      this.pauseForVerifierDrift(error);
      return;
    }

    const candidate = this.requireCandidate(active.candidateId);
    const paths = candidatePaths(this.stateDir, candidate.candidateId);
    const persisted = readJsonIfExists<MetaHarnessEvaluationV1>(
      paths.evaluation,
    );
    let evaluation: MetaHarnessEvaluationV1;
    if (persisted) {
      validatePersistedEvaluation(persisted, candidate, this.verifier);
      evaluation = persisted;
    } else {
      const innerState = loadState(this.stateDir)!;
      const endScore = innerState.bestScore;
      const objectiveGain = directionalGain(
        active.startScore,
        endScore,
        innerState.challenge.direction,
      );
      const relativeGain =
        active.startScore === null
          ? objectiveGain
          : objectiveGain /
            Math.max(Math.abs(active.startScore), Number.EPSILON);
      const successRate =
        active.totalIdeas === 0
          ? 0
          : (active.totalIdeas - active.failedIdeas) / active.totalIdeas;
      const accepted =
        failure === undefined &&
        objectiveGain > 0 &&
        successRate >= this.config.metaHarness.minCandidateSuccessRate;
      const endedAt = new Date().toISOString();
      evaluation = {
        schemaVersion: META_HARNESS_SCHEMA_VERSION,
        candidateId: candidate.candidateId,
        parentCandidateId: candidate.parentCandidateId!,
        profileHash: candidate.profileHash!,
        verifierFingerprint: this.verifier.fingerprint,
        startedAt: active.startedAt,
        endedAt,
        loops: [...active.completedLoops],
        startScore: active.startScore,
        endScore,
        objectiveGain,
        relativeGain,
        totalIdeas: active.totalIdeas,
        failedIdeas: active.failedIdeas,
        candidateSuccessRate: successRate,
        wallTimeMs: Math.max(
          0,
          Date.parse(endedAt) - Date.parse(active.startedAt),
        ),
        accepted,
        ...(failure ? { failure } : {}),
      };
      atomicWriteJson(paths.evaluation, evaluation);
    }

    candidate.evaluationPath = paths.evaluation;
    candidate.status = evaluation.accepted ? "accepted" : "rejected";
    candidate.error = evaluation.failure;
    if (evaluation.accepted) {
      this.state.championCandidateId = candidate.candidateId;
    }
    this.appendEvaluationOnce(evaluation);
    this.writeFrontier();
    this.state.activeEvaluation = undefined;
    this.state.phase = "ready";
    this.persist();
    this.applyCurrentProfile();
    this.heartbeat("evaluation.complete", {
      candidateId: candidate.candidateId,
      accepted: evaluation.accepted,
    });
    this.emitLog(
      `metaharness ${candidate.candidateId} ${
        evaluation.accepted ? "promoted" : "rejected"
      }: objective gain ${evaluation.objectiveGain}, candidate success ${(
        evaluation.candidateSuccessRate * 100
      ).toFixed(0)}%`,
    );
  }

  private async handleInnerFailure(error: unknown): Promise<boolean> {
    const message = errorMessage(error);
    const innerState = loadState(this.stateDir)!;
    const attempts =
      this.state.recovery?.loop === innerState.loop
        ? this.state.recovery.attempts + 1
        : 1;
    this.state.phase = "recovering";
    this.state.recovery = {
      loop: innerState.loop,
      attempts,
      error: message,
      lastAttemptAt: new Date().toISOString(),
    };
    this.persist();
    this.heartbeat("recovery.attempt", {
      loop: innerState.loop,
      attempts,
    });
    const maxAttempts = Math.max(
      1,
      this.config.metaHarness.maxRecoveryAttempts,
    );
    this.emitLog(
      `metaharness recovery ${attempts}/${maxAttempts}: ${message}`,
    );

    if (attempts < maxAttempts) {
      const delayMs = Math.min(
        this.config.metaHarness.retryMaxDelayMs,
        this.config.metaHarness.retryBaseDelayMs * 2 ** Math.max(0, attempts - 1),
      );
      await (this.ports.delay ?? abortableDelay)(delayMs, this.ports.signal);
      if (this.aborted()) {
        this.pauseInnerState("aborted");
        this.pauseMeta("aborted");
        return false;
      }
      return true;
    }

    if (this.canSafelyRollbackActiveProfile(innerState)) {
      const candidateId = this.state.activeEvaluation!.candidateId;
      await this.finishActiveEvaluation(
        `profile rolled back after ${attempts} fatal inner-loop failures: ${message}`,
      );
      if (this.metaPaused()) return false;
      this.state.proposalCooldownRemaining = Math.max(
        1,
        this.state.proposalCooldownRemaining,
      );
      this.state.recovery = undefined;
      this.persist();
      this.emitLog(`metaharness rolled back ${candidateId} to the last known-good profile`);
      return true;
    }

    this.pauseInnerState(
      `metaharness recovery exhausted: ${message}`,
      {
        scope: innerState.resumePhase ?? innerState.phase,
        message,
        consecutiveFailures: attempts,
        failedAt: new Date().toISOString(),
      },
    );
    this.pauseMeta(`recovery exhausted after ${attempts} attempts`);
    return false;
  }

  private canSafelyRollbackActiveProfile(innerState: LoopState): boolean {
    const active = this.state.activeEvaluation;
    if (!active || active.candidateId === this.state.championCandidateId) return false;
    if (innerState.ideas.length > 0) return false;
    const loopDir = path.join(
      statePaths(this.stateDir).loopsDir,
      `loop-${String(innerState.loop).padStart(3, "0")}`,
    );
    return !fs.existsSync(path.join(loopDir, "professor-result.json"));
  }

  private applyCurrentProfile(): void {
    this.applyProfile(
      this.state.activeEvaluation?.candidateId ??
        this.state.championCandidateId,
    );
  }

  private applyProfile(candidateId: string): void {
    const candidate = this.requireCandidate(candidateId);
    const paths = candidatePaths(this.stateDir, candidateId);
    const profile = validateHarnessProfile(
      paths.root,
      readJson<unknown>(paths.profile),
      {
        expectedCandidateId: candidateId,
        expectedParentCandidateId: candidate.parentCandidateId,
        maxBytes: this.config.metaHarness.maxProfileBytes,
      },
    );
    const profileHash = hashHarnessProfile(paths.root, profile);
    if (candidate.profileHash && candidate.profileHash !== profileHash) {
      throw new Error(
        `Harness profile ${candidateId} changed after validation (${candidate.profileHash} != ${profileHash})`,
      );
    }
    this.profiledRunner.setProfile(this.repoRoot, paths.root, profile);
  }

  private requireCandidate(candidateId: string): MetaHarnessCandidateRecordV1 {
    const candidate = this.state.candidates.find(
      (item) => item.candidateId === candidateId,
    );
    if (!candidate) throw new Error(`Unknown metaharness candidate ${candidateId}`);
    return candidate;
  }

  private async assertVerifierUnchanged(): Promise<void> {
    const innerState = loadState(this.stateDir)!;
    let current: VerifierContractV1;
    try {
      current = await captureVerifierContract(
        this.repoRoot,
        innerState,
        this.ports.exec,
        this.config,
      );
    } catch (error) {
      throw new VerifierContractCheckError(
        `Unable to inspect the declared verifier contract; the campaign was paused: ` +
          errorMessage(error),
      );
    }
    if (current.fingerprint !== this.verifier.fingerprint) {
      throw new VerifierDriftError(
        this.verifier.fingerprint,
        current.fingerprint,
        describeVerifierContractDrift(this.verifier, current),
      );
    }
  }

  private appendEvaluationOnce(evaluation: MetaHarnessEvaluationV1): void {
    const existing = readMetaHarnessLedger(this.stateDir);
    if (existing.some((entry) => entry.candidateId === evaluation.candidateId)) {
      return;
    }
    fs.appendFileSync(this.paths.ledger, `${JSON.stringify(evaluation)}\n`);
  }

  private writeFrontier(): void {
    const evaluations = readMetaHarnessLedger(this.stateDir);
    const frontier = computeMetaHarnessParetoFrontier(evaluations);
    atomicWriteJson(this.paths.frontier, {
      schemaVersion: META_HARNESS_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      candidateIds: frontier.map((entry) => entry.candidateId),
    });
  }

  private pauseForVerifierDrift(error: unknown): void {
    const message = errorMessage(error);
    this.pauseInnerState(message);
    this.pauseMeta(message);
    appendJournal(this.paths.journal, {
      event: "metaharness.verifier-drift",
      error: message,
    });
    this.emitLog(message);
  }

  private pauseInnerState(
    reason: string,
    recovery?: LoopState["recovery"],
  ): void {
    const state = loadState(this.stateDir);
    if (!state) return;
    if (state.phase !== "paused") state.resumePhase = state.phase;
    state.phase = "paused";
    if (recovery) state.recovery = recovery;
    saveState(this.stateDir, state);
    appendJournal(statePaths(this.stateDir).journal, {
      phase: "paused",
      reason,
      loop: state.loop,
    });
  }

  private pauseMeta(reason: string): void {
    this.state.phase = "paused";
    this.persist();
    this.heartbeat("metaharness.paused", { reason });
    appendJournal(this.paths.journal, {
      event: "metaharness.paused",
      reason,
    });
  }

  private markDone(): void {
    const innerState = loadState(this.stateDir)!;
    innerState.phase = "done";
    innerState.resumePhase = undefined;
    saveState(this.stateDir, innerState);
    this.state.phase = "done";
    this.persist();
    this.heartbeat("metaharness.done");
    appendJournal(this.paths.journal, { event: "metaharness.done" });
    this.ports.emit({ type: "phase", phase: "done", loop: innerState.loop });
  }

  private heartbeat(event: string, fields: Record<string, unknown> = {}): void {
    atomicWriteJson(this.paths.heartbeat, {
      schemaVersion: META_HARNESS_SCHEMA_VERSION,
      event,
      at: new Date().toISOString(),
      phase: this.state.phase,
      generation: this.state.generation,
      ...fields,
    });
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    atomicWriteJson(this.paths.state, this.state);
  }

  private emitLog(message: string): void {
    appendJournal(this.paths.journal, { message });
    this.ports.emit({ type: "log", message });
  }

  private aborted(): boolean {
    return this.ports.signal?.aborted ?? false;
  }

  private metaPaused(): boolean {
    return this.state.phase === "paused";
  }

  private async waitAfterMockLoop(): Promise<void> {
    const delayMs = this.config.mockLoopDelayMs;
    if (
      this.config.runner !== "mock" ||
      !Number.isFinite(delayMs) ||
      delayMs <= 0
    ) {
      return;
    }
    await (this.ports.delay ?? abortableDelay)(delayMs, this.ports.signal);
  }
}

export class VerifierContractCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierContractCheckError";
  }
}

export class VerifierDriftError extends VerifierContractCheckError {
  constructor(expected: string, actual: string, drift: string[] = []) {
    const detail = formatVerifierDrift(drift);
    super(
      `Declared verifier or runtime contract changed during metaharness search ` +
        `(expected ${expected}, observed ${actual}); ` +
        `${detail ? `changed components: ${detail}; ` : ""}` +
        "the campaign was paused.",
    );
    this.name = "VerifierDriftError";
  }
}

export function describeVerifierContractDrift(
  expected: VerifierContractV1,
  actual: VerifierContractV1,
): string[] {
  const drift = new Set<string>();
  collectValueDrift(expected.challenge, actual.challenge, "challenge", drift);
  collectValueDrift(expected.runtime, actual.runtime, "runtime", drift);

  return [...drift].sort();
}

function collectValueDrift(
  expected: unknown,
  actual: unknown,
  valuePath: string,
  drift: Set<string>,
): void {
  if (
    Object.is(expected, actual) ||
    JSON.stringify(expected) === JSON.stringify(actual)
  ) {
    return;
  }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object" ||
    Array.isArray(expected) ||
    Array.isArray(actual)
  ) {
    drift.add(valuePath);
    return;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  for (const key of new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord),
  ])) {
    collectValueDrift(
      expectedRecord[key],
      actualRecord[key],
      `${valuePath}.${key}`,
      drift,
    );
  }
}

function formatVerifierDrift(drift: string[]): string {
  const visible = drift.slice(0, 8);
  const remaining = drift.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

type LegacyFrozenRuntimeContractV1 = FrozenRuntimeContractV1 & {
  fixedRoleArtifacts?: Record<
    "setup" | "god" | "metaharness",
    {
      soulSha256: string;
      promptSha256: string;
    }
  >;
  implementationFiles?: Array<{
    label: string;
    sha256: string;
  }>;
};

export function normalizeVerifierContract(
  contract: VerifierContractV1,
): VerifierContractV1 {
  const legacyRuntime = contract.runtime as
    | LegacyFrozenRuntimeContractV1
    | undefined;
  if (
    contract.fingerprintScope === VERIFIER_FINGERPRINT_SCOPE &&
    !legacyRuntime?.implementationFiles &&
    !legacyRuntime?.fixedRoleArtifacts
  ) {
    return contract;
  }
  const legacyFingerprint = fingerprintLegacyVerifierContract({
    challenge: contract.challenge,
    files: contract.files ?? [],
    runtime: legacyRuntime,
  });
  if (legacyFingerprint !== contract.fingerprint) {
    throw new Error(
      `Persisted verifier fingerprint ${contract.fingerprint} does not match ` +
        `its legacy contract ${legacyFingerprint}`,
    );
  }

  let runtime: FrozenRuntimeContractV1 | undefined;
  if (legacyRuntime) {
    const {
      fixedRoleArtifacts: _fixedRoleArtifacts,
      implementationFiles: _implementationFiles,
      ...normalizedRuntime
    } = legacyRuntime;
    runtime = normalizedRuntime;
  }
  const normalized: VerifierContractV1 = {
    schemaVersion: contract.schemaVersion,
    capturedAt: contract.capturedAt,
    challenge: contract.challenge,
    ...(runtime ? { runtime } : {}),
    fingerprintScope: VERIFIER_FINGERPRINT_SCOPE,
    legacyFingerprints: [
      ...new Set([
        ...(contract.legacyFingerprints ?? []),
        legacyFingerprint,
      ]),
    ],
    fingerprint: "",
  };
  normalized.fingerprint = fingerprintVerifierContract(normalized);
  return normalized;
}

export async function captureVerifierContract(
  _repoRoot: string,
  state: LoopState,
  _exec: ExecPort,
  config?: HarnessConfig,
): Promise<VerifierContractV1> {
  const challenge = {
    name: state.challenge.name,
    direction: state.challenge.direction,
    verifyCommand: state.challenge.verifyCommand,
    benchCommand: state.challenge.benchCommand,
    scorePath: state.challenge.scorePath,
    editablePaths: [...state.challenge.editablePaths].sort(),
    ...(state.challenge.localEvaluation
      ? { localEvaluation: state.challenge.localEvaluation }
      : {}),
  };
  const runtime = config ? captureFrozenRuntime(config) : undefined;
  const contract: VerifierContractV1 = {
    schemaVersion: META_HARNESS_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    challenge,
    ...(runtime ? { runtime } : {}),
    fingerprintScope: VERIFIER_FINGERPRINT_SCOPE,
    fingerprint: "",
  };
  contract.fingerprint = fingerprintVerifierContract(contract);
  return contract;
}

function fingerprintVerifierContract(
  contract: Pick<VerifierContractV1, "challenge" | "runtime">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        challenge: contract.challenge,
        runtime: contract.runtime,
      }),
    )
    .digest("hex");
}

function fingerprintLegacyVerifierContract(
  contract: Required<Pick<VerifierContractV1, "challenge" | "files">> &
    Pick<VerifierContractV1, "runtime">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        challenge: contract.challenge,
        files: contract.files,
        runtime: contract.runtime,
      }),
    )
    .digest("hex");
}

export function validateHarnessProfile(
  candidateRoot: string,
  input: unknown,
  options: {
    expectedCandidateId: string;
    expectedParentCandidateId: string | null;
    maxBytes: number;
  },
): HarnessProfileV1 {
  const profile = requireRecord(input, "profile");
  requireExactKeys(profile, META_PROFILE_KEYS, "profile");
  if (profile.schemaVersion !== META_HARNESS_SCHEMA_VERSION) {
    throw new Error(`Unsupported harness profile schemaVersion ${String(profile.schemaVersion)}`);
  }
  if (profile.candidateId !== options.expectedCandidateId) {
    throw new Error(`Harness profile candidateId must be ${options.expectedCandidateId}`);
  }
  if (profile.parentCandidateId !== options.expectedParentCandidateId) {
    throw new Error(
      `Harness profile parentCandidateId must be ${String(options.expectedParentCandidateId)}`,
    );
  }
  requireNonEmptyString(profile.createdAt, "profile.createdAt");

  const hypothesis = requireRecord(profile.hypothesis, "profile.hypothesis");
  requireExactKeys(hypothesis, HYPOTHESIS_KEYS, "profile.hypothesis");
  for (const field of [
    "observation",
    "mechanism",
    "intervention",
    "expectedResult",
    "falsifiedWhen",
  ] as const) {
    requireNonEmptyString(hypothesis[field], `profile.hypothesis.${field}`);
  }
  requireStringArray(hypothesis.risks, "profile.hypothesis.risks");
  requireStringArray(hypothesis.evidenceRefs, "profile.hypothesis.evidenceRefs");

  const roles = requireRecord(profile.roles, "profile.roles");
  requireExactKeys(roles, EVOLVING_HARNESS_ROLES, "profile.roles");
  let totalBytes = Buffer.byteLength(JSON.stringify(profile));
  const referencedArtifacts = new Set<string>();
  for (const role of EVOLVING_HARNESS_ROLES) {
    const roleProfile = requireRecord(roles[role], `profile.roles.${role}`);
    requireAllowedKeys(roleProfile, ROLE_PROFILE_KEYS, `profile.roles.${role}`);
    for (const field of ["soul", "prompt"] as const) {
      const configured = requireNonEmptyString(
        roleProfile[field],
        `profile.roles.${role}.${field}`,
      );
      const resolved = resolveProfileFile(candidateRoot, configured);
      assertRoleArtifactPath(candidateRoot, role, resolved, field);
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`profile.roles.${role}.${field} must reference a regular file`);
      }
      referencedArtifacts.add(
        normalizeRelativePath(path.relative(candidateRoot, resolved)),
      );
      totalBytes += stat.size;
    }
    if (roleProfile.tools !== undefined) {
      requireStringArray(roleProfile.tools, `profile.roles.${role}.tools`);
    }
  }
  if (totalBytes > options.maxBytes) {
    throw new Error(
      `Harness profile is ${totalBytes} bytes; limit is ${options.maxBytes}`,
    );
  }
  validateHarnessArtifactSurface(candidateRoot, referencedArtifacts);
  return profile as unknown as HarnessProfileV1;
}

export function hashHarnessProfile(
  candidateRoot: string,
  profile: HarnessProfileV1,
): string {
  const hash = createHash("sha256").update(JSON.stringify(profile));
  for (const role of EVOLVING_HARNESS_ROLES) {
    hash.update(role);
    hash.update(fs.readFileSync(resolveProfileFile(candidateRoot, profile.roles[role].soul)));
    hash.update(fs.readFileSync(resolveProfileFile(candidateRoot, profile.roles[role].prompt)));
  }
  return hash.digest("hex");
}

export function hashHarnessBehavior(
  candidateRoot: string,
  profile: HarnessProfileV1,
): string {
  const hash = createHash("sha256");
  for (const role of EVOLVING_HARNESS_ROLES) {
    const roleProfile = profile.roles[role];
    hash.update(role);
    hash.update(JSON.stringify(roleProfile.tools ?? null));
    hash.update(fs.readFileSync(resolveProfileFile(candidateRoot, roleProfile.soul)));
    hash.update(fs.readFileSync(resolveProfileFile(candidateRoot, roleProfile.prompt)));
  }
  return hash.digest("hex");
}

function validatePersistedEvaluation(
  evaluation: MetaHarnessEvaluationV1,
  candidate: MetaHarnessCandidateRecordV1,
  verifier: VerifierContractV1,
): void {
  if (
    evaluation.schemaVersion !== META_HARNESS_SCHEMA_VERSION ||
    evaluation.candidateId !== candidate.candidateId ||
    evaluation.parentCandidateId !== candidate.parentCandidateId ||
    evaluation.profileHash !== candidate.profileHash ||
    ![
      verifier.fingerprint,
      ...(verifier.legacyFingerprints ?? []),
    ].includes(evaluation.verifierFingerprint) ||
    !Array.isArray(evaluation.loops) ||
    typeof evaluation.accepted !== "boolean" ||
    !Number.isFinite(evaluation.objectiveGain) ||
    !Number.isFinite(evaluation.candidateSuccessRate) ||
    !Number.isFinite(evaluation.wallTimeMs)
  ) {
    throw new Error(
      `Persisted metaharness evaluation for ${candidate.candidateId} ` +
        "does not match its immutable candidate contract",
    );
  }
}

export function readMetaHarnessLedger(stateDir: string): MetaHarnessEvaluationV1[] {
  const ledger = metaHarnessPaths(stateDir).ledger;
  if (!fs.existsSync(ledger)) return [];
  return fs
    .readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        const value = JSON.parse(line) as MetaHarnessEvaluationV1;
        if (value.schemaVersion !== META_HARNESS_SCHEMA_VERSION) {
          throw new Error(`unsupported schemaVersion ${String(value.schemaVersion)}`);
        }
        return value;
      } catch (error) {
        throw new Error(
          `Invalid metaharness ledger entry ${ledger}:${index + 1}: ${errorMessage(error)}`,
        );
      }
    });
}

export function computeMetaHarnessParetoFrontier(
  evaluations: MetaHarnessEvaluationV1[],
): MetaHarnessEvaluationV1[] {
  return evaluations.filter(
    (candidate, index) =>
      !evaluations.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.objectiveGain >= candidate.objectiveGain &&
          other.candidateSuccessRate >= candidate.candidateSuccessRate &&
          other.wallTimeMs <= candidate.wallTimeMs &&
          (other.objectiveGain > candidate.objectiveGain ||
            other.candidateSuccessRate > candidate.candidateSuccessRate ||
            other.wallTimeMs < candidate.wallTimeMs),
      ),
  );
}

function createBaselineProfile(
  repoRoot: string,
  stateDir: string,
  config: HarnessConfig,
): HarnessProfileV1 {
  const paths = candidatePaths(stateDir, BASELINE_HARNESS_CANDIDATE_ID);
  fs.mkdirSync(paths.artifact, { recursive: true });
  const roles = {} as Record<EvolvingHarnessRole, HarnessRoleProfileV1>;
  for (const role of EVOLVING_HARNESS_ROLES) {
    const roleDir = path.join(paths.artifact, role);
    fs.mkdirSync(roleDir, { recursive: true });
    const soul = path.join(roleDir, "SOUL.md");
    const prompt = path.join(roleDir, "prompt.md");
    fs.copyFileSync(resolveConfiguredSoul(repoRoot, role, config.roles[role]), soul);
    fs.copyFileSync(resolveConfiguredPrompt(repoRoot, role, config.roles[role]), prompt);
    roles[role] = {
      soul: path.relative(paths.root, soul),
      prompt: path.relative(paths.root, prompt),
      ...(config.roles[role].tools === undefined
        ? {}
        : { tools: [...config.roles[role].tools!] }),
    };
  }
  const profile: HarnessProfileV1 = {
    schemaVersion: META_HARNESS_SCHEMA_VERSION,
    candidateId: BASELINE_HARNESS_CANDIDATE_ID,
    parentCandidateId: null,
    createdAt: new Date().toISOString(),
    hypothesis: {
      observation: "Campaign baseline before autonomous harness evolution.",
      mechanism: "Use the configured role instructions and tool policies unchanged.",
      intervention: "None; this is the last-known-good rollback profile.",
      expectedResult: "Reproduce the ordinary autoresearch behavior.",
      falsifiedWhen: "The baseline profile cannot complete an ordinary research loop.",
      risks: [],
      evidenceRefs: [],
    },
    roles,
  };
  atomicWriteJson(paths.profile, profile);
  return profile;
}

function resetDraftCandidate(
  parentRoot: string,
  candidateRoot: string,
  candidateId: string,
  parentCandidateId: string,
  createdAt: string,
): void {
  const parentProfile = readJson<HarnessProfileV1>(
    path.join(parentRoot, "profile.json"),
  );
  const artifact = path.join(candidateRoot, "artifact");
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.rmSync(artifact, { recursive: true, force: true });
  fs.cpSync(path.join(parentRoot, "artifact"), artifact, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
  const profile: HarnessProfileV1 = {
    ...structuredClone(parentProfile),
    candidateId,
    parentCandidateId,
    createdAt,
    hypothesis: {
      observation: "Replace with an evidence-backed observation from prior runs.",
      mechanism: "Replace with the diagnosed harness mechanism.",
      intervention: "Replace with one coherent harness change.",
      expectedResult: "Replace with expected objective and reliability movement.",
      falsifiedWhen: "Replace with a concrete falsification condition.",
      risks: [],
      evidenceRefs: [],
    },
  };
  atomicWriteJson(path.join(candidateRoot, "profile.json"), profile);
}

function resolveConfiguredSoul(
  repoRoot: string,
  role: EvolvingHarnessRole,
  spec: RoleSpec,
): string {
  return resolveConfiguredRoleSoul(repoRoot, role, spec);
}

function resolveConfiguredRoleSoul(
  repoRoot: string,
  role: keyof HarnessConfig["roles"],
  spec: RoleSpec,
): string {
  const configured = spec.soul?.trim();
  if (!configured) return path.join(EXTENSION_ROOT, "agents", role, "SOUL.md");
  if (path.basename(configured) === configured) {
    return path.join(EXTENSION_ROOT, "agents", role, configured);
  }
  return resolveRepoRelative(repoRoot, configured, `soul for ${role}`);
}

function resolveConfiguredPrompt(
  repoRoot: string,
  role: EvolvingHarnessRole,
  spec: RoleSpec,
): string {
  return resolveConfiguredRolePrompt(repoRoot, role, spec);
}

function resolveConfiguredRolePrompt(
  repoRoot: string,
  role: keyof HarnessConfig["roles"],
  spec: RoleSpec,
): string {
  const configured = spec.prompt?.trim() || `${role}.md`;
  if (path.basename(configured) === configured) {
    return path.join(EXTENSION_ROOT, "prompts", configured);
  }
  return resolveRepoRelative(repoRoot, configured, `prompt for ${role}`);
}

function resolveRepoRelative(repoRoot: string, configured: string, label: string): string {
  if (path.isAbsolute(configured)) throw new Error(`${label} cannot be absolute`);
  const resolved = path.resolve(repoRoot, configured);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the challenge repository`);
  }
  fs.accessSync(resolved, fs.constants.R_OK);
  return resolved;
}

function resolveProfileFile(candidateRoot: string, configured: string): string {
  if (path.isAbsolute(configured)) {
    throw new Error("Harness profile role paths must be candidate-relative");
  }
  const root = path.resolve(candidateRoot);
  const resolved = path.resolve(root, configured);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Harness profile path escapes candidate: ${configured}`);
  }
  return resolved;
}

function assertMetaHarnessWritesAllowed(
  candidateRoot: string,
  profilePath: string,
  filesWritten: readonly string[],
): void {
  const root = path.resolve(candidateRoot);
  const allowedProfile = path.resolve(profilePath);
  const allowedRoleRoots = EVOLVING_HARNESS_ROLES.map((role) =>
    path.join(root, "artifact", role)
  );
  const violations = filesWritten
    .map((writtenPath) =>
      path.isAbsolute(writtenPath)
        ? path.resolve(writtenPath)
        : path.resolve(root, writtenPath),
    )
    .filter(
      (writtenPath) =>
        writtenPath !== allowedProfile &&
        !allowedRoleRoots.some((roleRoot) => {
          const relative = path.relative(roleRoot, writtenPath);
          return (
            relative !== "" &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          );
        }),
    );
  if (violations.length > 0) {
    throw new Error(
      `Meta-harness attempted to write outside its candidate allowlist: ` +
        [...new Set(violations)].sort().join(", "),
    );
  }
}

function assertRoleArtifactPath(
  candidateRoot: string,
  role: EvolvingHarnessRole,
  resolved: string,
  field: "soul" | "prompt",
): void {
  const roleRoot = path.resolve(candidateRoot, "artifact", role);
  const relative = path.relative(roleRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `profile.roles.${role}.${field} must stay within artifact/${role}`,
    );
  }
}

function validateHarnessArtifactSurface(
  candidateRoot: string,
  referencedArtifacts: ReadonlySet<string>,
): void {
  const artifactRoot = path.join(candidateRoot, "artifact");
  const actualArtifacts = listArtifactFiles(candidateRoot, artifactRoot);
  const unexpected = actualArtifacts.filter(
    (relativePath) => !referencedArtifacts.has(relativePath),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Harness candidate contains files outside its declared role artifacts: ` +
        unexpected.join(", "),
    );
  }
}

function listArtifactFiles(candidateRoot: string, current: string): string[] {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Harness candidate artifact must not be a symlink: ` +
        normalizeRelativePath(path.relative(candidateRoot, current)),
    );
  }
  if (stat.isFile()) {
    return [normalizeRelativePath(path.relative(candidateRoot, current))];
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Harness candidate artifact must be a regular file or directory: ` +
        normalizeRelativePath(path.relative(candidateRoot, current)),
    );
  }
  return fs
    .readdirSync(current)
    .sort()
    .flatMap((name) =>
      listArtifactFiles(candidateRoot, path.join(current, name)),
    );
}

function repoRelativeRolePath(repoRoot: string, absolutePath: string): string {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Active harness role file is outside the challenge repository: ${absolutePath}`);
  }
  return relative;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function directionalGain(
  start: number | null,
  end: number | null,
  direction: LoopState["challenge"]["direction"],
): number {
  if (start === null || end === null) return 0;
  return direction === "+" ? end - start : start - end;
}

function captureFrozenRuntime(config: HarnessConfig): FrozenRuntimeContractV1 {
  const evolvingRoleModel = (
    role: EvolvingHarnessRole,
  ): Pick<RoleSpec, "model" | "thinking"> => ({
    model: config.roles[role].model,
    ...(config.roles[role].thinking === undefined
      ? {}
      : { thinking: config.roles[role].thinking }),
  });
  const fixedRole = (role: "setup" | "god" | "metaharness"): RoleSpec => ({
    ...config.roles[role],
    ...(config.roles[role].tools === undefined
      ? {}
      : { tools: [...config.roles[role].tools] }),
  });
  return {
    runner: config.runner,
    evolvingRoleModels: {
      professor: evolvingRoleModel("professor"),
      phd: evolvingRoleModel("phd"),
      advisor: evolvingRoleModel("advisor"),
    },
    fixedRoles: {
      setup: fixedRole("setup"),
      god: fixedRole("god"),
      metaharness: fixedRole("metaharness"),
    },
    innerPolicy: {
      churchTriggerThreshold: config.churchTriggerThreshold,
      maxVerifyAttempts: config.maxVerifyAttempts,
      maxIdeasPerLoop: config.maxIdeasPerLoop,
      maxLoops: config.maxLoops,
      minImprovement: config.minImprovement,
      mockLoopDelayMs: config.mockLoopDelayMs,
      execution: { ...config.execution },
      resilience: { ...config.resilience },
      advisor: { ...config.advisor },
      ...(config.submitModelName === undefined
        ? {}
        : { submitModelName: config.submitModelName }),
    },
    metaPolicy: { ...config.metaHarness },
  };
}

function validateMetaState(state: MetaHarnessStateV1): void {
  if (state.schemaVersion !== META_HARNESS_SCHEMA_VERSION) {
    throw new Error(`Unsupported metaharness state version ${String(state.schemaVersion)}`);
  }
  if (!state.candidates.some((candidate) => candidate.candidateId === state.championCandidateId)) {
    throw new Error(`Metaharness champion ${state.championCandidateId} is missing`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  requireAllowedKeys(value, keys, label);
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}

function assertCandidateId(candidateId: string): void {
  if (!/^H\d{4,}$/.test(candidateId)) {
    throw new Error(`Invalid metaharness candidate ID: ${candidateId}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
