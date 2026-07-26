# Architecture

## System boundary

kydoresearch is a Pi extension wrapped around a Pi-independent orchestration
core. The extension owns commands, tools, notifications, the config panel, and
the live widget. The core receives explicit ports, so tests can replace model
processes and challenge commands without changing the state machine.

```text
extensions/autoresearch/
  index.ts              extension entry point and session-start restoration
  commands.ts           /autoresearch run|status|config|stop
  config-ui.ts          two-pane role and harness configuration
  notes-tool.ts         knowledge-base and note access
  taskboard-tool.ts     shared persisted task board
  widget.ts             compact loop status
  prompts/
    roles/*.md          stable identity, beliefs, style, and boundaries
    tasks/*.md          per-invocation context, procedure, and output contract
          │
          ▼
src/
  orchestrator.ts       durable loop state machine
  agents/
    mock.ts             deterministic fixture runner
    subprocess.ts       real PiSubprocessRunner
  challenge/
    detect.ts           Yukon manifest and CLI detection
    adapter.ts          setup/verify/bench/submit/sync command boundary
  init.ts               first-run validation, setup, exploration, baseline
  worktree.ts           isolated idea checkouts and winner application
  advisor.ts            WATCHDOG.md parsing and severity filtering
  state.ts              atomic loop snapshot schema
  config.ts             defaults and forward-compatible config merge
  taskboard.ts          atomic shared task persistence
  exec.ts               bounded, streaming process port
```

`Orchestrator` depends on `AgentRunner`, `ChallengeAdapter`, `ExecPort`, and an
event callback. Switching from `MockAgentRunner` to `PiSubprocessRunner` is a
configuration choice, not a separate orchestration implementation.

The role/task split, authority boundaries, and default tool envelopes are
defined in [`agent-profiles.md`](agent-profiles.md).

## First-run initialization

`initChallenge` performs these operations in order:

1. Read `benchmark.json`. Yukon command fields may be shell strings or argv
   arrays; argv values are serialized with POSIX-safe quoting.
2. Confirm the working directory is a git worktree and reject
   `.autoresearch/` when it falls under the manifest's `editablePaths`.
3. Create the state, log, note, idea, and worktree directories. Add
   `.autoresearch/` to `.git/info/exclude` without changing `.gitignore`.
4. Run `setupCommand` with `setupTimeoutMs`, streaming output to
   `.autoresearch/logs/setup.log`.
5. Run Setup to classify existing dependency, correctness, benchmark, path,
   and score inputs and confirm dependency readiness. If outside work is
   required, pause initialization with a structured user-action request.
6. Run one baseline benchmark with `benchmarkTimeoutMs`, parse `scorePath`, and
   persist phase `ready` with the manifest's `+` or `-` score direction.

Known CLI identity aliases map ecdsafail/ecadd manifests to `ecdsafail` and
MLX Fast manifests to `mlxfast`; an executable under `bin/` is the fallback.
Initialization itself never submits.

## Agent runtimes

`runner: "mock"` uses deterministic agents for the bundled fixture. The agents
make real worktree edits, while the normal verify, benchmark, state, advisor,
and mock challenge CLI paths remain active.

`runner: "subprocess"` uses the implemented `PiSubprocessRunner`. For every
task it:

1. Selects the role's model, thinking level, optional tool allowlist, and stable
   role profile from `roles`.
2. Resolves the role under bundled `prompts/roles/` or from a repo-relative
   path. It then selects the current task from `prompts/tasks/`, preferring a
   same-named challenge override under `.autoresearch/prompts/tasks/`.
3. Appends the task prompt to the role profile and renders invocation fields.
4. Starts `pi --mode json -p --no-session --model <model>`. Optional settings
   add `--thinking <level>`, `--tools <comma-list>`, or `--no-tools`.
5. Parses `message_end` JSON events, concatenates assistant text and usage, and
   parses a trailing fenced JSON object into `AgentResult.structured`.
6. Converts malformed events, spawn errors, nonzero exits, provider errors,
   and missing prompts into failed `AgentResult` values rather than throwing
   through the orchestrator.

Each turn has a 30-minute default wall-time bound. Abort or timeout sends
`SIGTERM` to the process group, then `SIGKILL` after a grace period if needed.
The PhD implementation task runs with `cwd` set to its idea worktree; planning,
notes, Advisor, and church tasks run at the main challenge root.

## Loop state machine

```text
ready
  → loop.syncing
  → loop.proposing
  → loop.ideas
  → loop.finalizing
  → loop.end
  → church? → next loop | paused | done
```

Each idea progresses independently:

```text
proposed → implementing → verifying ─pass→ benching
                ▲              │
                └── retry ─fail┘

implement/verify exhaustion → failed
benching + finalize → done-improved | done-superseded | done-no-improvement
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

## Durable pause and resume

`state.json` is an atomic authoritative snapshot; `journal.ndjson` is an
append-only human-readable transition log. A loop is incomplete when its loop
number is ahead of `history.length`.

When pausing, `resumePhase` records the active phase before top-level `phase`
becomes `paused`. Resume uses it to retry sync/proposal, continue idea work,
finish finalization, or complete loop-end bookkeeping without incrementing the
loop number. Older v1 snapshots without `resumePhase` infer a safe checkpoint
from their idea statuses.

`pendingSummary` checkpoints Advisor results and dry-streak bookkeeping before
church or final history commit. This prevents an interrupted church visit from
double-counting a dry loop. Legacy snapshots whose saved phase is `god` resume
at church. Aborted model, verify, and benchmark operations are not charged as
failed verify attempts.

A `done-improved` terminal idea with its `submitted` record is the local
idempotency marker. Resume skips finalization for terminal ideas, so a pause
immediately after a successful submission does not submit twice. Successful
worktrees are pruned before the completed loop snapshot clears the idea IDs;
if cleanup is interrupted, the pending loop remains resumable and cleanup is
retried. Failed worktrees are intentional, not orphans.

The external challenge CLI does not expose a submission idempotency key. The
harness prevents replay after the adapter result is persisted and reconciles a
matching score before retrying after an ambiguous failure. A hard process kill
in the narrow interval after remote acceptance and before local persistence is
therefore normally recovered by the remote score check, though score matching
is not as strong as a server-issued idempotency key.

## Challenge command boundary

`YukonCliAdapter` is the only layer that invokes challenge commands:

- dependency setup from `setupCommand`;
- correctness from the detected or setup-agent-selected verify command;
- performance from the selected benchmark command and `scorePath`;
- `submit --note-file [--model]`;
- `submissions --all`;
- `sync`.

The execution config exposes `setupTimeoutMs`, `verifyTimeoutMs`, and
`benchmarkTimeoutMs`. Output is streamed while commands run and appended to
`.autoresearch/logs/{setup,verify,benchmark}.log`. Before each benchmark, a
stale score file is removed; success requires a newly written finite numeric
score.

## Persistence layout

```text
.autoresearch/
  state.json           authoritative LoopState, recovery, and cleanup checkpoints
  config.json          runner, roles, thresholds, execution, resilience, advisor
  journal.ndjson       append-only phases, idea events, and operational logs
  knowledge-base.md    subject context, leaderboard digest, outcomes, advice
  leaderboard.json     last parsed submission snapshot
  taskboard.json       shared atomic task board
  ideas/loop-NNN/      professor-authored idea specs
  logs/                setup, verify, and benchmark output
  notes/               hypothesis, Advisor, church, and submission notes
  prompts/
    roles/              optional challenge-specific role profiles
    tasks/              optional same-named task overrides
  main-snapshots/       temporary rollback copy of editable paths during finalization
  worktrees/<ideaId>/  active or intentionally retained failed checkouts
```

Config loading deep-merges persisted partial objects with `DEFAULT_CONFIG`, so
new fields receive defaults. The interactive config command also works before
initialization: closing it creates `.autoresearch/config.json` in a fresh
directory.

## Verification strategy

The mock challenge exercises real git worktrees, shell commands, scores, and
submission records. A process-level fake `pi` executable exercises
`PiSubprocessRunner` JSON parsing and orchestration without model calls. The
matrix covers role failures, parallel agents, nonzero benchmarks, blockers,
every active loop phase, a live mid-implementation kill, post-submit resume,
legacy snapshots, church interruption, duplicate-submission prevention, and
worktree cleanup.
