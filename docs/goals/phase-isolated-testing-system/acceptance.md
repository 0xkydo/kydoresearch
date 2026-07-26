# Acceptance audit

Verified on 2026-07-26 after integrating the phase-isolated testing system with
the guided onboarding work on top of
`d634fd42426ca820c1af8ea507b5cfd4f0cc2682`. Phase commands used
`--changed docs/testing.md` so the acceptance fixture represented explicit
phase intent without allowing the in-progress shared test-infrastructure files
to force an unrelated full run.

## Independent phase runs

| Intent | Selected tests | Result | Wall time |
|---|---:|---:|---:|
| `setup` | 52 | pass | 10.233s |
| `professor` | 36 | pass | 3.421s |
| `phd` | 74 | pass | 8.978s |
| `advisor` | 20 | pass | 2.964s |
| `finalization` | 47 | pass | 5.911s |
| `church` | 20 | pass | 2.769s |
| `metaharness` | 27 | pass | 12.945s |
| `ui` | 64 | pass | 12.978s |

The Setup capsule stopped before Professor. Every phase capsule asserted that
its forbidden later agents, commands, benchmark, finalization, or submission
effects were absent. The merged Setup selection now includes the first-run
onboarding contract, and the UI selection exercises the profile wizard,
configuration controls, real Pi loading, package installation, and PTY
failure flow.

The always-on kernel passed 23 tests in 0.500s, below its five-second budget.
The complete UI phase includes real package loading and PTY work; the semantic
kernel remains the intended sub-five-second UI edit loop.

## Selection and escalation proofs

- A frozen change to `extensions/autoresearch/prompts/professor.md` selected
  seven kernel/Professor suites and skipped Setup, PhD, finalization,
  submission, and full-loop suites.
- `professor:proposal` selected the same independent proposal boundary using
  the `explicit-segment` reason.
- A frozen onboarding change selected 16 Setup/UI suites, including the
  onboarding contract, Setup capsule, command flow, real Pi loading, and PTY
  smoke, without an unrelated full-suite escalation.
- A frozen `src/state.ts` change selected all 38 suites with shared-lifecycle
  and multi-boundary escalation reasons.
- A frozen unknown `src/unknown-impact-boundary.ts` change selected all 38
  suites with an `unknown production impact` reason.
- A docs-only selection after reconciliation selected only the four kernel
  suites and reported the latest full run as `current`.

Receipts were inspected for changed files, explicit intent, reason codes,
skipped suites, escalations, latest-full metadata, execution duration, and
per-suite durations. Concurrent runs use process-unique Vitest JSON files.

## Full reconciliation and artifacts

`npm run test:full -- --receipt /tmp/kydoresearch-merged-full-receipt.json`
passed 38 files and 216 tests in 61.075s. The G0 baseline was 172 tests in
64.6s, so 44 tests were added while wall time decreased by 3.525s (5.5%).
`npm test` independently passed the same 38 files and 216 tests in 60.81s.

The real Pi integration loaded the actual extension offline with only the
extension's `taskboard` and `research_notes` tools enabled, restored the RPC
dashboard, and installed an `npm pack` tarball in a fresh consumer. The PTY
suite passed three visible-screen flows—including the merged profile-review →
setup-preview → actionable-failure sequence—and emitted:

- `mixed-candidates.svg`
- `configuration.svg`
- `first-run-failure.svg`

All three SVGs passed `xmllint --noout`. CI retains this gallery outside
tracked source and uploads selection/full receipts. Scheduled and release jobs
exercise Pi 0.75.0 and the pinned 0.82.1.

No provider credentials, paid model, remote sync, or real leaderboard
submission were used. Finalization exercised only the disposable mock
challenge's local submit command. No `.autoresearch/`, worktree, log, score,
PTY, SVG, or provider artifact is present in tracked source.

## Deliberate decisions

- The selector computes a deterministic transitive local-import closure rather
  than delegating selection to Vitest's opaque related-file CLI. This preserves
  an exact `import-dependency` explanation for every selected suite while the
  semantic map supplies non-import runtime relationships.
- A locally known full result becomes stale after seven days. Stale or unknown
  status is visible but does not make every clean pull request full; nightly,
  release, and risk-triggered runs provide reconciliation.
- Setup and meta-harness phase entrypoints include shell/Git phase-flow suites
  and slightly exceed the initial ten-second contract target, but remain below
  the 30-second phase-flow budget. The isolated capsules remain fast.
- The optional model-judged `eval:phase` command was not added. Automated tests
  remain deterministic correctness checks.
- The human usability study was not run as part of automation. The independent
  protocol is ready for facilitated use and explicitly remains outside CI.
