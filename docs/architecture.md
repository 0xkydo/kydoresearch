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
  prompts/*.md          bundled setup/professor/PhD/God/advisor prompts
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
5. Run the setup agent to write the knowledge base and distinguish a fast
   correctness command from the performance benchmark.
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

1. Selects the role's model, thinking level, optional tool allowlist, and
   prompt from `roles`.
2. Resolves a bare prompt filename from the bundled prompt directory or a
   repo-relative path from the challenge root, then renders task fields.
3. Starts `pi --mode json -p --no-session --model <model>`. Optional settings
   add `--thinking <level>`, `--tools <comma-list>`, or `--no-tools`.
4. Parses `message_end` JSON events, concatenates assistant text and usage, and
   parses a trailing fenced JSON object into `AgentResult.structured`.
5. Converts malformed events, spawn errors, nonzero exits, provider errors,
   and missing prompts into failed `AgentResult` values rather than throwing
   through the orchestrator.

Each turn has a 30-minute default wall-time bound. Abort or timeout sends
`SIGTERM` to the process group, then `SIGKILL` after a grace period if needed.
The PhD task runs with `cwd` set to its idea worktree; planning, notes, advisor,
and God tasks run at the main challenge root.

## Loop state machine

```text
ready
  → loop.syncing
  → loop.proposing
  → loop.ideas
  → loop.finalizing
  → loop.end
  → god? → next loop | paused | done
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

## Durable pause and resume

`state.json` is an atomic authoritative snapshot; `journal.ndjson` is an
append-only human-readable transition log. A loop is incomplete when its loop
number is ahead of `history.length`.

When pausing, `resumePhase` records the active phase before top-level `phase`
becomes `paused`. Resume uses it to retry sync/proposal, continue idea work,
finish finalization, or complete loop-end bookkeeping without incrementing the
loop number. Older v1 snapshots without `resumePhase` infer a safe checkpoint
from their idea statuses.

`pendingSummary` checkpoints advisor results and dry-streak bookkeeping before
a God turn or final history commit. This prevents an interrupted God turn from
double-counting a dry loop. Aborted model, verify, and benchmark operations are
not charged as failed verify attempts.

A `done-improved` terminal idea with its `submitted` record is the local
idempotency marker. Resume skips finalization for terminal ideas, so a pause
immediately after a successful submission does not submit twice. Successful
worktrees are pruned before the completed loop snapshot clears the idea IDs;
if cleanup is interrupted, the pending loop remains resumable and cleanup is
retried. Failed worktrees are intentional, not orphans.

The external challenge CLI does not expose a submission idempotency key. The
harness prevents replay after the adapter result is persisted, but a hard
process kill in the narrow interval after remote acceptance and before local
persistence cannot be made transactional by the local state file alone.

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
  state.json           authoritative LoopState, including resume checkpoints
  config.json          runner, roles, thresholds, execution, advisor settings
  journal.ndjson       append-only phases, idea events, and operational logs
  knowledge-base.md    subject context, leaderboard digest, outcomes, advice
  leaderboard.json     last parsed submission snapshot
  taskboard.json       shared atomic task board
  ideas/loop-NNN/      professor-authored idea specs
  logs/                setup, verify, and benchmark output
  notes/               hypothesis, advisor, God, and submission notes
  prompts/             optional challenge-specific role prompts
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
legacy snapshots, God interruption, duplicate-submission prevention, and
worktree cleanup.
