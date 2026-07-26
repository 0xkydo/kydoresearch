# kydoresearch

A [Pi](https://github.com/earendil-works/pi) extension for Yukon AutoResearch
challenges such as [www.ecdsa.fail](https://www.ecdsa.fail) and
[mlx.fast](https://mlx.fast).

It runs a durable research loop: a professor proposes ideas, parallel PhD
agents implement them in isolated git worktrees, the harness serializes local
verification and benchmarking, and only the best qualifying result is applied
to the main checkout and submitted.

## Quickstart: ecdsafail

Prerequisites: Pi 0.75.0 or newer, a clean cloned challenge repository with
`benchmark.json`, and working credentials for the models you select. Installing
the extension is global; do it once:

```bash
pi install git:github.com/0xkydo/kydoresearch
```

Then start Pi at the root of your ecdsafail challenge checkout:

```bash
cd /path/to/ecdsafail-challenge
git status
pi
```

Before the first run, open `/autoresearch config`, select **settings**, and
cycle `runner` from `mock` to `subprocess`. Review the role models and command
timeouts, then close the panel; it saves `.autoresearch/config.json` even in a
fresh repo. The equivalent JSON setting is:

```json
{ "runner": "subprocess" }
```

Run `/autoresearch`. Confirm the displayed setup and benchmark commands. Init
runs the manifest's `setupCommand`, asks Setup to sort the repository's existing
dependency, correctness, and performance pieces into the harness buckets, and
records one baseline benchmark before the research loop starts. If required
work belongs elsewhere, initialization pauses with instructions for the user or
another agent. ecdsafail is detected as lower-is-better.

Use `/autoresearch status` while it runs and `/autoresearch stop` to pause.
Setup, verification, and benchmark output streams to
`.autoresearch/logs/{setup,verify,benchmark}.log`; running `/autoresearch` again
resumes the saved state.

The real loop uses the challenge CLI to read/sync submissions and can submit an
improving result automatically. It also starts paid model subprocesses. Review
your challenge account, model choices, limits, and local changes before leaving
it unattended.

## The loop

```text
init (once per repo)
  validate manifest + git repo → dependency setup → setup agent → baseline
research loop
  sync leaderboard + competitor notes → knowledge base
  professor proposes up to maxIdeasPerLoop ideas
  PhDs implement in parallel (one detached git worktree each)
    verify fails → retry up to maxVerifyAttempts, then write failure notes
    verify passes → benchmark under a global lock
  best meaningful improvement → apply to main → re-verify → re-bench → submit
  advisor reviews the loop; a blocker pauses it
  repeated dry loops → Professor goes to church and reflects with God → next loop
```

State lives in `.autoresearch/` inside the challenge repo. It is hidden through
`.git/info/exclude`, rejected if it falls under the manifest's
`editablePaths`, and never intentionally added to a submission.

## Commands

| Command | Effect |
|---|---|
| `/autoresearch` or `/autoresearch run` | Initialize and start, or resume saved state. |
| `/autoresearch status` | Show phase, loop, scores, ideas, dry streak, and advisor notes immediately. |
| `/autoresearch config` | Edit runner, roles, prompts, thresholds, timeouts, advisor, and submit model. |
| `/autoresearch stop` | Abort the active operation safely and persist a paused state. |

The extension also registers `taskboard` for shared work and `research_notes`
for `.autoresearch/` notes and knowledge-base access.

## Configuration — `.autoresearch/config.json`

These are the current defaults from `src/config.ts`. JSON files may omit fields;
loading merges them with these defaults.

```jsonc
{
  "version": 1,
  "runner": "mock", // "mock" for the fixture demo; "subprocess" for real Pi agents
  "roles": {
    "setup": {
      "model": "anthropic/claude-sonnet-5",
      "thinking": "medium",
      "tools": ["read", "bash", "write", "grep", "find", "ls"]
    },
    "professor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "grep", "find", "ls"]
      // Optional overrides:
      // "prompt": "professor.md", // stable role profile only
    },
    "phd": {
      "model": "anthropic/claude-sonnet-5",
      "thinking": "medium",
      "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
    },
    "god": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "write", "grep", "find", "ls"]
    },
    "advisor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "medium",
      "tools": []
    }
  },
  "churchTriggerThreshold": 3, // consecutive dry loops before church; 0 disables
  "maxVerifyAttempts": 3,
  "maxIdeasPerLoop": 5,
  "maxLoops": null, // null means unlimited
  "minImprovement": 0.005, // relative epsilon; applied in the manifest direction
  "mockLoopDelayMs": 0, // demo-only pause after each mock loop
  "execution": {
    "setupTimeoutMs": 1800000,
    "verifyTimeoutMs": 600000,
    "benchmarkTimeoutMs": 3600000
  },
  "resilience": {
    "agentMaxAttempts": 3, // first call + 2 retries
    "commandMaxAttempts": 2, // first call + 1 retry
    "submitMaxAttempts": 5, // first call + 4 retries, with remote reconciliation
    "maxConsecutiveLoopFailures": 12, // then pause the durable checkpoint
    "retryBaseDelayMs": 2000,
    "retryMaxDelayMs": 60000,
    "loopFailureBaseDelayMs": 60000,
    "loopFailureMaxDelayMs": 900000
  },
  "advisor": {
    "enabled": true,
    "watchdogFile": "WATCHDOG.md"
  }
  // Optional model name passed to CLIs that require `submit --model`:
  // "submitModelName": "my-model-label"
}
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
The defaults give each role a least-privilege Pi tool allowlist; an empty array
passes `--no-tools`. Each subprocess receives a stable role profile followed by
the current task prompt. A bare role `prompt` filename resolves under
`extensions/autoresearch/prompts/roles/`; a path such as
`.autoresearch/prompts/roles/custom.md` resolves from the challenge repo.
Challenge-specific task overrides use the matching filename under
`.autoresearch/prompts/tasks/`, such as `tasks/propose.md`.
Older configs using `godTriggerThreshold` are loaded as
`churchTriggerThreshold`.

The panel exposes professor, PhD, God, and advisor role settings and role
profiles. The setup role runs only during init, so edit its JSON directly if
needed. `WATCHDOG.md` provides optional advisor rules:

```md
severity-threshold: nit
rules:
- if: dryLoopStreak >= 2
  severity: concern
  text: "Two dry loops; consider changing idea family."
```

See [`docs/agent-profiles.md`](docs/agent-profiles.md) for the five complete
role contracts, including their authority, evidence policy, and output schemas.

## Overnight failure policy

Attempt counts include the first call. By default, model tasks get **3 total
attempts**, harness commands get **2**, and submission gets **5**. Retries use
bounded exponential backoff and honor `/autoresearch stop` immediately.

| Failure | Automatic fallback |
|---|---|
| Setup or baseline command | Retry once; leave initialization incomplete with actionable logs if both attempts fail. |
| Professor/setup/PhD model call | Retry twice. A PhD provider failure consumes a verify attempt only after its model retries are exhausted. |
| Leaderboard sync/fetch | Retry once, then continue from `.autoresearch/leaderboard.json`; research is not blocked. |
| Correctness or benchmark command | Retry once. An idea that still fails is isolated; other ideas continue. |
| Best candidate fails on main | Mark only that candidate failed and try the next qualifying candidate. If all finalists fail, restore the pre-finalization main checkout snapshot. |
| Submission | Reconcile against the remote user's submissions before each of five attempts. An exhausted submit remains at `loop.finalizing` for durable checkpoint recovery and is never marked submitted. |
| Notes, Advisor, or church | Retry twice, log the failure, and continue. A failed church visit preserves the dry-loop streak so it is attempted again later. |
| Worktree cleanup | Retry once, persist a cleanup queue, and try it again at the next checkpoint. |
| Unexpected loop-level failure | Resume the same saved phase with a 1–15 minute backoff. After 12 consecutive failures, pause with a visible recovery reason instead of spinning or spending indefinitely. |

Successful idea work is checkpointed throughout. An unfinished loop does not
count toward `maxLoops`, so a transient failure on the final configured loop
cannot make the harness declare completion early.

## Mock demo

The repository includes deterministic mock agents and
`fixtures/mock-challenge/`, so the complete state machine can be exercised
without model calls or a real leaderboard:

```bash
cp -R fixtures/mock-challenge /tmp/kydoresearch-mock
cd /tmp/kydoresearch-mock
git init -b main
git add -A
git -c user.name=Demo -c user.email=demo@example.com commit -m baseline
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
# In Pi: /autoresearch
```

The default `"runner": "mock"` is intended for this fixture. For real research,
`"runner": "subprocess"` starts bounded `pi --mode json` processes using each
role's model, thinking level, prompt, and tool allowlist.

## Troubleshooting

- **Pi is too old:** run `pi --version`. kydoresearch requires Pi 0.75.0 or
  newer. Run `pi update`, restart Pi, and retry `/autoresearch`.
- **No `benchmark.json`:** Pi is not at a Yukon challenge root. `cd` into the
  cloned challenge repository and retry.
- **Not a git repository:** clone the challenge rather than copying only its
  source files. Confirm `git rev-parse --is-inside-work-tree` prints `true`.
- **Setup fails:** read `.autoresearch/logs/setup.log`, run the manifest's
  `setupCommand` manually, fix the reported dependency error, and retry.
- **Benchmark command is missing or fails:** inspect `benchmarkCommand` in
  `benchmark.json`, confirm its executable exists and is executable, then read
  `.autoresearch/logs/benchmark.log`.
- **A long command appears stuck:** `/autoresearch status` shows the current
  phase. Tail the matching file in `.autoresearch/logs/`; increase the
  `execution` timeout only after confirming the process is making progress.
- **The loop uses canned ideas:** open `/autoresearch config` and change
  `runner` from `mock` to `subprocess`.

## Development

```bash
npm install
npm run typecheck
npm test
```

For local extension development:

```bash
cd /path/to/challenge-repo
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
```

See [`docs/architecture.md`](docs/architecture.md) for the state machine and
component boundaries.
