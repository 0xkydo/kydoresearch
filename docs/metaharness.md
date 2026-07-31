# Meta-Harness

## Purpose

kydoresearch has an optional bilevel controller that evolves the harness around
the existing research loop. The ordinary loop still proposes and evaluates
challenge candidates. The outer loop proposes and evaluates *harness profiles*
that change how the professor, PhD, and advisor agents receive context and use
tools.

The design follows the central ideas in:

- [Autoresearch and Meta-Harness](https://aman.ai/primers/ai/autoresearch-and-metaharness/):
  propose, evaluate, archive, and select executable artifacts under a fixed
  objective;
- [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/abs/2603.28052):
  give the proposer selective filesystem access to prior source, scores, and
  raw execution traces instead of compressing all experience into a prompt;
- [Bilevel Autoresearch: Meta-Autoresearching Itself](https://arxiv.org/abs/2603.23420):
  use an outer loop to change mechanisms that shape the future search behavior
  of an inner loop, with explicit validation and rollback.

It is deliberately light. There is one fixed outer proposer, one versioned
profile format, the existing inner Orchestrator, and the existing deterministic
challenge adapter. It does not introduce a second evaluator implementation,
dynamic source injection, or an unbounded recursively self-modifying outer
loop.

## Fixed and mutable boundaries

The fixed campaign substrate is:

- challenge identity and score direction;
- local-evaluation fidelity, correctness/regression command, and benchmark
  command;
- score path and parser;
- model identity and thinking level;
- setup, verifier, benchmark, subprocess, retry, and candidate budgets;
- objective improvement and promotion thresholds.

At campaign creation, the controller writes
`.autoresearch/metaharness/verifier.json`. Its fingerprint covers the challenge
contract, model assignments, and runtime policies. Repository file contents
are deliberately excluded: a normal challenge sync or collaborator update is
not evidence that the outer proposer mutated anything. The fingerprint is
checked before and after every outer proposal and evaluation window. Actual
declared-contract or runtime drift pauses both loops; the controller never
silently creates a new comparison group.

The mutable harness profile contains only:

- professor soul, task prompt, and Pi tool allowlist;
- PhD soul, task prompt, and Pi tool allowlist; and
- advisor soul, task prompt, and Pi tool allowlist.

The profile schema is the positive mutation allowlist. Each referenced role
file must be a regular file inside that role's candidate-local artifact
directory, and every file in the artifact surface must be referenced by the
profile. Cross-role references, undeclared artifacts, absolute paths, path
escapes, unknown manifest fields, over-size profiles, and no-op profiles are
rejected before evaluation. Setup is not repeated, God's plateau-recovery role
is not evolved, and the outer proposer cannot evolve itself.

The outer proposal task narrows Pi to `read`, `write`, and `edit`; it does not
receive `bash`. The subprocess runner records every write/edit target from the
Pi event stream, and the controller rejects targets outside the assigned
profile or its three role-local artifact directories.

This boundary captures the high-leverage context construction, evidence
retrieval, instruction, output-discipline, and tool-policy parts of a harness
without allowing candidates to weaken verification or spend a different hard
budget.

## Bilevel lifecycle

```text
last-known-good harness profile
  -> on a fresh archive, run one ordinary baseline loop to create evidence
  -> snapshot parent role artifacts
  -> outer proposer inspects:
       meta ledger + prior profiles
       inner ledger + candidate archives
       raw metrics, diffs, logs, postmortems, and Pi traces
  -> write one candidate-local profile
  -> validate schema, paths, size, and non-no-op behavior
  -> verify frozen evaluator fingerprint
  -> activate profile through the AgentRunner port
  -> run N scientifically evaluable ordinary inner research loops
       candidates still pass integrity -> verify -> benchmark -> main recheck
  -> verify frozen evaluator fingerprint again
  -> compute objective gain and inner-candidate success rate
  -> promote only after verified objective gain and reliability threshold
  -> otherwise roll back to the last-known-good profile
  -> append outer ledger and recompute the quality/reliability/time frontier
```

An outer candidate receives the objective change produced during its evaluation
window. The direction comes from `benchmark.json`. A profile cannot be promoted
on prose, self-critique, or an advisor judgment. It must produce an ordinary
challenge candidate that the unchanged verifier accepts and that improves the
unchanged score.

The controller also maintains a Pareto view over objective gain, candidate
success rate, and wall time. The single champion controls the next loop, while
the full frontier and every rejected profile remain available to future
proposals for comparison, ablation, or transplant.

## Persistence

```text
.autoresearch/metaharness/
  state.json                 atomic outer checkpoint and resume source
  verifier.json              immutable campaign comparison contract
  ledger.ndjson              append-only terminal profile evaluations
  frontier.json              derived Pareto view
  journal.ndjson             outer transitions and incidents
  heartbeat.json             most recent durable activity
  generations/
    generation-0001/
      task.json              immutable outer proposal task
  candidates/
    H0000/
      profile.json           snapshotted last-known-good baseline
      artifact/              professor/PhD/advisor souls and prompts
    H0001/
      profile.json
      artifact/
      agent/                 outer proposer soul, context, invocation, events
      evaluation.json        objective, reliability, time, verifier fingerprint
```

`H0000` is always available as the initial rollback profile. Candidate artifacts
become immutable when their behavior hash is accepted for evaluation.
Activation re-hashes the profile so an altered artifact cannot silently resume
under an old evaluation identity. Ledger insertion is idempotent.

When the inner history is empty, the controller runs `H0000` for one complete
ordinary loop before asking for `H0001`. This prevents the first outer proposal
from hallucinating a diagnosis without any inner run evidence.

The inner evidence remains in the existing `.autoresearch/runs/` archive. The
outer proposer receives paths to both archives and is expected to use the
compact ledgers only for navigation. Raw evidence remains the authority.

## Reliability for unattended runs

The controller is designed to run between supervision points for hours:

- every outer phase and active evaluation window is atomically checkpointed;
- completed inner loops are reconciled from durable loop history after a hard
  interruption, so an evaluation is not double-counted;
- all subprocess, correctness, and benchmark deadlines remain enforced by the
  existing inner loop;
- fatal inner-loop failures use bounded exponential retry;
- the configured recovery count includes the first failed inner-loop
  execution and fail-stops exactly at that total;
- operational-only loops where no candidate reaches deterministic evaluation
  are archived but do not consume a profile evaluation slot;
- after repeated failures, a not-yet-materialized bad profile can be rolled
  back safely; once immutable professor output or candidates exist, the system
  fail-stops instead of mixing profiles inside one experiment;
- repeated outer-proposer failures open a circuit breaker and run the champion
  profile for cooldown loops, allowing useful inner research to continue;
- campaign wall time, generation count, inner loop count, and evaluation-window
  size are explicit budgets;
- evaluator drift immediately pauses the campaign;
- rejected, failed, partial, and successful profiles remain inspectable.

No local workflow can make a remote submission transactional across a machine
power loss. The existing persisted submission marker still prevents ordinary
replay after the adapter result is stored.

## Configuration

The feature is opt-in to avoid surprising existing installations with another
model role and more inference:

```jsonc
{
  "metaHarness": {
    "enabled": true,
    "evaluationLoops": 1,
    "maxGenerations": null,
    "maxWallTimeMs": 21600000,
    "maxRecoveryAttempts": 5,
    "retryBaseDelayMs": 1000,
    "retryMaxDelayMs": 60000,
    "maxConsecutiveProposalFailures": 3,
    "proposalCooldownLoops": 2,
    "minCandidateSuccessRate": 0.5,
    "maxProfileBytes": 524288
  }
}
```

For a six-hour unattended campaign, use a finite `maxWallTimeMs`, finite
provider spending limits, per-operation timeouts appropriate to the challenge,
and either a finite `maxLoops` or `maxGenerations`. `evaluationLoops: 1` gives
fast feedback; larger windows reduce noise at greater cost.

## Current limitations

- A profile is judged from sequential objective gain, not a randomized A/B
  replay from an identical challenge state. This is practical for a live Yukon
  campaign but noisier than a dedicated held-out harness benchmark.
- The current Pareto view records wall time and candidate failures; it does not
  yet aggregate every inner Pi token and tool call into the outer ledger.
- Only role instructions, prompts, and tool policies evolve. Arbitrary
  controller source injection is excluded because import-only validation was a
  documented silent-fallback and dependency risk in bilevel autoresearch.
- The outer proposer does not evolve itself. Recursive self-application would
  need a separate fixed evaluation protocol, versioning, confirmation budget,
  and rollback evidence.
