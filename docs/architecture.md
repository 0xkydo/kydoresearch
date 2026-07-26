# Architecture

## System boundary

kydoresearch remains a Pi extension around a Pi-independent orchestration
core. The extension owns commands, tools, notifications, configuration, and
the live widget. The core owns the durable state machine, experiment archive,
candidate lineage, worktrees, deterministic evaluation, pause, and resume.

Pi is the ephemeral model/tool runtime for one role invocation. It is not the
workflow engine or the durable memory store.

When enabled, `MetaHarnessController` wraps complete ordinary research loops.
It evolves versioned harness profiles while continuing to use the same
Pi-independent Orchestrator and deterministic ChallengeAdapter. The fixed
challenge verifier remains outside both editable surfaces.

```text
interactive Pi process
  └─ extensions/autoresearch/
       ├─ commands, tools, config UI, widget
       ├─ agents/<role>/SOUL.md      stable role behavior
       └─ prompts/<role>.md          dynamic task-prompt compatibility layer
            │
            ▼
     Pi-independent Orchestrator
       ├─ state.json                 operational checkpoint
       ├─ typed task contracts       immutable invocation requirements
       ├─ runs/ + ledger.ndjson      scientific memory and search index
       ├─ WorktreePool               parent-materialized candidate isolation
       ├─ integrity gate             changed-path audit
       ├─ ChallengeAdapter           deterministic verify/bench/submit
       └─ PiSubprocessRunner         fresh isolated Pi worker

optional MetaHarnessController
  ├─ frozen verifier + runtime-policy fingerprint
  ├─ immutable harness profiles      professor/PhD/advisor souls + prompts + tools
  ├─ outer evaluation ledger
  ├─ quality/reliability/time frontier
  └─ one or more complete Orchestrator loops per profile
```

Meta-harness evolution is opt-in. It may mutate, score, and promote only
candidate-local professor, PhD, and advisor souls, prompts, and tool
allowlists. It cannot change model identity, thinking level, task/profile
schemas, operation budgets, score parsing, verifier commands, promotion
thresholds, setup or God behavior, the outer proposer, or controller source.

## Components

```text
extensions/autoresearch/
  index.ts              extension entry point and session-start restoration
  commands.ts           /autoresearch run|status|config|stop
  config-ui.ts          role and harness configuration
  notes-tool.ts         knowledge-base and note access
  taskboard-tool.ts     shared persisted task board
  widget.ts             compact loop status
  agents/
    setup/SOUL.md
    professor/SOUL.md
    phd/SOUL.md
    advisor/SOUL.md
    god/SOUL.md
    metaharness/SOUL.md
  prompts/*.md          dynamic role/task compatibility templates
  prompts/tasks/*.md    task-specific suffixes and override names
src/
  orchestrator.ts       durable loop state machine and archive integration
  experiments.ts        versioned proposal, task, result, and metric contracts
  archive.ts            atomic candidate artifacts, snapshots, diffs, sealing,
                        and append-only experiment ledger
  metaharness.ts        optional bilevel supervisor, frozen verifier contract,
                        profile validation, rollback, and outer frontier
  integrity.ts          pre-evaluation changed-path audit
  agents/
    mock.ts             deterministic fixture runner
    subprocess.ts       real isolated PiSubprocessRunner
  challenge/
    detect.ts           Yukon manifest and CLI detection
    adapter.ts          setup/verify/bench/submit/sync command boundary
  init.ts               setup, typed exploration task, baseline measurement,
                        and baseline editable-source snapshot
  worktree.ts           parent-aware candidate checkouts and winner application
  advisor.ts            WATCHDOG.md parsing and severity filtering
  state.ts              atomic operational snapshot schema
  config.ts             defaults and forward-compatible config merge
  taskboard.ts          atomic shared task persistence
  exec.ts               bounded, streaming process port
```

`Orchestrator` still depends on `AgentRunner`, `ChallengeAdapter`, `ExecPort`,
and an event callback. Switching between `MockAgentRunner` and
`PiSubprocessRunner` remains a configuration choice, not a second
orchestration implementation.

## Role behavior and task requirements

Every role has a local `extensions/autoresearch/agents/<role>/SOUL.md`. A soul
contains stable identity, responsibilities, boundaries, and evidence habits.
It must not contain a current loop number, score, candidate path, attempt,
verifier output, or history. There is intentionally no repository-level
`SOUL.md`.

The roles are:

- **setup:** repository cartographer and experiment-contract compiler;
- **professor:** evidence-driven research director that proposes falsifiable
  experiments and selects explicit parents;
- **PhD:** single-experiment implementer constrained to declared editable
  paths and prohibited from running the performance benchmark;
- **advisor:** read-only watchdog that checks claims against state, metrics,
  diffs, and logs;
- **God:** the existing warm, honest, hopeful plateau-recovery conversation.
  Its purpose and behavior are unchanged.
- **meta-harness:** outer-loop diagnostician that selectively inspects the
  complete inner and outer archives, then writes one attributable profile
  candidate. It cannot modify prior evidence, the challenge, the evaluator,
  its own role, or the controller.

The soul says how a role behaves. A versioned task JSON says what one
invocation must do. `src/experiments.ts` defines setup, professor proposal, PhD
implementation, PhD postmortem, advisor, God, and meta-harness evolution task
variants. Each envelope records a schema version, task ID, role/kind pair,
absolute task/state/result paths, and kind-specific input.

Professor proposals are normalized into a canonical schema containing an
explicit parent, search mode, edit family, evidence references, observation,
hypothesis, intervention, predicted result, falsifier, risks, non-goals, and
implementation specification. Legacy `{title, spec}` output remains accepted
and is upgraded with explicit compatibility defaults before persistence.

The first PhD task is immutable at `runs/<candidateId>/task.json`. A verifier
retry gets a separate attempt task with the same candidate requirement plus
the latest verifier report. The compatibility prompt renderer may duplicate
selected task fields for existing custom prompts, but the persisted task is
the canonical requirement. Because ambient Pi context files are disabled,
applicable repository instructions are copied into the candidate archive and
listed explicitly in the implementation task.

## Pi worker runtime

`runner: "mock"` uses deterministic agents for the fixture while exercising
the real state, worktree, evaluator, archive, advisor, and challenge-CLI
boundaries.

`runner: "subprocess"` uses `PiSubprocessRunner`. For every invocation it:

1. resolves the role's bundled or challenge-repo-relative prompt and soul;
2. snapshots the effective soul, rendered task context, and invocation
   metadata beside the raw trace;
3. prefers the Pi script or executable that launched the parent process,
   falling back to `pi` on `PATH`;
4. starts a fresh `pi --mode json -p --no-session` process;
5. disables ambient extensions, skills, prompt templates, and context files;
6. applies the configured model, thinking level, and explicit role tool
   allowlist through `--model`, `--thinking`, and `--tools` (custom
   configurations and narrower per-task policies may override it);
7. appends the role soul through `--append-system-prompt`;
8. renders the compatibility task prompt and runs in the assigned checkout;
9. retains the complete stdout JSONL stream, including tool lifecycle events;
10. parses assistant completion text, usage, stop reason, errors, and the
    existing trailing structured-JSON fallback;
11. converts spawn, malformed-event, provider, nonzero-exit, abort, and timeout
    failures into bounded `AgentResult` values.

Each child is sessionless and has a 30-minute default wall-time bound. Abort or
timeout terminates the process group, escalating from `SIGTERM` to `SIGKILL`
after a grace period. Candidate PhD attempts retain traces under their run;
setup, professor, advisor, and God retain role traces under initialization or
loop directories.

The extension boundary is retained because Pi already provides the needed
commands, UI, lifecycle hooks, and subprocess agent runtime. SDK or RPC
embedding would add coupling without solving a current requirement.

Pi tool restriction and detached worktrees are not an operating-system
security sandbox. Trust comes from disposable worktrees, scoped tools,
deterministic evaluation, and the changed-path integrity gate. A container
runner can be an optional future hardening layer.

The role/task split, authority boundaries, and default tool envelopes are
defined in [`agent-profiles.md`](agent-profiles.md).

## First-run initialization

`initChallenge` performs these operations in order:

1. Read `benchmark.json` (including shell-string or argv commands), validate
   the Git repository, and reject `.autoresearch/` under `editablePaths`.
2. Create state, loop, run, trace, log, note, idea, and worktree directories.
   Add `.autoresearch/` to `.git/info/exclude` without changing `.gitignore`.
3. Run `setupCommand` with `setupTimeoutMs`, streamed logs, bounded command
   retries, and abort propagation.
4. Materialize a typed setup task and invoke the setup role to identify
   correctness/performance commands and build the initial knowledge base,
   using the model retry budget.
5. Run the baseline benchmark with bounded retries and parse a fresh finite
   value from `scorePath`.
6. Snapshot the complete baseline `editablePaths` surface under
   `runs/baseline/source/`, record its Git revision and score, set
   `bestCandidateId` to `baseline`, and persist phase `ready`.

The baseline source snapshot is important: a candidate parent is an explicit
artifact, not an assumption that Git `HEAD` represents the current best.
Initialization never submits.

## Experiment lifecycle

The durable top-level phases remain:

```text
ready
  → loop.syncing
  → loop.proposing
  → loop.ideas
  → loop.finalizing
  → loop.end
  → church? → next loop | paused | done
```

One candidate follows:

```text
typed proposal + explicit parent
  → detached worktree
  → materialize parent editable snapshot
  → immutable PhD task
  → implement
  → changed-path integrity gate
  → verify ─fail→ fresh retry task with verifier report
  → serialized benchmark
  → cross-candidate selection
  → source + parent-relative diff + metrics + logs + postmortem
  → seal run
  → append compact ledger record
  → clean successful worktree or retain failed worktree
```

Core invariants:

- **Parallel agents, serialized Git metadata:** idea pipelines run through
  `Promise.all`, but the worktree registry lock serializes `git worktree
  add/remove/prune` so concurrent setup cannot contend on repository metadata.
- **One benchmark at a time:** the benchmark lock covers idea performance
  measurements. Correctness checks and model work can still overlap.
- **Isolation:** every PhD edits a detached worktree. Only the selected
  winner's complete `editablePaths` are copied to the main checkout.
- **Main-checkout gate:** the winner is re-verified and re-benched on main
  before the challenge adapter is allowed to submit it.
- **Direction-aware selection:** `betterScore` and `minImprovement` honor both
  lower-is-better (`-`) and higher-is-better (`+`) manifests.
- **Failure containment:** an individual model crash, verify exhaustion, or
  benchmark failure marks only that idea failed. Failed worktrees are retained
  deliberately for diagnosis.
- **Candidate fallback:** main-checkout verification or benchmarking failure
  rejects only that finalist; finalization proceeds to the next qualifying
  candidate in score order. A durable editable-path snapshot restores the main
  checkout if every finalist fails.

## Retry and fallback policy

`resilience` uses total-attempt counts rather than ambiguous retry counts:
`agentMaxAttempts: 3`, `commandMaxAttempts: 2`, and
`submitMaxAttempts: 5`. Operation retries back off from 2 seconds to at most
one minute. These bounds apply independently, so a failed PhD subprocess gets
three infrastructure attempts before one of the idea's
`maxVerifyAttempts` research cycles is consumed.

Failures are split by blast radius:

- Leaderboard sync and fetch are advisory. After command retries are exhausted,
  the orchestrator reads the last atomic `leaderboard.json` and continues.
- Idea implementation, verification, and benchmarking are isolated to that
  idea. Parallel siblings and later loops continue.
- Hypothesis notes, Advisor review, and church reflection are best-effort. They
  retry as model tasks and then log-and-continue. A failed church visit does not
  reset the dry-loop streak.
- Worktree removal is best-effort but durable: failed cleanup IDs are stored in
  `pendingCleanup` and retried at the next loop checkpoint.
- Proposal and submission are essential checkpoints. Exhausting their local
  attempts raises to `runUntilDone`, which persists `recovery`, waits with a
  1–15 minute exponential backoff, and resumes the same phase. Twelve
  consecutive failed resumptions open the circuit breaker and pause the run.

Submission has an additional ambiguity guard. Before every submit attempt, the
adapter reads the user's remote submissions and matches the measured score. If
a previous command reached the server but lost its response, that remote entry
becomes the idempotency marker. A failed submit is never assigned
`done-improved`, never advances `bestSubmittedScore`, and remains resumable in
`loop.finalizing`.

Additional archive and lineage invariants:

- **Parallel workers, serialized Git metadata:** candidate pipelines run in
  parallel, while worktree registry mutations are protected by a mutex.
- **Explicit lineage:** every candidate records `parentCandidateId`,
  `baseRevision`, and `parentSourcePath`. A worktree begins at detached
  `HEAD` for Git isolation, then the complete parent `editablePaths` snapshot
  is overlaid before the PhD starts. Parent-side deletions propagate.
- **One benchmark at a time:** a global benchmark lock prevents performance
  measurements from contending. Correctness checks and model work may overlap.
- **Pre-evaluation integrity:** tracked or new changes outside
  `editablePaths` are rejected before verification. Unchanged untracked setup
  artifacts seeded from the main repository are allowed; modified copies are
  rejected.
- **Deterministic scoring:** the LLM never decides correctness, validity, or
  improvement.
- **Main-checkout gate:** only the selected winner's complete editable surface
  is copied to main, then re-verified and re-benched before submission.
- **Archive before cleanup:** every terminal candidate is sealed before a
  successful or superseded worktree is removed. Failed worktrees remain for
  diagnosis.
- **Direction-aware selection:** score comparison and `minImprovement` support
  both lower-is-better and higher-is-better manifests.

## Search and memory

Inner search remains professor-directed sequential-best experimentation. The
current best challenge candidate is the default parent, and parallel siblings
may share it.

Before proposing, the professor receives an immutable task pointing to:

- `ledger.ndjson`, the compact index of completed experiments;
- `runs/`, the evidence bundles behind ledger entries;
- `knowledge-base.md`, the navigational subject/leaderboard summary;
- the current best candidate ID, objective, direction, improvement threshold,
  in-flight candidate IDs, and proposal budget.

The professor can inspect relevant candidate diffs, metrics, failures, and
postmortems rather than relying on an ever-growing chat session. Its canonical
proposal records the evidence it used, the mechanism being tested, the
predicted result, and what would falsify the hypothesis. This makes search
auditable without adding vector storage or persistent child Pi sessions.
The normalized proposal set and base Git revision are checkpointed in
`professor-result.json` before any candidate run is materialized, so resume
cannot conflict with half-created immutable runs.

## Optional meta-harness evolution

The outer loop treats a complete professor/PhD/advisor role configuration as
an executable search artifact. `H0000` snapshots the configured role souls,
prompts, and tool policies and remains the initial last-known-good rollback
profile. A fresh archive completes one ordinary `H0000` loop before proposing
`H0001`, so the first diagnosis has raw inner evidence. Each generation then
clones its champion into a new candidate directory. The meta-harness agent may
make one evidence-backed change to those candidate-local artifacts.

Before evaluation, the controller validates:

- exact versioned profile fields and candidate lineage;
- candidate-relative regular-file references with no path escape or symlinks;
- a bounded combined profile size;
- a behavioral hash different from the parent;
- the unchanged frozen verifier fingerprint.

A validated profile is applied only at the `AgentRunner` port. The inner
Orchestrator, candidate worktrees, integrity audit, correctness check,
benchmark, main-checkout re-evaluation, submission path, and score selection
remain unchanged. One profile is pinned to an evaluation window of one or more
complete inner loops.

The outer objective is direction-aware verified improvement in the challenge
score during that window. Candidate success rate is a required reliability
gate, not an LLM judgment. A profile with no verified objective gain is
rejected even if its proposer predicts an improvement. The outer ledger also
retains wall time and failure rate and derives a Pareto frontier over objective
gain, reliability, and time.

The meta-harness proposer receives filesystem paths to:

- the outer profile ledger, frontier, prior profiles, and proposer traces;
- the inner compact experiment ledger;
- all sealed inner candidate evidence, including source, diffs, metrics,
  verifier/benchmark logs, postmortems, and Pi JSONL events; and
- the immutable verifier contract.

This provides full-history selective retrieval without packing the campaign
into one prompt. See [`docs/metaharness.md`](metaharness.md) for the complete
profile contract, budgets, and limitations.

Memory ownership is intentionally split:

- `state.json` is authoritative for execution and resume;
- `runs/<candidateId>/` is authoritative for candidate evidence;
- `ledger.ndjson` is the append-only compact search index;
- `knowledge-base.md` is a human-readable navigation layer, not the sole
  memory store;
- `journal.ndjson` is the operational transition log.

## Candidate archive

The main filesystem layout is:

```text
.autoresearch/
  state.json
  config.json
  journal.ndjson
  knowledge-base.md
  leaderboard.json
  taskboard.json
  ledger.ndjson

  resolved-agents/
    setup/
      soul.md
      context.md
      invocation.json
      events.ndjson

  loops/
    init/
      setup-task.json
    loop-004/
      professor-task.json
      professor-result.json
      professor-agent/{soul.md,context.md,invocation.json,events.ndjson}
      advisor-task.json
      advisor-agent/{soul.md,context.md,invocation.json,events.ndjson}
      god-task.json
      god-agent/{soul.md,context.md,invocation.json,events.ndjson}

  runs/
    baseline/
      baseline.json
      source/<editable paths>
    L004-I1/
      run.json
      task.json
      proposal.json
      parent.json
      source/<editable paths>
      diff.patch
      metrics.json
      integrity.json
      postmortem.md
      agent/
        repository-instructions/<applicable repo instruction files>
        attempt-01/{soul.md,context.md,invocation.json,events.ndjson}
        attempt-02-task.json
        postmortem-task.json
        postmortem/{soul.md,context.md,invocation.json,events.ndjson}
        final.md
      logs/
        verify.log
        benchmark.log

  ideas/loop-004/idea-1.md
  notes/
  logs/
  worktrees/<candidateId>/

  metaharness/
    state.json
    verifier.json
    ledger.ndjson
    frontier.json
    journal.ndjson
    heartbeat.json
    generations/generation-0001/task.json
    candidates/H0000/{profile.json,artifact/}
    candidates/H0001/{profile.json,artifact/,agent/,evaluation.json}
```

Candidate run writers use atomic replacement. Task, proposal, and parent
artifacts are immutable once written. Metrics and other active artifacts may
advance while a candidate is in flight. Sealing requires the complete
task/proposal/parent/source/diff/metrics/integrity/postmortem/log bundle; after
sealing, archive writers reject further mutation. Only a sealed run can enter
the append-only ledger. If interruption occurs after sealing but before the
ledger append, resume detects and repairs the missing index entry.

The baseline is a stable parent artifact rather than a normal terminal
candidate run, so it has `baseline.json` and `source/` but no ledger entry.

## Durable pause and resume

`state.json` remains the atomic operational checkpoint; `journal.ndjson`
remains the append-only human-readable transition log. A loop is incomplete
when its loop number is ahead of `history.length`.

When pausing, `resumePhase` records the active phase before top-level `phase`
becomes `paused`. Resume retries sync/proposal, continues idea work, finishes
finalization, or completes loop-end bookkeeping without incrementing the loop
number. Existing version-1 states may omit lineage/archive fields; the
orchestrator reconstructs a canonical candidate run where possible and creates
a baseline snapshot on first use.

`pendingSummary` checkpoints Advisor results and dry-streak bookkeeping before
church or final history commit. This prevents an interrupted church visit from
double-counting a dry loop. Legacy snapshots whose saved phase is `god` resume
at church. Aborted model, verify, and benchmark operations are not charged as
failed verify attempts.
God's stable role and conversational behavior are unchanged.

A `done-improved` idea with its persisted submission record remains the local
idempotency marker. The harness prevents replay after the adapter result is
stored, although no local state file can make a remote submission and a hard
process kill transactionally atomic.

The external challenge CLI does not expose a submission idempotency key. The
harness prevents replay after the adapter result is persisted and reconciles a
matching score before retrying after an ambiguous failure. A hard process kill
in the narrow interval after remote acceptance and before local persistence is
therefore normally recovered by the remote score check, though score matching
is not as strong as a server-issued idempotency key.

Outer state is independently atomic. An active profile records its start
score, target loop count, completed loop IDs, idea/failure counts, and last
reconciled inner loop. Resume reconstructs progress from durable inner
`history`, so a loop completed immediately before interruption is counted
exactly once.

Fatal inner-loop failures use bounded exponential backoff. If retry exhaustion
occurs before professor output or candidates are materialized, a new profile
may be rejected and rolled back to the champion. After immutable inner
artifacts exist, the campaign pauses instead of mixing profiles inside one
experiment. Repeated outer-proposer failures open a cooldown circuit breaker;
champion-driven inner research continues during cooldown. Evaluator drift
always fail-stops.

## Challenge command boundary

`YukonCliAdapter` remains the only layer that invokes challenge commands:

- dependency setup from `setupCommand`;
- correctness from the detected or setup-selected verify command;
- performance from the benchmark command and `scorePath`;
- `submit --note-file [--model]`;
- `submissions --all`;
- `sync`.

The execution config exposes `setupTimeoutMs`, `verifyTimeoutMs`, and
`benchmarkTimeoutMs`. Setup and main-checkout command output uses
`.autoresearch/logs/`; candidate evaluation uses
`runs/<candidateId>/logs/verify.log` and `benchmark.log`. Evaluation records
also retain command, cwd, timeout, timestamps, exit code, and output path.
Before each benchmark, a stale score file is removed; success requires a new
finite numeric score.

## Verification strategy

The mock challenge exercises real Git worktrees, parent snapshots, shell
commands, scores, archive sealing, and submission records. A process-level
fake Pi executable exercises soul injection, worker resource isolation, JSONL
trace retention, structured-output fallback, timeout, abort, and orchestration
without model calls.

Focused suites cover:

- proposal normalization, typed task validation, atomic archive writes,
  sealing, ledger serialization, snapshots, and parent-relative diffs;
- parent materialization of an uncommitted current best, including deletions;
- integrity rejection for evaluator mutations and untracked out-of-bound
  files, including seeded-artifact and rename edge cases;
- role-local soul resolution, system-prompt injection, trace capture, active
  Pi executable reuse, malformed events, timeouts, and aborts;
- per-candidate verify and benchmark log attribution.
- metaharness profile validation and path confinement, frozen-verifier drift,
  role override activation, outer Pareto selection, and end-to-end profile
  evaluation through ordinary mock challenge loops.

The full scenario matrix continues to cover parallel agents, retries,
nonzero benchmarks, advisor blockers, every resumable phase, live
mid-implementation interruption, church interruption, post-submit resume,
direction-aware selection, duplicate-submission prevention, and worktree
cleanup.

The resilience suite additionally covers cached advisory fallback, model and
command retry budgets, ambiguous-submit reconciliation, loop-level recovery
backoff and circuit breaking, finalist failover, main-snapshot restoration,
and durable deferred cleanup. Config loading deep-merges partial persisted
objects so new execution, resilience, and meta-harness fields receive defaults.
