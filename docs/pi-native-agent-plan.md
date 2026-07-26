# Pi-Native Agent Architecture Implementation Plan

## Purpose

Refine kydoresearch into a portable, Pi-native autonomous research harness
without replacing its existing orchestration architecture.

The target is a durable research loop in which:

- the Pi extension remains the user-facing control plane;
- the Pi-independent core remains responsible for orchestration, persistence,
  worktrees, evaluation, pause, and resume;
- each research role runs as a fresh isolated Pi subprocess;
- each role has its own stable `SOUL.md`;
- each invocation receives an immutable, typed task contract;
- the filesystem, rather than Pi session history, provides cross-run memory;
- every evaluated candidate leaves an inspectable evidence bundle;
- later candidates are materialized from an explicit parent artifact rather
  than implicitly from Git `HEAD`.

This plan incorporates the relevant Meta-Harness/autoresearch lessons about
filesystem memory, trace-rich evaluation, evidence-first proposal generation,
and inspectable candidate lineage. It intentionally does **not** implement a
meta-harness optimization loop.

## Product decisions and user constraints

These decisions are fixed for this implementation:

1. **God remains unchanged in purpose and behavior.**
   God is still the warm, honest, hopeful plateau-recovery conversation after
   repeated dry loops. Moving its prompt into the common agent-soul layout is
   allowed; changing its role is not.
2. **There is no repository-level `SOUL.md`.**
   `SOUL.md` means one role-local operating document for each of setup,
   professor, PhD, advisor, and God.
3. **There is no meta-harness loop.**
   The harness does not mutate, evaluate, or promote its own prompts, policies,
   task formats, tools, or source code.
4. **Keep the Pi extension unless a concrete Pi limitation requires another
   host architecture.**
   No such limitation has been identified. The extension is appropriate for
   commands, UI, configuration, installation, and lifecycle integration.
5. **Design for other users and challenge repositories.**
   Do not depend on one developer's global Pi extensions, skills, prompt
   templates, executable path, home-directory layout, or persisted Pi
   sessions.
6. **Preserve current safety and durability behavior.**
   Pause/resume checkpoints, benchmark serialization, worktree isolation,
   main-checkout re-verification, submission idempotency markers, and
   direction-aware score selection must continue to work.

## First-principles Pi model

Pi is the model/tool runtime used by research workers. It is not the durable
workflow engine.

Pi provides:

- a multi-turn coding-agent loop with file and shell tools;
- per-invocation model, thinking, and tool configuration;
- fresh isolated processes through `pi --mode json -p --no-session`;
- a JSONL event stream containing assistant messages and tool lifecycle
  events;
- an appendable system prompt suitable for a role soul;
- extensions, custom tools, commands, and UI facilities;
- SDK and RPC alternatives when embedding or live steering is required.

Pi does not itself provide:

- durable multi-agent workflow state;
- candidate IDs, parent lineage, experiment ledgers, or research memory;
- benchmark locks or Git worktree coordination;
- a default security sandbox or enforceable filesystem permissions;
- guaranteed structured final output;
- portable continuity between `--no-session` invocations.

Therefore:

- kydoresearch owns all durable state and scientific records;
- Pi workers remain ephemeral;
- one Pi worker invocation may have many internal model/tool turns;
- a completed invocation communicates through captured events, validated
  structured output, and files in explicitly assigned locations;
- retries start fresh Pi processes but see the existing worktree, immutable
  task, and latest verifier report.

The current implementation already uses the same subprocess pattern as Pi's
official subagent example. Retain that boundary rather than migrating to the
SDK or RPC. The SDK would increase version coupling, and RPC would only be
needed for live steering of long-lived workers.

## Existing architecture to preserve

The current high-level loop is:

```text
ready
  -> loop.syncing
  -> loop.proposing
  -> loop.ideas
  -> loop.finalizing
  -> loop.end
  -> god? -> next loop | paused | done
```

Each idea currently follows:

```text
proposed -> implementing -> verifying -> benching -> terminal status
```

Preserve:

- `Orchestrator` as the durable state machine;
- `AgentRunner`, `ChallengeAdapter`, and `ExecPort` ports;
- one detached worktree per candidate;
- parallel implementation with serialized Git worktree registry changes;
- one benchmark at a time;
- deterministic verifier and benchmark execution outside the model;
- application of only the winning editable paths to main;
- re-verification and re-benchmarking on main before submission;
- persisted resume phases and pending summaries;
- deliberate retention of failed worktrees;
- mock agents and the mock challenge as the deterministic integration test
  substrate.

## Current gaps being addressed

### Pi worker runtime

- Role instructions are currently rendered as a user prompt rather than
  appended to Pi's system prompt.
- The runner assumes `pi` is available on `PATH` instead of reusing the
  executable that launched the parent Pi when possible.
- The worker may inherit unrelated user extensions, skills, prompt templates,
  and context.
- Only assistant `message_end` events are interpreted; the raw event stream,
  tool calls, tool results, prompt snapshot, and full usage record are not
  persisted.
- `AgentResult.filesWritten` is always empty.
- Structured results depend on a trailing fenced JSON block and are not
  task-schema validated.

### Task contracts

- `AgentTask.input` is an untyped `Record<string, unknown>`.
- A professor proposal contains only `title` and free-form `spec`.
- Candidate tasks do not formally record parent, evidence inspected, search
  mode, edit family, observation, mechanism, prediction, falsifier, risks, or
  non-goals.
- A task is not stored as the immutable canonical requirement for a run.

### Research memory

- `state.json` is a good operational snapshot but not a complete experiment
  record.
- `knowledge-base.md` is a lossy append-only summary and currently carries too
  much responsibility as research memory.
- verify and benchmark output is appended to global log files, making
  candidate attribution difficult.
- successful and superseded worktrees are removed without first preserving
  their exact candidate source and diff.
- not every candidate receives a result-aware postmortem.
- the Pi worker's empirical trace is discarded.

### Candidate lineage

- `git worktree add --detach <path>` starts from Git `HEAD`.
- a winning candidate is copied into the main working tree but is not
  necessarily committed;
- consequently, a later candidate can start from the old committed baseline
  rather than the current best working-tree artifact;
- the declared or assumed experimental parent is therefore not reproducible.

## Target architecture

```text
Pi interactive process
  -> kydoresearch extension
       -> Pi-independent Orchestrator
            -> persisted operational state
            -> experiment archive and ledger
            -> WorktreePool(parent artifact)
            -> deterministic ChallengeAdapter
            -> PiSubprocessRunner
                 -> Pi base system prompt
                 + role SOUL.md
                 + explicit repository context
                 + immutable task contract
```

No long-lived child Pi sessions are required.

## Role-local souls

Bundled layout:

```text
extensions/autoresearch/agents/
  setup/SOUL.md
  professor/SOUL.md
  phd/SOUL.md
  advisor/SOUL.md
  god/SOUL.md
```

Configuration continues to own model, thinking level, and tool allowlists.
Souls contain durable role behavior only. A soul must not contain the current
loop number, current score, candidate path, attempt number, verifier error, or
experiment history.

### Setup soul

Identity: repository cartographer and experiment-contract compiler.

Stable responsibilities:

- inspect the manifest, task statement, repository instructions, editable
  surface, and evaluator boundary;
- establish facts before drawing conclusions;
- distinguish the fastest reliable correctness command from the full
  performance benchmark;
- confirm setup produced a usable environment;
- describe subject area, objective, constraints, scoring, and research levers;
- write the initial knowledge base;
- never optimize or edit candidate code.

### Professor soul

Identity: research director and evidence-driven search strategist.

Stable responsibilities:

- read the compact ledger and current best artifact before proposing;
- inspect relevant regressions and failures rather than relying only on
  summaries;
- form mechanistic, falsifiable hypotheses;
- select an explicit parent candidate;
- classify the search mode and edit family;
- avoid duplicate in-flight experiments;
- balance local refinement and independent exploration;
- issue only as many proposals as the evidence justifies;
- never edit candidate code or run the full benchmark;
- cite run IDs and evidence paths.

### PhD soul

Identity: experimental implementer.

Stable responsibilities:

- execute exactly one immutable candidate task;
- inspect the parent implementation and required evidence before editing;
- make one coherent intervention;
- edit only declared editable paths;
- never modify evaluator, score parser, task, archive, or prior-run evidence;
- use cheap checks and the correctness command during iteration;
- never run the full benchmark;
- on retry, diagnose and repair the supplied verifier failure;
- preserve useful existing worktree state;
- report assumptions, deviations, changed files, and checks;
- when assigned a postmortem task, compare predicted and actual results and
  record what was learned.

### Advisor soul

Identity: independent watchdog.

Stable responsibilities:

- remain read-only;
- compare claims against state, diffs, metrics, and logs;
- apply `WATCHDOG.md` rules proportionately;
- distinguish scientific concerns from operational failures;
- reserve blockers for integrity, safety, or unrecoverable conditions;
- emit concise evidence-backed notes;
- not become another implementation or ordinary proposal agent.

### God soul

Identity and behavior remain exactly as currently documented: warm, wise,
honest plateau recovery that reframes failures as information and restores the
professor's commitment to a concrete direction.

## Task model

The soul defines how a role behaves. The task defines what one invocation must
accomplish.

Introduce typed task variants while retaining the `AgentRunner` port:

- `SetupTask`
- `ProfessorProposalTask`
- `PhdImplementationTask`
- `PhdPostmortemTask`
- `AdvisorTask`
- `GodConversationTask`

Every task has:

- `schemaVersion`;
- `taskId`;
- `kind`;
- absolute `taskPath` once materialized;
- `stateDir`;
- role-specific immutable input;
- expected result type and output location.

### Candidate proposal contract

A proposed experiment should record:

- `title`;
- `parentCandidateId`;
- `searchMode`: `refinement`, `exploration`, `repair`, `transplant`,
  `ablation`, or `structural`;
- `editFamily`;
- `evidenceRefs`;
- `observation`;
- `hypothesis`;
- `intervention`;
- `expectedResult`;
- `falsifiedWhen`;
- `risks`;
- `nonGoals`;
- a human-readable implementation specification.

Backward-compatible handling may accept old `{title, spec}` proposals from the
mock runner or old custom prompts by assigning the current best as parent and
filling optional scientific fields with explicit defaults. New persisted
tasks must always use the versioned canonical schema.

### PhD implementation task

The persisted candidate task should include:

- candidate and parent IDs;
- proposal path;
- attempt and maximum attempts;
- required evidence paths;
- explicit snapshots of applicable repository instruction files, because
  ambient Pi context-file loading is disabled;
- editable and read-only paths;
- correctness command;
- benchmark prohibition;
- previous verifier report, when retrying;
- required completion fields.

### Postmortem task

Every terminal candidate should receive a postmortem task with:

- proposal/task path;
- source/diff paths;
- structured metrics;
- verify and benchmark log paths;
- terminal status;
- score and comparison score;
- verifier or benchmark failure;
- required postmortem output path.

The postmortem invocation uses a narrower read-only Pi tool policy and returns
markdown for the harness to persist; it does not run with implementation tools
in the main checkout.

## Filesystem and ownership

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
    setup/SOUL.md
    professor/SOUL.md
    phd/SOUL.md
    advisor/SOUL.md
    god/SOUL.md

  loops/
    loop-004/
      professor-task.json
      proposals.json

  runs/
    L004-I1/
      task.json
      proposal.json
      parent.json
      source/
      diff.patch
      metrics.json
      integrity.json
      postmortem.md
      agent/
        soul.md
        context.md
        invocation.json
        events.ndjson
        final.md
      logs/
        verify.log
        benchmark.log

  worktrees/
    L004-I1/
```

Ownership rules:

- `state.json` is authoritative for execution and resume.
- `runs/<candidateId>/` is authoritative for empirical candidate evidence.
- `ledger.ndjson` is an append-only compact index over runs.
- `knowledge-base.md` is a navigational summary, not the only evidence store.
- a run directory may be updated by harness-owned atomic writers while the
  candidate is active and becomes immutable after it is sealed;
- agents may write only explicitly assigned output artifacts;
- prior runs are read-only;
- worktrees may be removed only after candidate source, diff, metrics, logs,
  task, and postmortem have been archived.

## Parent materialization

Every candidate must declare a parent.

For the current sequential-best search policy:

- the default parent is the current best candidate;
- parallel siblings in one loop may share that parent;
- the parent artifact is an archived snapshot of all `editablePaths`;
- a new detached worktree is created for Git isolation;
- the parent's archived editable paths are copied into the new worktree before
  the PhD starts;
- the candidate archive records the base Git revision and parent candidate ID;
- candidate diffs are computed against the parent artifact, not implicitly
  against Git `HEAD`.

For initialization:

- create a `baseline` archived artifact after the baseline benchmark;
- assign the baseline a stable candidate ID;
- initial professor proposals use that baseline parent.

The implementation does not need general population search. It only needs
correct, explicit parent lineage and a future-compatible parent field.

## Pi worker runtime

Retain `PiSubprocessRunner`, but align it with Pi's documented subprocess
model:

1. Resolve a role's bundled or repo-relative `SOUL.md`.
2. Snapshot the resolved soul into the assigned run/agent directory when the
   task belongs to a candidate.
3. Resolve repository-specific context explicitly.
4. Locate the Pi invocation by preferring the executable/script that launched
   the parent process and falling back to `pi`.
5. Launch `--mode json -p --no-session`.
6. Pass explicit model, thinking, and tool settings.
7. Avoid unintended globally installed resources where supported by the
   minimum Pi version.
8. Append the role soul as system-level instructions.
9. Send a small user message directing the worker to the immutable task file.
10. Stream and retain the complete JSONL event record.
11. Parse assistant messages, tool calls/results, usage, stop reason, and
    errors into `AgentResult`.
12. Bound wall time and terminate the process group on abort or timeout.

The runner must remain compatible with the configured minimum Pi version.
Optional newer CLI flags require a version/capability guard rather than being
assumed.

### Structured completion

Preferred direction:

- add an explicitly loaded worker-only extension with a
  `submit_research_result` tool;
- use a TypeBox schema appropriate to the task kind;
- capture submitted arguments from the JSON event stream;
- validate again in the parent runner;
- fail clearly when required structured output is absent.

If this is too invasive for the first compatible increment:

- retain trailing JSON as a fallback;
- validate it against the typed task result;
- store the full final message and parsing failure in the run trace;
- keep the `AgentRunner` interface ready for the completion tool.

## Deterministic evaluator and integrity gates

The LLM does not decide whether a candidate is valid or improved.

Before verification:

- inspect all changed paths;
- reject changes outside `editablePaths`;
- record the changed-file list;
- capture the candidate source and diff against its parent;
- ensure the score file cannot be reused from a stale run.

During evaluation:

- keep correctness checks separate from the full benchmark;
- use per-candidate log files;
- serialize benchmarks;
- record command, cwd, timeout, start/end time, exit code, and output path;
- classify verification failure, benchmark failure, timeout, invalid metric,
  and successful evaluation distinctly.

Before submission:

- apply only the selected candidate's editable artifact to main;
- re-verify and re-benchmark there;
- retain the existing submission idempotency marker behavior.

Worktree isolation is not a security sandbox. The portable default relies on
explicit tools, path audits, frozen evaluator checks, and disposable
worktrees. Container isolation is a future optional runner, not part of this
implementation.

## Parallel implementation workstreams

Four workstreams are designed to avoid overlapping file ownership.

### Workstream A: Pi worker runtime and souls

Primary ownership:

- `src/agents/subprocess.ts`
- new role soul files under `extensions/autoresearch/agents/`
- `test/subprocess.test.ts`

Deliverables:

- soul resolution;
- system-prompt append behavior;
- current-Pi executable resolution;
- complete JSONL trace capture;
- richer `AgentResult` usage and trace metadata where compatible;
- deterministic worker resource flags with version-safe behavior;
- migration of existing role prompt content into souls, with God behavior
  unchanged;
- focused subprocess tests.

Avoid editing orchestrator, state, worktree, and archive files.

### Workstream B: task contracts and archive primitives

Primary ownership:

- new `src/experiments.ts`
- new `src/archive.ts`
- new focused tests such as `test/archive.test.ts`

Deliverables:

- versioned proposal/task/result types;
- backward-compatible normalization of legacy proposals;
- candidate directory creation;
- atomic task/proposal/metrics/integrity writes;
- source snapshot and diff helpers;
- append-only ledger;
- run sealing semantics;
- focused unit tests.

Avoid editing orchestrator, subprocess runner, and worktree files.

### Workstream C: parent-aware worktree materialization

Primary ownership:

- `src/worktree.ts`
- focused worktree tests

Deliverables:

- ability to create a detached worktree and then materialize a declared parent
  editable artifact;
- candidate diff generation against the parent artifact where appropriate;
- preservation of current registry locking and cleanup behavior;
- regression test proving uncommitted current-best editable files reach the
  next candidate worktree.

Avoid editing orchestrator, state, subprocess runner, and archive files.

### Workstream D: integration, documentation, and handoff

Primary ownership:

- `src/orchestrator.ts`
- `src/state.ts`
- `src/init.ts`
- challenge adapter interfaces as needed for per-run logs;
- mock runner/schema compatibility;
- integration tests;
- `README.md`
- `docs/architecture.md`
- this plan;
- the separate-session Codex goal message.

Deliverables:

- baseline archive;
- professor and candidate task materialization;
- explicit parent propagation;
- per-run evaluation records;
- mandatory terminal postmortems;
- archive-before-cleanup;
- resume compatibility;
- documentation and migration notes.

## Testing strategy

### Unit tests

Add or update tests for:

- bundled and repo-relative soul resolution;
- the soul being appended as system instructions rather than embedded only in
  the task prompt;
- invocation through the current Pi executable or safe fallback;
- full JSONL event retention, including tool events;
- typed task validation;
- legacy proposal normalization;
- atomic archive writes;
- append-only ledger records;
- run sealing behavior;
- parent snapshot materialization;
- changed-path integrity checks;
- per-candidate log attribution.

### Integration tests

Use the mock challenge and fake Pi executable to prove:

1. initialization archives a baseline candidate;
2. the professor task points to filesystem memory rather than embedding all
   history;
3. proposals become immutable candidate tasks;
4. multiple PhDs still run concurrently;
5. each candidate starts from its declared parent snapshot;
6. verify retry receives the same task plus the latest verifier report;
7. benchmark execution remains serialized;
8. every terminal candidate receives an archive and postmortem;
9. successful/superseded worktrees are archived before cleanup;
10. failed worktrees remain available;
11. the winner is re-evaluated on main and submitted once;
12. pause/resume from every existing phase remains idempotent;
13. God still triggers after the configured dry streak and writes the same
    style of conversation;
14. advisor blockers still pause the loop.

### Compatibility tests

- Loading older version-1 `state.json` files without archive fields must
  continue safely.
- Existing custom role prompts should either migrate through a documented
  compatibility path or fail with a precise message.
- Mock runner behavior remains deterministic.
- Minimum supported Pi version is checked or documented.

### Commands

Required before completion:

```bash
npm install
npm run typecheck
npm test
```

Also run focused tests during development, for example:

```bash
npx vitest --run test/subprocess.test.ts
npx vitest --run test/archive.test.ts
npx vitest --run test/orchestrator.test.ts
```

If installation or provider-independent tests require network access, request
approval rather than silently skipping them.

## Acceptance criteria

The implementation is complete when:

- setup, professor, PhD, advisor, and God each have a role-local `SOUL.md`;
- God retains its current semantics;
- no repository-level `SOUL.md` exists;
- each real Pi worker receives its soul as system-level context and a separate
  immutable task;
- workers remain stateless across invocations;
- full Pi JSONL traces are retained for candidate work;
- proposals and PhD tasks use versioned typed contracts;
- every candidate records an explicit parent;
- next-loop candidates actually contain the declared parent's editable
  artifact even when the parent was never committed;
- candidate source, diff, metrics, logs, and postmortem survive worktree
  cleanup;
- the evaluator rejects out-of-bound changes before trusting the score;
- the existing loop state machine and submission gates remain intact;
- old state remains resumable or has a documented safe migration;
- focused tests, full tests, and typecheck pass;
- README and architecture documentation describe the new behavior;
- a comprehensive Codex goal message exists for a fresh follow-up session.

## Explicit non-goals

- No meta-harness or self-modifying prompt loop.
- No change to God's role.
- No population-based or Pareto search controller.
- No vector database or mandatory embedding index.
- No dependence on persisted child Pi sessions.
- No SDK or RPC migration.
- No OS-level sandbox implementation.
- No automatic commits to the challenge repository.
- No mutation of evaluator or challenge benchmark code.
- No requirement that users install unrelated Pi plugins or global agents.

## Risks and mitigations

### Scope expansion

Risk: archive, schema, and lineage work could accidentally become a complete
search-engine rewrite.

Mitigation: preserve the current sequential-best loop; add only explicit
lineage and evidence required for correct operation.

### Pi version drift

Risk: local Pi and development dependency versions differ.

Mitigation: prefer documented CLI behavior, reuse the active executable, add
capability/version guards, and avoid SDK internals.

### Prompt compatibility

Risk: users may already configure custom prompt files.

Mitigation: support a compatibility resolver and document how old role prompts
map to role souls. Do not silently reinterpret arbitrary files.

### Archive partial writes

Risk: interruption could leave apparently complete but inconsistent runs.

Mitigation: use atomic writes, explicit run status, and sealing only after all
required artifacts exist.

### Parallel writes

Risk: parallel PhDs could collide in ledger or shared summaries.

Mitigation: unique candidate directories, append serialization, atomic file
writes, and existing in-process mutex patterns.

### Security assumptions

Risk: a Pi worker with bash can access more than its worktree.

Mitigation: document that worktrees are not sandboxes, limit tools by role,
audit diffs before evaluation, and leave a future container runner as an
optional hardening layer.

## Implementation completion record

Update this section as work lands:

- [x] Workstream A implementation present: Pi runtime isolation, role souls,
  executable reuse, and raw trace capture
- [x] Workstream B implementation present: typed task/proposal contracts,
  archive primitives, ledger, and sealing
- [x] Workstream C implementation present: explicit parent materialization and
  deletion propagation
- [x] Workstream D integration complete
- [x] Focused tests pass
- [x] Full test suite passes (17 files, 115 tests)
- [x] Typecheck passes
- [x] Documentation updated
- [x] Separate-session Codex goal drafted

The separate-session goal in `docs/codex-goal-pi-native-agents.md` still starts
by independently auditing the working tree and this checklist rather than
assuming completion from the prior session's green test result.
