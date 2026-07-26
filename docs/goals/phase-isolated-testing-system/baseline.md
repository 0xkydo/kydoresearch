# G0 baseline: test inventory and timing

Reference environment: macOS, Node 24.18.0, npm 12.0.1, Vitest 3.2.7, Pi
0.82.1. The measurement was taken on commit
`1c51a0c9e6adf9dc111ad6522b6cc6ebc400a137` before the selective-test
implementation. `npm test -- --reporter=json` passed 172 tests. Wall-clock
duration was 64.6 seconds; Vitest ran files concurrently, so file durations do
not sum to wall time.

| Existing suite | Duration | Classification | Primary phase/surface |
|---|---:|---|---|
| `test/orchestrator.test.ts` | 64.3s | full-loop | shared lifecycle |
| `test/orchestrator-subprocess.test.ts` | 47.0s | full-loop | shared runner/lifecycle |
| `test/resilience.test.ts` | 38.4s | full-loop | shared retry/recovery |
| `test/init.test.ts` | 30.5s | phase-local | Setup |
| `test/metaharness.test.ts` | 30.0s | phase-local | Meta-harness |
| `test/subprocess.test.ts` | 17.9s | phase-local/integration | PhD/runner |
| `test/commands.test.ts` | 10.5s | adjacent-boundary | UI/control plane |
| `test/adapter.test.ts` | 9.2s | adjacent-boundary | Setup/finalization |
| `test/integrity.test.ts` | 1.7s | phase-local | PhD |
| `test/worktree.test.ts` | 0.8s | adjacent-boundary | PhD/finalization |
| `test/exec.test.ts` | 0.34s | cross-cutting | process port |
| `test/archive.test.ts` | 0.05s | adjacent-boundary | Professor/PhD/finalization |
| `test/taskboard.test.ts` | 0.03s | cross-cutting | UI/control plane |
| `test/config.test.ts` | 0.007s | cross-cutting | configuration kernel |
| `test/steering.test.ts` | 0.004s | adjacent-boundary | Professor/UI |
| `test/widget.test.ts` | 0.004s | phase-local | UI |
| `test/config-ui.test.ts` | 0.003s | phase-local | UI |
| `test/telemetry.test.ts` | 0.003s | cross-cutting | telemetry |
| `test/architecture.test.ts` | 0.002s | cross-cutting | documentation contract |
| `test/readme.test.ts` | 0.002s | cross-cutting | documentation contract |
| `test/retry.test.ts` | 0.001s | cross-cutting | retry |
| `test/package.test.ts` | 0.001s | package/install | package kernel |
| `test/agents-doc.test.ts` | 0.001s | cross-cutting | role documentation |

Every pre-existing test is classified in `test/impact-map.json`; new tests must
be added to that inventory before the selector will execute.

## Slow-cost map

- Repository setup, shell verification, and Git worktrees dominate
  `init`, `orchestrator`, `resilience`, and `worktree`.
- Fresh Pi subprocess launch, JSONL capture, timeout/process-group behavior,
  and fake executable fixtures dominate `subprocess` and
  `orchestrator-subprocess`.
- Repeated retry and resume matrices amplify otherwise small fixture costs.
- The old `commands` and `widget` split mixed fast semantic rendering with
  slower repository/control-plane setup; the new `test/ui/` matrix separates
  semantic/component checks from real loader and PTY tiers.
- Performance benchmarks in the mock challenge are deterministic and
  serialized. No paid model, remote sync, or remote submission was used.

## Version reference and budgets

The package contract supports Pi 0.75.0 or newer; the reference dependency is
Pi 0.82.1. Scheduled compatibility CI exercises both minimum and pinned
versions.

Measured starting budgets:

| Tier | Budget |
|---|---:|
| UI semantic/component loop | under 5s |
| always-on kernel | under 5s |
| one phase contract | under 10s |
| one phase flow | under 30s where shell/Git work is required |
| selective pull request | under 3 minutes |
| full reconciliation | scheduled, release, or risk-triggered |

If a budget is exceeded, move genuinely cross-process work to its declared
tier or optimize its fixture. Do not skip a correctness assertion to meet a
timing target.
