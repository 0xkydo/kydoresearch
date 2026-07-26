# kydoresearch

Autonomous benchmark research for [Pi](https://pi.dev).

<p align="left">
  <a href="https://pi.dev/docs/latest/packages"><img alt="Pi package" src="https://img.shields.io/badge/Pi-Package-8B5CF6?style=flat-square"></a>
  <a href="./package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/0xkydo/kydoresearch?style=flat-square&label=version&color=2563EB"></a>
  <a href="https://pi.dev/docs/latest"><img alt="Requires Pi 0.75.0 or newer" src="https://img.shields.io/badge/Pi-%E2%89%A50.75.0-06B6D4?style=flat-square"></a>
  <a href="https://github.com/0xkydo/kydoresearch"><img alt="Primary language" src="https://img.shields.io/github/languages/top/0xkydo/kydoresearch?style=flat-square&color=3178C6"></a>
  <a href="https://github.com/0xkydo/kydoresearch/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/0xkydo/kydoresearch?style=flat-square&color=22C55E"></a>
  <a href="./package.json"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22C55E?style=flat-square"></a>
</p>

kydoresearch turns a Yukon AutoResearch challenge repository into a durable
multi-agent optimization loop. A professor proposes experiments, parallel PhD
agents implement them in isolated Git worktrees, and the harness verifies,
benchmarks, selects, and submits only a qualifying winner.

It is built for challenges such as [ECDSA.fail](https://www.ecdsa.fail) and
[MLX Fast](https://mlx.fast).

> [!WARNING]
> A real run is an unattended code-execution and submission workflow. It runs
> repository commands, starts model subprocesses that may incur charges, calls
> the challenge CLI, and can submit an improving result automatically. There is
> currently no dry-run or per-submission approval gate. Start in a clean,
> disposable clone or a contained environment with only the credentials it
> needs.

## Why kydoresearch

- **Parallel exploration:** each idea gets a detached Git worktree, so agents
  can work concurrently without sharing source changes.
- **Measured promotion:** correctness checks run before benchmarks, benchmarks
  are serialized, and the winner is verified and measured again on the main
  checkout before submission.
- **Direction-aware scoring:** both minimize (`"-"`) and maximize (`"+"`)
  challenges are supported, including a configurable minimum improvement.
- **Durable execution:** atomic state and explicit resume checkpoints survive
  clean stops, process interruption, and Pi restarts without replaying completed
  work.
- **Operational visibility:** live status, an append-only journal, streamed
  command logs, research notes, and a shared task board make the loop
  inspectable.
- **Bounded failure:** one failed agent, verification attempt, or benchmark does
  not crash the rest of the research loop.

## How it works

```text
sync → professor → parallel PhDs in isolated worktrees
                           │
             verify → serialized benchmark
                           │
                        winner
                           │
              re-verify → re-bench → submit

             state + journal persist throughout
```

The core safety invariant is that model output never goes directly from an
idea worktree to submission. It must pass the local correctness and performance
gates again after the winning editable paths are copied to the main checkout.

## Quickstart: ecdsafail

### Prerequisites

- macOS or Linux with `/bin/bash` and Git
- [Pi](https://pi.dev/docs/latest) 0.75.0 or newer
- a clean, cloned Yukon challenge repository containing `benchmark.json`
- working provider credentials for every configured role model
- an authenticated challenge CLI if the run should sync or submit

Install Pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

Authenticate with Pi's `/login` command or configure the provider API keys
required by your selected models.

### 1. Install the extension

Pi packages execute with your user account's permissions. Review this
repository before installing it, then install globally:

```bash
pi install git:github.com/0xkydo/kydoresearch
pi list
```

The installation is global and only needs to be done once. To update installed
Pi packages later, run `pi update --extensions`.

### 2. Open a clean challenge checkout

```bash
cd /path/to/ecdsafail-challenge
git status --short
pi
```

Do not start from a checkout with valuable uncommitted edits under the
manifest's `editablePaths`; applying a winner replaces those paths on the main
checkout.

### 3. Configure real agents

Before the first run, open:

```text
/autoresearch config
```

Select **settings** and cycle `runner` from `mock` to `subprocess`. Review the
professor, PhD, God, and advisor models, thinking levels, prompts, loop limits,
timeouts, and submission model. Closing the panel saves
`.autoresearch/config.json`, including in a fresh repository.

The minimum equivalent JSON change is:

```json
{
  "runner": "subprocess"
}
```

The default `mock` runner exists for the bundled fixture demo. Do not use it as
a dry-run mode against a real challenge.

### 4. Start the loop

```text
/autoresearch
```

On first use, Pi displays the detected setup command, benchmark command, and
editable paths for confirmation. Initialization then:

1. validates the manifest and Git worktree;
2. runs the manifest's `setupCommand`;
3. asks the setup agent to build a knowledge base and distinguish the fastest
   correctness check from the performance benchmark;
4. runs one baseline benchmark; and
5. starts the research loop.

Initialization itself does not submit. The research loop that follows may sync
challenge data and submit an improvement automatically.

### 5. Operate and resume

Use `/autoresearch status` for an immediate snapshot and `/autoresearch stop`
for a durable, abort-safe pause. Run `/autoresearch` again to resume the saved
checkpoint.

Watch long-running commands from another terminal:

```bash
tail -f .autoresearch/logs/setup.log
tail -f .autoresearch/logs/verify.log
tail -f .autoresearch/logs/benchmark.log
```

## Commands

| Command | Effect |
|---|---|
| `/autoresearch` | Initialize and start, or resume saved state. |
| `/autoresearch run` | Explicit form of `/autoresearch`. |
| `/autoresearch status` | Show the phase, loop, scores, ideas, dry streak, advisor notes, and open task count. |
| `/autoresearch config` | Edit runner, role models, prompts, thresholds, timeouts, advisor behavior, and submission model. |
| `/autoresearch stop` | Abort active work safely and persist a resumable paused state. |

The extension also registers two tools for interactive and subprocess agents:

| Tool | Purpose |
|---|---|
| `taskboard` | List, add, and update shared tasks in `.autoresearch/taskboard.json`. |
| `research_notes` | List and read notes, read the knowledge base, or append knowledge. |

## Supported challenge contract

kydoresearch reads the Yukon v1 `benchmark.json` schema. These fields are
required:

```jsonc
{
  "name": "challenge-name",
  "setupCommand": "./setup.sh",       // shell string or argv array
  "benchmarkCommand": "./benchmark.sh",
  "scorePath": "score.json",
  "direction": "-",                   // "-" minimizes; "+" maximizes
  "editablePaths": ["src/solution"]
}
```

`preSubmitCommand` and `description` are optional. Known manifest identities
map to the `ecdsafail` and `mlxfast` CLIs; otherwise, the first executable in
the repository's `bin/` directory is used. If no CLI is detected, local
research can still run, but sync is skipped and submission is disabled.

The setup agent may select a faster correctness command than the performance
benchmark. Every successful idea still passes both the selected correctness
gate and the manifest-backed score gate before it can win.

## Configuration — `.autoresearch/config.json`

These are the current defaults from `src/config.ts`. Persisted JSON may omit
fields; loading deep-merges it with the defaults.

```jsonc
{
  "version": 1,
  "runner": "mock", // "mock" for the fixture demo; "subprocess" for real Pi agents
  "roles": {
    "setup": {
      "model": "anthropic/claude-sonnet-5",
      "thinking": "medium"
    },
    "professor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high"
      // Optional overrides:
      // "prompt": "professor.md",
      // "tools": ["read", "grep", "find"]
    },
    "phd": {
      "model": "anthropic/claude-sonnet-5",
      "thinking": "medium"
    },
    "god": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high"
    },
    "advisor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "medium"
    }
  },
  "godTriggerThreshold": 3, // consecutive dry loops; 0 disables the God turn
  "maxVerifyAttempts": 3,
  "maxIdeasPerLoop": 5,
  "maxLoops": null, // null means unlimited
  "minImprovement": 0.005, // 0.5% relative improvement in the manifest direction
  "mockLoopDelayMs": 0, // demo-only pause after each mock loop
  "execution": {
    "setupTimeoutMs": 1800000,
    "verifyTimeoutMs": 600000,
    "benchmarkTimeoutMs": 3600000
  },
  "advisor": {
    "enabled": true,
    "watchdogFile": "WATCHDOG.md"
  }
  // Optional name passed to CLIs that require `submit --model`:
  // "submitModelName": "my-model-label"
}
```

### Role settings

- `model` uses Pi's `provider/model` reference.
- `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- Omitting `tools` leaves the role's Pi tools unrestricted. An empty array
  passes `--no-tools`; a populated array is an explicit allowlist.
- A bare `prompt` filename resolves from the bundled
  `extensions/autoresearch/prompts/` directory. A path such as
  `.autoresearch/prompts/custom.md` resolves from the challenge repository.
- The setup role runs only during first-run initialization. Edit its JSON
  directly when its defaults need to change.

### Loop and execution settings

- `maxLoops: null` is unlimited. Set a finite value before unattended use when
  you need a hard research budget.
- `minImprovement` is a relative threshold interpreted in the manifest's score
  direction.
- `maxVerifyAttempts` applies per idea. Verification exhaustion fails only
  that idea.
- Execution timeouts are milliseconds. Increase them only after inspecting the
  corresponding streamed log.
- `submitModelName` is used for challenge CLIs, such as MLX Fast, that require
  `submit --model`.

### Advisor watchdog

The advisor can add notes or pause the loop with a blocker. Its optional
repository-relative `WATCHDOG.md` supports a severity threshold and simple
rules:

```md
severity-threshold: nit
rules:
- if: dryLoopStreak >= 2
  severity: concern
  text: "Two dry loops; consider changing idea family."
```

## State, recovery, and observability

All runtime data lives in `.autoresearch/` inside the challenge repository:

```text
.autoresearch/
  state.json           authoritative loop state and resume checkpoints
  config.json          runner, role, limit, timeout, and advisor settings
  journal.ndjson       append-only transitions and operational events
  knowledge-base.md    challenge context, outcomes, and strategy
  leaderboard.json     last parsed submission snapshot
  taskboard.json       shared persisted task board
  ideas/loop-NNN/      professor-authored idea specifications
  logs/                streamed setup, verification, and benchmark output
  notes/               hypothesis, advisor, God, and submission notes
  prompts/             optional challenge-specific role prompts
  worktrees/<ideaId>/  active or intentionally retained failed checkouts
```

The directory is added to `.git/info/exclude`, not `.gitignore`, and
initialization refuses to continue if `.autoresearch/` falls under an editable
path. The harness never intentionally includes it in a submission.

`state.json` is written atomically and is the resume source of truth.
`journal.ndjson` is the human-readable audit trail. Successful worktrees are
cleaned up; failed worktrees are deliberately retained for diagnosis.

A local checkpoint prevents ordinary resume from repeating a recorded
submission. No local state file can make the external CLI transactional,
however: a hard kill after remote acceptance but before the local result is
persisted leaves a narrow duplicate-submission risk.

## Security and operational guidance

kydoresearch inherits [Pi's security
model](https://pi.dev/docs/latest/security): Pi extensions and agent tools run
with the permissions of the account that launched them. Project trust is not a
sandbox.

For real or unattended runs:

1. use a disposable clone, container, VM, or other OS-level sandbox;
2. expose only the source tree and credentials the challenge requires;
3. review `benchmark.json`, setup scripts, role prompts, and model tool access;
4. set finite `maxLoops`, appropriate timeouts, and provider spending limits;
5. inspect the challenge account and current Git diff before and after the run;
6. use `/autoresearch stop` instead of killing Pi when possible.

The harness isolates competing ideas from each other. It does not isolate model
subprocesses or challenge commands from the host operating system.

## Mock demo

The repository includes deterministic agents and
`fixtures/mock-challenge/`, so the complete orchestration path can be exercised
without provider calls or a real leaderboard:

```bash
cp -R fixtures/mock-challenge /tmp/kydoresearch-mock
cd /tmp/kydoresearch-mock
git init -b main
git add -A
git -c user.name=Demo -c user.email=demo@example.com commit -m baseline
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
```

Then run `/autoresearch` inside Pi. The default `"runner": "mock"` is intended
for this fixture. The fixture still uses real Git worktrees, shell commands,
verification, scoring, notes, and a local mock challenge CLI.

## Troubleshooting

- **Pi is too old:** run `pi --version`. kydoresearch requires Pi 0.75.0 or
  newer. Run `pi update`, restart Pi, and retry `/autoresearch`.
- **`/autoresearch` is unavailable after install:** run `pi list` and confirm
  `git:github.com/0xkydo/kydoresearch` is present, then restart Pi. Re-run
  `pi install git:github.com/0xkydo/kydoresearch` if it is missing.
- **No `benchmark.json`:** Pi is not at a Yukon challenge root. `cd` into the
  cloned challenge repository and retry.
- **Not a git repository:** clone the challenge rather than copying only its
  source files. Confirm `git rev-parse --is-inside-work-tree` prints `true`.
- **Setup fails:** inspect `.autoresearch/logs/setup.log`, run the manifest's
  `setupCommand` manually, fix the dependency error, and retry.
- **Benchmark command is missing or fails:** inspect `benchmarkCommand` in
  `benchmark.json`, confirm its executable exists and is executable, then read
  `.autoresearch/logs/benchmark.log`.
- **A long command appears stuck:** `/autoresearch status` shows the active
  phase. Tail the matching file in `.autoresearch/logs/`; increase its timeout
  only after confirming useful progress.
- **The loop uses canned ideas:** open `/autoresearch config` and change
  `runner` from `mock` to `subprocess`.
- **A role subprocess fails immediately:** verify the configured
  `provider/model`, provider authentication, prompt path, and tool allowlist.
  Confirm the same model works in a normal Pi session.
- **The run is paused after a restart:** this is expected for an incomplete
  loop. Run `/autoresearch status`, inspect the state and logs, then use
  `/autoresearch` to resume.
- **Failed worktrees remain:** this is intentional. Inspect
  `.autoresearch/worktrees/<ideaId>/` and its note before removing it manually
  with normal Git worktree hygiene.

## Development

```bash
git clone https://github.com/0xkydo/kydoresearch.git
cd kydoresearch
npm ci
npm run typecheck
npm test
```

Load the checkout directly while developing:

```bash
cd /path/to/challenge-repo
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
```

See [`docs/architecture.md`](docs/architecture.md) for component boundaries,
state-machine invariants, resume semantics, and the verification strategy.
