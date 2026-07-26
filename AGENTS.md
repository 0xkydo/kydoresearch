# Repository Instructions for Coding Agents

## Purpose

kydoresearch is a Pi extension plus a Pi-independent TypeScript core for
running durable autonomous research loops against Yukon benchmark
repositories.

This file is for agents changing the kydoresearch source code. It is not a
runtime role soul and must not be copied into
`extensions/autoresearch/agents/<role>/SOUL.md`.

Read these before making architectural changes:

1. `README.md` for the human product contract.
2. `docs/architecture.md` for implemented component boundaries and lifecycle.
3. `docs/pi-native-agent-plan.md` for design decisions, risks, and acceptance
   criteria.
4. `docs/metaharness.md` for the optional bilevel controller, frozen-verifier
   contract, and reliability rules.

## Fixed Product Decisions

Do not change these without an explicit user request:

- Keep the Pi extension as the interactive control plane. The orchestration
  core must remain usable without importing Pi SDK internals.
- Keep Pi workers ephemeral and sessionless. Durable memory belongs in the
  filesystem, not child Pi conversations.
- Keep meta-harness evolution opt-in. It may mutate, evaluate, select, and
  promote candidate-local professor, PhD, and advisor souls, prompts, and tool
  allowlists only through `src/metaharness.ts`.
- The meta-harness must not mutate the fixed verifier, model identity,
  thinking level, budgets, score parser, promotion thresholds, setup or God
  roles, outer proposer, task/profile schemas, controller source, or prior
  evidence.
- There is no repository-level `SOUL.md`. The only souls are the six
  role-local files under `extensions/autoresearch/agents/`.
- Leave God's role, trigger, and tone unchanged. God remains the warm, honest,
  hopeful plateau-recovery conversation after repeated dry loops; God is not a
  search controller.
- Do not add automatic commits to challenge repositories.
- Do not claim that Pi tool allowlists or Git worktrees are an operating-system
  security sandbox.
- Preserve compatibility with legacy `{ "title", "spec" }` professor output
  and version-1 state files where the existing compatibility path applies.

## System Boundary

```text
interactive Pi
  -> extensions/autoresearch/       commands, UI, config, tools, notifications
  -> src/metaharness.ts             optional durable bilevel supervisor
  -> src/orchestrator.ts            durable state machine
       -> src/experiments.ts        versioned research contracts
       -> src/archive.ts            candidate evidence and terminal ledger
       -> src/worktree.ts           isolated, parent-materialized candidates
       -> src/integrity.ts          pre-evaluation changed-path audit
       -> src/challenge/            deterministic command boundary
       -> src/agents/subprocess.ts  fresh isolated Pi role invocation
```

`AgentRunner`, `ChallengeAdapter`, and `ExecPort` are deliberate ports. Prefer
extending these boundaries over coupling the core to the Pi extension.

## Role Ownership

- **Setup:** maps the repository, evaluator, constraints, and verification
  scheme. It does not optimize candidate code.
- **Professor:** searches the ledger and selected run evidence, then issues
  explicit-parent, falsifiable proposals. It does not implement candidates or
  run the performance benchmark.
- **PhD:** executes one immutable implementation task in one candidate
  worktree. It may run correctness checks but not the full benchmark.
- **Advisor:** read-only evidence watchdog. It does not become another
  professor or implementer.
- **God:** unchanged plateau-recovery conversation.
- **Meta-harness:** outer-loop evidence diagnostician. It may write only the
  assigned draft profile and candidate-local professor/PhD/advisor role
  artifacts. It does not edit the challenge, evaluator, archive, prior
  profiles, or itself.

Stable role behavior belongs in a role's `SOUL.md`. Invocation-specific data
belongs in a versioned task JSON. Dynamic prompt templates are a compatibility
layer; do not move current loop state into souls.

## Filesystem and Memory Invariants

`.autoresearch/` lives in the challenge repository and is excluded through
`.git/info/exclude`. It must remain outside the challenge's `editablePaths`.

Memory ownership:

- `state.json`: authoritative operational checkpoint and resume state.
- `journal.ndjson`: append-only operational transitions.
- `ledger.ndjson`: compact append-only index of terminal candidate runs.
- `runs/<candidateId>/`: authoritative empirical evidence.
- `knowledge-base.md`: human-readable navigation, not the sole memory store.
- Pi JSONL traces: complete per-invocation model and tool lifecycle evidence.
- Worktrees: disposable execution surfaces; failed worktrees are retained.
- `metaharness/`: outer state, frozen verifier contract, candidate profiles,
  evaluation ledger, frontier, proposer traces, and heartbeat.

Every terminal candidate must have, before cleanup:

- immutable task, proposal, and parent records;
- exact editable-source snapshot;
- parent-relative diff;
- metrics and evaluation provenance;
- integrity result;
- verifier and benchmark logs;
- result-aware postmortem;
- sealed run record;
- exactly one ledger entry.

Sealing and ledger insertion are two recoverable steps. Resume must repair a
sealed candidate missing its ledger entry.

## Lineage and Worktree Invariants

- Git `HEAD` is not the research parent. The current best may exist only as an
  uncommitted main-checkout change.
- Every candidate names an explicit archived parent.
- A new worktree starts detached for Git isolation, then the complete archived
  parent `editablePaths` surface is materialized over it.
- Parent and winner deletions must propagate; never copy only files that still
  exist.
- Parallel sibling candidates may share a parent, but must never share a
  worktree or run directory.
- Worktree registry changes are serialized. Candidate implementation work may
  run in parallel.
- Performance benchmarks are globally serialized through the benchmark lock.
- Only a selected winner is copied to main, then re-verified and re-benched
  before submission.

## Interruption and Immutability Rules

- Persist resume markers before an operation whose replay could duplicate
  external effects.
- Checkpoint the normalized professor proposal set and base revision before
  creating candidate runs.
- Immutable artifacts may be accepted on resume only when their contents
  exactly match the expected value.
- Never mutate a sealed run.
- Never prune a successful or superseded worktree before its candidate archive
  is sealed and indexed.
- Submission state is the local idempotency marker. Preserve the existing
  duplicate-submission tests.
- Pin one validated harness profile to a complete inner evaluation window.
  Never change profiles after immutable professor output or candidate runs
  exist for that loop.
- Reconcile completed evaluation loops from inner durable history after
  interruption; do not double-count them.
- Re-hash a profile on activation and verify the frozen evaluator fingerprint
  before proposal and after evaluation.
- Roll back only to the last-known-good profile and only before the active
  inner loop has materialized immutable proposal output. Otherwise fail-stop.

## Pi Worker Rules

The subprocess runner must:

- use a fresh `pi --mode json -p --no-session` worker;
- prefer the active Pi executable and fall back to `pi` on `PATH`;
- disable ambient extensions, skills, prompt templates, and context files;
- append the role soul as system context;
- apply role defaults and any narrower per-task tool policy;
- keep trace writes inside `.autoresearch/`;
- retain the effective soul, rendered context, invocation metadata, and raw
  JSONL events;
- terminate process groups on timeout or abort without leaking descriptors.

Because ambient context loading is disabled, implementation tasks must
explicitly reference archived snapshots of applicable `AGENTS.md`,
`CLAUDE.md`, or scoped repository instruction files.

Postmortems run outside the main checkout with a read-only Pi tool policy. The
harness, not the postmortem worker, writes the returned markdown.

## Safety Rules

- Run candidate integrity auditing after implementation and before every
  evaluator invocation.
- Changes are permitted only under the declared editable surface, except for
  unchanged untracked setup artifacts copied from main.
- Never let agents modify the evaluator, score parser, archive, prior evidence,
  or task contract.
- Treat benchmark and verifier output as untrusted process output. Attribute it
  to the correct candidate log.
- Remove stale score files before benchmarking.
- Correctness, score validity, improvement, and terminal status are harness
  decisions, never LLM decisions.
- Use explicit validated paths for destructive operations. Do not introduce
  broad recursive deletion targets.

## Source Map

| Path | Responsibility |
|---|---|
| `extensions/autoresearch/commands.ts` | `/autoresearch` lifecycle and dialogs |
| `extensions/autoresearch/config-ui.ts` | Interactive role/harness configuration |
| `extensions/autoresearch/agents/*/SOUL.md` | Stable runtime role behavior |
| `extensions/autoresearch/prompts/*.md` | Dynamic compatibility prompts |
| `src/orchestrator.ts` | Loop phases, candidate lifecycle, resume, selection |
| `src/metaharness.ts` | Optional outer profile evolution, verifier fingerprint, rollback, frontier |
| `src/experiments.ts` | Versioned proposal/task/result/metrics contracts |
| `src/archive.ts` | Atomic artifacts, snapshots, diffs, sealing, ledger |
| `src/integrity.ts` | Git-status-based pre-evaluation audit |
| `src/worktree.ts` | Parent materialization and winner application |
| `src/agents/subprocess.ts` | Real Pi subprocess invocation and traces |
| `src/agents/mock.ts` | Deterministic test agent |
| `src/challenge/adapter.ts` | Setup, verify, benchmark, submit, sync |
| `src/state.ts` | Durable operational state |
| `src/config.ts` | Portable defaults and deep config merge |
| `fixtures/mock-challenge/` | End-to-end deterministic challenge |

## Development Workflow

Preserve unrelated working-tree changes. Do not reset, discard, commit, push,
or open a pull request unless the user explicitly asks.

Use:

```bash
npm install
npm run typecheck
npm test
git diff --check
```

Focused suites:

```bash
npx vitest --run test/subprocess.test.ts
npx vitest --run test/archive.test.ts
npx vitest --run test/worktree.test.ts
npx vitest --run test/integrity.test.ts
npx vitest --run test/adapter.test.ts
npx vitest --run test/orchestrator.test.ts
npx vitest --run test/orchestrator-subprocess.test.ts
npx vitest --run test/metaharness.test.ts
```

When changing a contract, update its runtime validation and archive tests.
When changing a resume boundary, add a test that simulates interruption between
the relevant writes. When changing a prompt or soul, keep runtime behavior,
README documentation, and subprocess rendering tests aligned.

Do not call work complete until typecheck, the focused affected suites, the
full suite, and `git diff --check` pass.
