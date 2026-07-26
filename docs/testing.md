# Phase-isolated testing

The extension test system selects by research phase and semantic impact rather
than treating a changed filename as the whole contract. It combines:

1. an explicit phase or segment supplied by the developer;
2. transitive local-import analysis from each test file;
3. the repository-owned semantic rules in `test/impact-map.json`; and
4. a small always-on safety kernel.

Unknown production paths and shared lifecycle/evaluator changes select the
full suite. Selection never relaxes the verifier or turns a worktree into a
claimed security boundary.

## Commands

```bash
npm run test:phase -- setup
npm run test:phase -- professor
npm run test:phase -- phd
npm run test:phase -- advisor
npm run test:phase -- finalization
npm run test:phase -- church
npm run test:phase -- metaharness
npm run test:phase -- ui

npm run test:phase -- professor:proposal
npm run test:phase -- finalization:submission

npm run test:kernel
npm run test:related
npm run test:explain
npm run test:full
```

`test:phase` accepts `--tier phase-contract`, `--tier phase-flow`,
`--tier integration`, or `--tier pty` when only one declared tier is wanted.
`test:related` uses the working-tree diff by default; CI passes
`--base origin/<pull-request-base>`. Tests and automation may pass repeated
`--changed <path>` arguments for a frozen selection case.

`test:explain` is a dry run. Every selective command prints a receipt. Use
`--json` for machine-readable stdout or `--receipt <path>` to persist it.
Receipts contain the commit, timestamp, changed files, explicit intent,
selected test and reason for each selection, skipped suites, escalation
decisions, per-suite execution durations, and the most recent locally known
successful full-suite reference.
The full-suite reference is local test metadata under
`node_modules/.cache/kydoresearch-test/`; it is never committed.

A known full-suite result is `current` for seven days and `stale` afterward.
Missing, malformed, or non-date metadata is `unknown`. Stale or unknown local
metadata is explicit in every receipt but does not force every clean pull
request to repeat the full suite: scheduled main and release jobs provide that
reconciliation, while risk rules still escalate the current change immediately.

## Stable contracts

Phase IDs:

`setup`, `professor`, `phd`, `advisor`, `finalization`, `church`,
`metaharness`, and `ui`.

Segments are phase-prefixed independent contracts. Current segments are:

- `setup:baseline-review`
- `professor:proposal`
- `phd:implementation`
- `advisor:review`
- `finalization:submission`
- `church:reflection`
- `metaharness:profile-validation`
- `ui:dashboard`
- `ui:config`

Tiers:

- `kernel`: schema/package readability and critical UI meaning;
- `phase-contract`: task, validator, persistence, and immediate boundary;
- `phase-flow`: deterministic shell/Git behavior inside one phase;
- `integration`: actual Pi loading, package installation, or subprocesses;
- `pty`: real visible-screen terminal flows;
- `full`: shared lifecycle and whole-loop reconciliation.

Selection reason codes are `always-on-kernel`, `explicit-phase`,
`explicit-segment`, `changed-test`, `import-dependency`, `semantic-impact`,
and `full-escalation`. These identifiers and the version-1 receipt schema are
validated in `src/test-system/contracts.ts`. Malformed or incomplete impact
metadata fails closed.

## Phase capsule shape

All capsules under `test/phases/<phase>/` use:

```text
frozen durable input
  -> production phase behavior
  -> deterministic recording ports
  -> durable output
  -> phase assertion
  -> immediate next-boundary compatibility
  -> abort before the next phase
```

`test/support/phase-testkit/` creates isolated mock challenge repositories,
records runner calls, commands, events, waits, journal/state files, and uses
normal abort/resume checkpoints as its boundary stop. It has no paid runner
and rejects fixture paths outside the declared test root.

To add a phase or segment:

1. add the identifier and validator path in
   `src/test-system/contracts.ts`;
2. add the segment, suite, and semantic path rule in
   `test/impact-map.json`;
3. add a capsule using production task/validator/persistence behavior;
4. assert the immediate consumer can read its output and that later agents,
   benchmarks, or submissions did not run;
5. add selector fixtures for narrow selection and conservative escalation;
6. update this document and the scheduled compatibility matrix if required.

The selector rejects unmapped `test/**/*.test.ts` files, so classification is
part of the change rather than optional cleanup.

## Mandatory escalation

A full suite is required for:

- shared phase/state/task contracts;
- common retry, abort, pause, resume, journal, telemetry, or runner behavior;
- evaluator, score direction, finalist, archive, or submission foundations;
- multi-phase `AgentRunner`, `ChallengeAdapter`, or `ExecPort` behavior;
- package metadata, dependency lockfiles, TypeScript/Vitest configuration,
  test infrastructure, or CI;
- changes crossing three or more phase boundaries;
- eight or more production files;
- unknown production paths; and
- explicit `test:full`.

Documentation-only changes run the kernel. Releases, nightly main, and
risk-escalated pull requests run the full suite. UI semantic changes add
interaction and PTY coverage through the impact map.

## Safety

All automated flows use the mock challenge, deterministic `MockAgentRunner`,
fake Pi executables, injected ports, or Pi in offline mode without provider
credentials. Tests never run real Yukon sync or submission and never invoke a
paid model. The finalization capsule's submission is the local mock challenge
CLI only.
