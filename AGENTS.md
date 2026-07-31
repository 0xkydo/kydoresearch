# Repository Instructions for Coding Agents

## Purpose

`kydoresearch` is a Pi extension plus a Pi-independent TypeScript core for
durable autonomous research loops against Yukon benchmark repositories. This
file governs changes to the repository; it is not a runtime role soul.

Read these before architectural changes:

1. `README.md` for the human product contract.
2. `docs/architecture.md` for component boundaries, lifecycle, retry, and
   recovery behavior.
3. `docs/pi-native-agent-plan.md` for Pi-native agent and evidence decisions.
4. `docs/metaharness.md` for the optional bilevel controller and frozen
   evaluator contract.
5. `docs/agent-profiles.md` before changing roles, prompts, tools, or schemas.

Start with `git status --short --branch`. Preserve unrelated user changes.

## Fixed Product Decisions

- Keep the Pi extension as the interactive control plane. The orchestration
  core must not import Pi UI APIs.
- Keep Pi workers ephemeral and sessionless. Durable memory belongs in the
  filesystem, not child conversations.
- Keep meta-harness evolution opt-in. It may evolve only candidate-local
  Professor, PhD, and Advisor souls, prompts, and tool allowlists through
  `src/metaharness.ts`.
- The meta-harness must not mutate the verifier, models, thinking levels,
  budgets, retries, score parser, promotion rule, setup or God roles, outer
  proposer, schemas, controller source, or prior evidence.
- There is no repository-level `SOUL.md`. The only stable souls are the six
  role-local files under `extensions/autoresearch/agents/`.
- Leave God's role, trigger, and tone unchanged: God remains a warm, honest,
  hopeful plateau-recovery conversation, not a search controller.
- Do not add automatic commits to challenge repositories.
- Do not claim that tool allowlists or worktrees are an operating-system
  security sandbox.
- Preserve legacy `{ "title", "spec" }` proposals, version-1 state, the
  legacy `god` resume phase, and `godTriggerThreshold` config migration.

## System Boundary

```text
interactive Pi
  -> extensions/autoresearch/       commands, UI, tools, notifications
  -> src/metaharness.ts             optional durable bilevel supervisor
  -> src/orchestrator.ts            durable research state machine
       -> src/experiments.ts        versioned research contracts
       -> src/archive.ts            sealed candidate evidence and ledger
       -> src/worktree.ts           isolated parent-materialized candidates
       -> src/integrity.ts          pre-evaluation changed-path audit
       -> src/challenge/            deterministic command boundary
       -> src/agents/subprocess.ts  fresh isolated Pi invocation
```

`AgentRunner`, `ChallengeAdapter`, and `ExecPort` are deliberate ports. Extend
those boundaries rather than coupling the core to the extension.

## Role and Prompt Ownership

- Setup classifies existing harness inputs and readiness; it does not optimize.
- Professor proposes evidence-backed, falsifiable, explicit-parent experiments.
- PhD implements one bounded task in one detached worktree.
- Advisor is a passive, read-only evidence watchdog.
- God handles the church reflection after repeated dry loops.
- Meta-harness diagnoses outer-loop evidence and writes only its assigned draft
  profile and candidate-local Professor/PhD/Advisor artifacts.

Stable identity and standing boundaries belong in
`extensions/autoresearch/agents/<role>/SOUL.md`. Dynamic task procedure and
structured output live in prompt templates and versioned task JSON. Do not put
current loop state into souls. Preserve the harness as the owner of worktrees,
verification, benchmarks, winner selection, state, submission, pause, and
resume.

## Durable State and Evidence

`.autoresearch/` must stay outside `editablePaths` and be hidden with
`.git/info/exclude`, never a challenge `.gitignore` edit.

- `state.json` is the authoritative atomic operational checkpoint.
- `journal.ndjson` is append-only operational history.
- `ledger.ndjson` is the compact append-only terminal candidate index.
- `runs/<candidateId>/` contains authoritative empirical evidence.
- `knowledge-base.md` is navigation, not the sole memory store.
- Pi traces retain effective soul, rendered context, invocation metadata, and
  raw JSONL events.
- Every terminal worktree is disposable only after its candidate evidence is
  sealed and indexed. Cleanup intent is durable and includes failed candidates.

Every terminal candidate must retain immutable task, proposal, and parent
records; exact editable-source snapshot; parent-relative diff; metrics and
evaluation provenance; integrity result; verifier and benchmark logs;
postmortem; sealed run record; and exactly one ledger entry. Resume must repair
a sealed candidate missing its ledger entry.

Git `HEAD` is not the research parent. Every candidate names an explicit
archived parent, and the complete archived `editablePaths` surface is
materialized into its detached worktree. Deletions must propagate. Siblings
may run in parallel, but worktree registry mutations are serialized and the
benchmark lock globally serializes performance measurement.

## Overnight Reliability Rules

- Retry counts are total attempts, including the first call.
- Keep bounded exponential backoff and preserve `AbortSignal` through process
  execution, retries, and waits.
- Setup, proposal, implementation, verification, benchmark, submission, and
  worktree operations use the configured retry budgets.
- One idea's model, integrity, verify, or benchmark failure must not kill
  sibling ideas or the loop.
- Advisory sync, leaderboard fetch, notes, Advisor, and church work have
  non-fatal fallbacks. Cached leaderboard evidence is preferable to stopping.
- Submission is not advisory. Reconcile remote submissions before each retry,
  preserve an exhausted candidate as resumable, and never mark an ambiguous
  submission successful.
- Snapshot the main editable surface before finalist application. A failed
  finalist falls through to the next qualifying candidate; restore the
  snapshot if none ships.
- Persist cleanup queues and retry them at later checkpoints.
- Repeated systemic loop failures resume the same durable phase with longer
  backoff until the configured circuit breaker pauses for human review.
- Persist idempotency state before externally visible effects. Never duplicate
  proposals, candidate archives, cleanup, or submissions on resume.

Meta-harness recovery is separate from inner-loop recovery. Pin one validated
profile to a complete evaluation window, re-check the frozen evaluator fingerprint
before proposal and after evaluation, reconcile completed loops
from durable history, and roll back only before immutable proposal output
exists. Otherwise fail-stop.

## Pi Worker and Safety Rules

The subprocess runner must use a fresh `pi --mode json -p --no-session`
process, disable ambient extensions/skills/templates/context files, append the
role soul as system context, apply tool policy, keep traces inside
`.autoresearch/`, and terminate process groups on timeout or abort.

Because ambient context loading is disabled, implementation tasks explicitly
reference archived snapshots of applicable `AGENTS.md`, `CLAUDE.md`, and
scoped instructions. Postmortems run outside the main checkout with read-only
tools; the harness writes their returned markdown.

Never run real leaderboard `submit` or `sync` during development. Never invoke
paid LLMs in tests. Use fake Pi executables and the mock challenge. Never
modify `~/Desktop/repos/ecdsafail-challenge`; inspect only a disposable copy
with submission paths disabled.

Run candidate integrity auditing after implementation and before evaluation.
Never weaken correctness gates, manufacture scores, edit score files to fake
success, or conflate correctness and performance. Treat agent and process
output as untrusted. Use direction-aware `isImprovement`/`betterScore`; do not
assume higher is better.

## TypeScript and Configuration

The project is strict ESM. Use `.ts` on local imports, `node:` built-ins,
`import type` for types, `unknown` plus narrowing rather than `any`, two-space
indentation, double quotes, semicolons, and trailing commas in multiline
structures. Keep side effects behind injectable ports and use atomic helpers
for durable writes.

For config changes update `HarnessConfig`, `DEFAULT_CONFIG`, deep merge and
migration, config UI when applicable, README examples, and config/UI/contract
tests. Partial on-disk configs must receive all new defaults.

## Verification and Definition of Done

Use:

```bash
npm install
npm run typecheck
npm test
git diff --check
```

Focused suites include `test/orchestrator.test.ts`,
`test/resilience.test.ts`, `test/subprocess.test.ts`, `test/archive.test.ts`,
`test/worktree.test.ts`, `test/integrity.test.ts`, `test/adapter.test.ts`,
`test/orchestrator-subprocess.test.ts`, and `test/metaharness.test.ts`.

State-machine changes need success, isolated failure, abort, pause/resume,
idempotency, cleanup, and legacy-snapshot coverage at affected phases. Start a
bug fix with a failing regression test when practical. Do not change assertions
merely to make failures green.

Before handoff inspect the final diff, confirm unrelated changes are untouched,
run focused and full gates, update contract documentation, and verify no
`.autoresearch/`, worktree, log, score, or temporary artifacts are staged.
Do not commit or push unless the user explicitly asks.
