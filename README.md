# kydoresearch

kydoresearch turns a Yukon benchmark repository into a repeatable autonomous
research program. You start it from [Pi](https://github.com/earendil-works/pi);
it proposes experiments, tries them in parallel, measures them with the
challenge's real evaluator, and submits only a verified improvement.

It is designed for challenges such as
[www.ecdsa.fail](https://www.ecdsa.fail) and
[mlx.fast](https://mlx.fast), but the harness itself is driven by the
repository's `benchmark.json`.

## What it does

- A **professor** studies prior results and proposes falsifiable experiments.
- Independent **PhD agents** implement those experiments in isolated Git
  worktrees.
- The harness—not an LLM—runs correctness checks, serializes benchmarks, and
  compares scores.
- An **advisor** reviews completed evidence and can pause the loop when a
  configured blocker fires.
- After repeated dry loops, **God** keeps its existing role: an honest,
  hopeful conversation that helps the professor recommit to a concrete
  direction.
- Every candidate remains inspectable after the run: task, parent, source,
  diff, score, logs, integrity report, agent trace, and postmortem.

This is an unattended optimization tool, not an operating-system sandbox. Real
runs can use paid models and can submit to the challenge automatically.

## Before you start

You need:

- Pi 0.75.0 or newer;
- a Git clone of a Yukon challenge with `benchmark.json`;
- the challenge's local dependencies and CLI credentials;
- model credentials for the roles you configure.

Start from a clean or intentionally understood working tree. kydoresearch
never commits automatically, but a winning candidate is copied into the main
checkout before final verification and submission.

## Quickstart: ecdsafail

Install the extension once:

```bash
pi install git:github.com/0xkydo/kydoresearch
```

Then start Pi at the root of your ecdsafail challenge checkout:

```bash
cd /path/to/ecdsafail-challenge
git status
pi
```

Before the first real run, open `/autoresearch config`, select **settings**,
and cycle `runner` from `mock` to `subprocess`. Review the role models, tool
access, command timeouts, loop limits, and submission model. Closing the panel
saves `.autoresearch/config.json`. The equivalent minimal JSON setting is:

```json
{ "runner": "subprocess" }
```

Run `/autoresearch`. Initialization runs the manifest's `setupCommand`, asks a
setup agent to identify the correctness and performance commands, and records
one baseline benchmark. Read the displayed commands before allowing the loop
to continue. ecdsafail is detected as lower-is-better.

Use `/autoresearch status` while it runs and `/autoresearch stop` to pause.
Setup and main-checkout evaluation output streams to `.autoresearch/logs/`;
candidate verification and benchmark output is attributed under
`.autoresearch/runs/<candidateId>/logs/`. Running `/autoresearch` again resumes
the saved state.

The real loop uses the challenge CLI to read and sync submissions and may
submit an improving result automatically. Review your challenge account,
models, spending limits, and local changes before leaving it unattended.

## The loop

```text
init (once per repo)
  validate manifest + git repo → dependency setup → setup agent → baseline
research loop
  sync leaderboard + competitor notes → knowledge base + experiment ledger
  materialize an immutable professor task
  checkpoint the normalized proposal set before creating candidate runs
  professor proposes typed experiments with explicit parent candidates
  PhDs implement in parallel (one parent-materialized git worktree each)
    audit changed paths before trusting evaluation
    verify fails → retry with the same requirement + latest verifier report
    verify passes → benchmark under a global lock with candidate-specific logs
  archive every terminal candidate and write a result-aware postmortem
  best meaningful improvement → apply to main → re-verify → re-bench → submit
  advisor reviews the loop; a blocker pauses it
  repeated dry loops → reflective God turn → next loop
```

State and research memory live in `.autoresearch/` inside the challenge repo.
It is hidden through `.git/info/exclude`, rejected if it falls under the
manifest's `editablePaths`, and never intentionally added to a submission.
`state.json` remains the operational resume checkpoint; `ledger.ndjson` is the
compact search index; `runs/` contains the inspectable evidence behind every
ledger entry. Pi subprocess sessions are deliberately ephemeral.

## Reading the results

You do not need to inspect Pi session history to understand a run. The useful
files are:

| Path | What it tells you |
|---|---|
| `.autoresearch/state.json` | What the loop is doing now and where resume will continue. |
| `.autoresearch/ledger.ndjson` | One compact record for every completed candidate. |
| `.autoresearch/runs/<candidateId>/proposal.json` | The observation, hypothesis, intervention, expected result, and falsifier. |
| `.autoresearch/runs/<candidateId>/source/` | The exact editable files that were evaluated. |
| `.autoresearch/runs/<candidateId>/diff.patch` | What changed relative to the declared parent candidate. |
| `.autoresearch/runs/<candidateId>/metrics.json` | Score, comparison score, commands, timing, and terminal outcome. |
| `.autoresearch/runs/<candidateId>/integrity.json` | Whether anything outside the allowed editable surface changed. |
| `.autoresearch/runs/<candidateId>/logs/` | Candidate-specific verifier and benchmark output. |
| `.autoresearch/runs/<candidateId>/postmortem.md` | What the experiment taught the research program. |
| `.autoresearch/runs/<candidateId>/agent/` | Effective soul, immutable tasks, context snapshots, and raw Pi JSONL traces. |

Successful and superseded worktrees are removed only after their evidence is
sealed. Failed worktrees remain under `.autoresearch/worktrees/` for debugging.

## Commands

| Command | Effect |
|---|---|
| `/autoresearch` or `/autoresearch run` | Initialize and start, or resume saved state. |
| `/autoresearch status` | Show phase, loop, scores, ideas, dry streak, and advisor notes immediately. |
| `/autoresearch config` | Edit runner, role souls/prompts/models, thresholds, timeouts, advisor, and submit model. |
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
      "tools": ["read", "write", "edit", "bash"]
    },
    "professor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "bash"],
      // Optional overrides:
      // "soul": ".autoresearch/agents/professor/SOUL.md",
      // "prompt": "professor.md"
    },
    "phd": {
      "model": "anthropic/claude-sonnet-5",
      "thinking": "medium",
      "tools": ["read", "write", "edit", "bash"]
    },
    "god": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "write"]
    },
    "advisor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "medium",
      "tools": ["read"]
    }
  },
  "godTriggerThreshold": 3, // consecutive dry loops; 0 disables the God turn
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
  "advisor": {
    "enabled": true,
    "watchdogFile": "WATCHDOG.md"
  },
  // Optional model name passed to CLIs that require `submit --model`:
  // "submitModelName": "my-model-label"
}
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
The defaults use explicit role-level Pi tool allowlists. Omitting `tools` in a
persisted partial role keeps that role's default allowlist; provide a different
array to customize it. An empty array passes `--no-tools`.

Each role has a bundled `extensions/autoresearch/agents/<role>/SOUL.md`.
The soul is stable role behavior and is appended to the worker's Pi system
prompt. There is intentionally **no repository-level `SOUL.md`**. A bare
`soul` filename resolves within that role's bundled directory; a path such as
`.autoresearch/agents/professor/SOUL.md` resolves from the challenge repo.

`prompt` remains the dynamic task-prompt template for compatibility. A bare
prompt filename resolves against `extensions/autoresearch/prompts/`; a path
such as `.autoresearch/prompts/custom.md` resolves from the challenge repo.
Current loop data belongs in the immutable task JSON, not in a soul.
Because ambient Pi context loading is disabled, applicable repository
instruction files are snapshotted into each candidate archive and named in
the PhD task explicitly. Postmortem invocations use a per-task read-only tool
policy; the harness writes their returned markdown.

The panel exposes professor, PhD, God, and advisor role settings. The setup role
runs only during init, so edit its JSON directly if needed. `WATCHDOG.md`
provides optional advisor rules:

```md
severity-threshold: nit
rules:
- if: dryLoopStreak >= 2
  severity: concern
  text: "Two dry loops; consider changing idea family."
```

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
`"runner": "subprocess"` starts a fresh bounded `pi --mode json --no-session`
process for each role invocation. It reuses the active Pi executable when
possible, disables ambient extensions, skills, prompt templates, and context
files, appends the effective role soul as system context, and retains the raw
JSONL event stream. Role model, thinking, prompt, soul, and tool allowlist
remain configurable.

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
  the applicable main-checkout log or
  `.autoresearch/runs/<candidateId>/logs/benchmark.log`.
- **A long command appears stuck:** `/autoresearch status` shows the current
  phase. Tail the matching main-checkout log or the candidate's file under
  `.autoresearch/runs/<candidateId>/logs/`; increase the `execution` timeout
  only after confirming the process is making progress.
- **The loop uses canned ideas:** open `/autoresearch config` and change
  `runner` from `mock` to `subprocess`.
- **A candidate is rejected before verification:** inspect its
  `integrity.json` and `diff.patch`. Worktrees isolate candidates for Git
  coordination; they are not an operating-system security sandbox.

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
component boundaries. Coding agents and contributors should also read
[`AGENTS.md`](AGENTS.md) before changing implementation contracts or lifecycle
boundaries.
