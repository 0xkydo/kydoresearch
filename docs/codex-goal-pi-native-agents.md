# Codex Goal: Finish and Audit the Pi-Native Agent Harness

> Archived goal: this document specified the completed Pi-native inner-loop
> milestone. Its no-meta-harness constraint applied to that milestone and was
> superseded by the later opt-in wrapper in `src/metaharness.ts`; see
> `docs/metaharness.md` for the current outer-loop contract.

Use the following as the complete goal message for a fresh Codex session:

---

Finish, audit, and validate the Pi-native autonomous research-agent refinement
already implemented in this kydoresearch working tree.

Start by reading these files in full:

1. `docs/pi-native-agent-plan.md`
2. `docs/architecture.md`
3. `README.md`
4. the current `git status` and full working-tree diff

The conceptual source is Aman Chadha's AutoResearch and Meta-Harness primer,
especially the experiment lifecycle, system architecture, autonomous-agent
design, filesystem memory, and search sections:

https://aman.ai/primers/ai/autoresearch-and-metaharness/#the-experiment-lifecycle

Use those ideas to improve the existing agent experiment lifecycle, memory,
and evidence-based search. This archived milestone did not implement the
article's self-evolving meta-harness loop; a later explicit product request
added the bounded outer controller.

## Fixed product decisions

Treat these as non-negotiable:

- Keep the existing Pi extension as the user-facing control plane unless you
  can demonstrate a concrete Pi limitation that makes an extension unable to
  satisfy a required behavior. No such limitation has been identified.
- Keep the Pi-independent orchestration core and current state machine. Do not
  replace it with an SDK/RPC service, general workflow framework, or a new
  search controller merely because one is available.
- Think from first principles about what Pi provides: a fresh model/tool loop,
  system-prompt append, JSON event mode, per-run model/thinking/tool settings,
  extensions, commands, and UI. Pi does not provide durable multi-agent state,
  candidate lineage, benchmark locks, worktree coordination, a default
  security sandbox, or portable memory between `--no-session` invocations.
- Pi workers must remain ephemeral. The harness filesystem is the durable
  memory.
- There is no repository-level `SOUL.md`, and none should be added. `SOUL.md`
  means one role-local file for each of setup, professor, PhD, advisor, and
  God under `extensions/autoresearch/agents/<role>/SOUL.md`.
- Leave God's role alone. God remains the same warm, wise, honest, hopeful
  plateau-recovery conversation after repeated dry loops: acknowledge the
  plateau, reframe failures as information, point to unexplored directions,
  and end with the professor recommitted to a concrete hopeful direction.
  Moving its unchanged behavior into the common soul layout is allowed;
  changing its purpose, trigger semantics, tone, or making it a search/meta
  controller is not.
- For this archived milestone, do not mix meta-harness changes into the
  Pi-native inner-loop workstream. The later wrapper is a separate component.
- Preserve parallel PhD execution, serialized Git worktree registry changes,
  the one-at-a-time benchmark lock, deterministic verification and scoring,
  direction-aware improvement, main-checkout re-verification/re-benchmarking,
  submission idempotency behavior, pause/resume checkpoints, advisor blockers,
  God triggering, and deliberate retention of failed worktrees.
- Design for portability. Do not rely on one user's home directory, global Pi
  extensions, skills, prompt templates, persisted child sessions, or a
  hard-coded Pi binary path.
- Do not add automatic commits to challenge repositories, mutate evaluator
  code, or treat a worktree as an OS security sandbox.
- Preserve unrelated user changes. Do not reset, discard, commit, push, or
  open a pull request unless explicitly asked.

## Intended architecture

Keep this boundary:

```text
interactive Pi
  -> kydoresearch extension (commands, UI, config, lifecycle)
  -> Pi-independent Orchestrator
       -> state.json operational checkpoint
       -> versioned immutable task contracts
       -> candidate run archive + compact append-only ledger
       -> explicit parent snapshots + Git worktrees
       -> pre-evaluation integrity audit
       -> deterministic verify/benchmark/submit adapter
       -> fresh isolated PiSubprocessRunner role invocation
```

The soul defines stable role behavior. The task JSON defines the immutable
requirement for one invocation. Current loop/score/candidate/history data does
not belong in a soul.

Role responsibilities:

- Setup is a repository cartographer and experiment-contract compiler. It
  establishes repository facts, evaluator boundaries, correctness versus
  performance commands, constraints, scoring, and the initial knowledge base.
  It does not optimize candidate code.
- Professor is an evidence-driven research director. It reads the compact
  ledger and relevant run evidence, proposes mechanistic falsifiable
  experiments, selects an explicit parent, classifies search mode/edit family,
  avoids duplicate in-flight work, and never edits candidate code or runs the
  full benchmark.
- PhD executes exactly one candidate task, starts from the declared parent,
  makes one coherent intervention only in editable paths, uses cheap checks
  and the correctness command, never runs the performance benchmark, and
  reports changed files/checks/assumptions/deviations. A retry receives the
  same requirement plus the latest verifier report. A terminal candidate gets
  a result-aware postmortem.
- Advisor is a read-only watchdog. It checks state, diffs, metrics, logs, and
  `WATCHDOG.md`; it reserves blockers for integrity, safety, or unrecoverable
  conditions and does not become another implementer/professor.
- God is unchanged as specified above.

Search is still professor-directed sequential-best experimentation, not
population or Pareto search. The current best is the default parent, parallel
siblings may share it, proposals cite evidence and a falsifier, and the
professor can inspect `ledger.ndjson` plus selected `runs/<candidateId>/`
evidence rather than depending on a growing chat transcript.

Memory ownership:

- `state.json`: authoritative operational state and resume checkpoint;
- `journal.ndjson`: append-only operational transitions;
- `runs/<candidateId>/`: authoritative empirical candidate evidence;
- `ledger.ndjson`: append-only compact terminal-run index used for search;
- `knowledge-base.md`: human-readable navigation and subject summary, not the
  sole memory store;
- Pi JSONL traces: full per-invocation empirical trace;
- worktrees: disposable execution surfaces, except failed worktrees retained
  intentionally for diagnosis.

## Implementation currently present in the working tree

Do not start over. Inspect, test, and refine the existing implementation:

- `extensions/autoresearch/agents/{setup,professor,phd,advisor,god}/SOUL.md`
  contains role-local souls. Confirm God's content preserves the previous role
  exactly enough to satisfy the fixed decision.
- `src/config.ts` adds optional per-role `soul`, preserves `prompt` as the
  dynamic compatibility template, and provides explicit default tool
  allowlists by role.
- `src/agents/subprocess.ts` resolves bundled/repo-relative souls, snapshots
  the effective soul, appends it through Pi's system prompt, starts fresh JSON
  sessionless workers, disables ambient extensions/skills/prompt
  templates/context files, prefers the active Pi executable, captures raw
  JSONL events, snapshots the rendered context and invocation metadata, and
  retains existing structured-output fallback behavior.
- `extensions/autoresearch/config-ui.ts` and
  `extensions/autoresearch/commands.ts` expose role-local souls separately
  from dynamic prompts.
- `src/experiments.ts` adds versioned canonical proposal, task, result,
  evaluation, parent, integrity, and metric contracts plus runtime task
  validation and legacy `{title, spec}` proposal normalization.
- `src/archive.ts` adds safe run paths, resume-safe run creation, immutable
  task/proposal/parent writes, active artifact writes, complete editable-source
  snapshots, parent-relative diffs, run readiness/sealing, and a serialized
  append-only ledger that accepts only matching sealed runs.
- `src/worktree.ts` can create a detached worktree and materialize a declared
  parent editable snapshot, including propagating deletions. Winner
  application to main also propagates deletions.
- `src/integrity.ts` audits Git status before evaluation, permits changes only
  under editable paths, permits unchanged untracked setup artifacts seeded
  from main, and rejects evaluator mutations, new out-of-bound paths, modified
  seeded artifacts, and out-of-bound rename sides.
- `src/challenge/types.ts` and `src/challenge/adapter.ts` support per-candidate
  verify/benchmark log paths while preserving default main logs.
- `src/state.ts` adds optional lineage/archive/evaluation fields for version-1
  state compatibility and adds ledger/loop/run/resolved-agent paths.
- `src/init.ts` creates a typed setup task and trace, benchmarks the baseline,
  snapshots baseline editable paths under `runs/baseline/source`, records
  baseline Git revision/score, and sets `bestCandidateId`.
- `src/orchestrator.ts` materializes professor/advisor/God tasks, normalizes
  and checkpoints proposal sets before run creation, creates candidate runs,
  propagates explicit parents, snapshots applicable repository instructions,
  materializes attempt tasks, starts worktrees from archived parent source,
  runs integrity before verification, attributes evaluation records/logs,
  runs postmortems with a read-only per-task policy outside the main checkout,
  archives before cleanup, seals runs, repairs missing post-seal ledger
  entries, and provides a compatibility path for older state.
- Tests added or updated include `test/subprocess.test.ts`,
  `test/archive.test.ts`, `test/worktree.test.ts`,
  `test/integrity.test.ts`, `test/adapter.test.ts`,
  `test/orchestrator.test.ts`, and
  `test/orchestrator-subprocess.test.ts`.
- User-facing documentation is in `README.md`, `docs/architecture.md`, and
  `docs/pi-native-agent-plan.md`.

These statements describe intended/current working-tree changes, not a promise
that every path is correct. Verify them against the source and tests.

## Required work

Work through the existing plan without redesigning the architecture:

1. Inspect the complete diff and map every change to the fixed decisions and
   acceptance criteria. Identify incomplete wiring, incorrect assumptions,
   unsafe path behavior, resume hazards, and test gaps.
2. Run focused tests for the four implementation tracks and fix failures:

   ```bash
   npx vitest --run test/subprocess.test.ts
   npx vitest --run test/archive.test.ts
   npx vitest --run test/worktree.test.ts
   npx vitest --run test/integrity.test.ts
   npx vitest --run test/adapter.test.ts
   npx vitest --run test/orchestrator.test.ts
   npx vitest --run test/orchestrator-subprocess.test.ts
   ```

3. Run `npm run typecheck` and `npm test`. Fix all regressions. Do not skip
   provider-independent failures. If dependencies are missing, use the
   repository's normal install command and request approval for network access
   rather than silently bypassing tests.
4. Audit the experiment lifecycle end to end:
   - initialization produces a usable baseline source artifact and typed setup
     task;
   - the professor task points to filesystem memory and proposals normalize
     into immutable canonical records;
   - every proposal has a valid existing explicit parent;
   - the child worktree really contains the parent snapshot even when the
     current best was copied to main but never committed;
   - deletions in a parent or winning candidate propagate correctly;
   - each implementation attempt gets the correct immutable task and retry
     verifier context;
   - out-of-bound changes are rejected before the evaluator runs;
   - candidate verify/benchmark output is correctly attributed;
   - benchmark execution remains serialized;
   - local and main-checkout evaluation provenance is not accidentally lost or
     mislabeled;
   - every terminal candidate gets source, parent-relative diff, metrics,
     integrity, logs, postmortem, a sealed record, and exactly one ledger
     entry before any cleanup;
   - failed-before-worktree, failed-implementation, integrity-failed,
     verify-failed, benchmark-failed, no-improvement, superseded, and improved
     candidates all archive coherently;
   - failed worktrees remain and successful/superseded worktrees are removable
     only after archival;
   - the winning archived source becomes the next loop's actual parent;
   - main re-verification, re-benchmarking, submission, and submission replay
     prevention remain intact.
5. Audit interruption and compatibility behavior:
   - resume from every existing phase remains idempotent;
   - an active partially written run is safely continued rather than
     overwritten or duplicated;
   - sealed runs cannot be mutated;
   - a ledger append cannot duplicate a candidate;
   - old version-1 states missing new optional fields either resume safely or
     fail with a precise recoverable message;
   - mock behavior remains deterministic;
   - custom prompt paths retain their documented compatibility behavior;
   - role soul and trace paths cannot escape the intended repository/state
     boundary;
   - the Pi flags used are supported by the declared minimum Pi version, or
     are capability/version guarded without introducing SDK coupling.
6. Audit role/runtime behavior:
   - all five role-local souls exist and there is no root `SOUL.md`;
   - God is unchanged in purpose, trigger, and tone;
   - souls are system-level context, not a substitute for task JSON;
   - workers are fresh and sessionless;
   - candidate invocations retain raw tool/message JSONL events and the
     effective soul;
   - ambient user extensions, skills, prompt templates, and context files do
     not leak into portable workers;
   - process timeout/abort cleanup cannot leak file descriptors or child
     processes;
   - malformed or absent structured output fails clearly. The existing
     trailing fenced-JSON compatibility fallback is acceptable for this
     increment; do not add a worker-only completion extension unless a failing
     acceptance criterion proves it necessary.
7. Update documentation and the completion record only to match verified
   behavior. Keep the explanation explicit that this milestone did not include
   a meta-harness loop, a repo-level soul, or a change to God.

## Acceptance criteria

Do not call the goal complete until all of the following are true:

- setup, professor, PhD, advisor, and God each have a role-local `SOUL.md`;
- no repository-level `SOUL.md` exists;
- God retains its previous semantics;
- every real Pi worker receives its soul as system-level context and a
  separate versioned task;
- workers are fresh/sessionless and portable across users;
- full candidate Pi JSONL traces and effective souls are retained;
- canonical typed proposals and tasks are validated before persistence/use,
  with documented legacy proposal compatibility;
- every candidate records an explicit parent and valid parent source;
- a later candidate actually starts from an uncommitted archived current-best
  artifact, including deletions;
- integrity rejects changes outside editable paths before verification;
- verify and benchmark logs/records are attributable to the correct candidate;
- every terminal candidate's complete evidence survives worktree cleanup and
  its sealed run has one ledger entry;
- search can use the compact ledger and inspect selected run evidence;
- benchmark locking, main-checkout gates, direction-aware selection,
  submission behavior, pause/resume, advisor blocking, and God triggering
  still work;
- old state has a safe compatibility path;
- focused tests pass;
- `npm run typecheck` passes;
- `npm test` passes;
- README, architecture, and the plan completion checklist describe actual
  behavior;
- no meta-harness loop was introduced in this milestone, and no root
  `SOUL.md`, SDK/RPC migration, vector database, OS-sandbox claim, or unrelated
  architectural rewrite was introduced.

At the end, report:

- the outcome first;
- files changed;
- important defects found and how they were resolved;
- focused/full test and typecheck results with exact commands;
- any acceptance criterion that remains unproven;
- any deliberate deviation from `docs/pi-native-agent-plan.md`.

Do not mark the work complete just because the architecture looks plausible;
completion requires the all-green validation above.

---
