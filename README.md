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

kydoresearch turns a Yukon AutoResearch challenge repository into a durable,
repeatable multi-agent optimization loop. A professor proposes experiments,
parallel PhD agents implement them in isolated Git worktrees, and the harness
verifies, benchmarks, selects, and submits only a qualifying winner.

An opt-in meta-harness can wrap that loop and evolve the professor, PhD, and
advisor role scaffolding itself. Each harness profile is evaluated only by the
declared challenge verifier contract and is promoted only after producing a
verified objective improvement.

It is designed for challenges such as
[ECDSA.fail](https://www.ecdsa.fail) and
[MLX Fast](https://mlx.fast), but the harness itself is driven by the
repository's `benchmark.json`.

> [!WARNING]
> A real run is an unattended code-execution and submission workflow. It runs
> repository commands, starts model subprocesses that may incur charges, calls
> the challenge CLI, and can submit an improving result automatically. There is
> currently no dry-run or per-submission approval gate. Start in a clean,
> disposable clone or a contained environment with only the credentials it
> needs.

## What it does

- A **professor** searches prior evidence and proposes falsifiable experiments
  with explicit parent candidates.
- Independent **PhD agents** implement those experiments in separate,
  parent-materialized Git worktrees.
- The harness—not an LLM—audits changed paths, runs correctness checks,
  serializes benchmarks, and compares direction-aware scores.
- An **advisor** reviews completed evidence and can pause the loop when a
  configured blocker fires.
- After repeated dry loops, **God** keeps its existing role: a warm, honest,
  hopeful conversation that helps the professor recommit to a concrete
  direction.
- Every candidate remains inspectable after the run: task, parent, source,
  diff, score, logs, integrity report, agent trace, and postmortem.

The core safety invariant is that model output never goes directly from an idea
worktree to submission. A winning candidate is copied to the main checkout,
then passes correctness and performance gates again before submission.

## Why kydoresearch

- **Parallel exploration:** sibling experiments run concurrently without
  sharing source changes.
- **Measured promotion:** correctness precedes performance, benchmarks are
  globally serialized, and only a meaningful improvement can win.
- **Explicit lineage:** each candidate identifies the archived source it
  extends; Git `HEAD` is not assumed to be the current research parent.
- **Durable execution:** atomic state and explicit resume checkpoints survive
  clean stops, process interruption, and Pi restarts.
- **Filesystem memory:** an append-only ledger makes prior experiments
  searchable while sealed run directories retain the complete evidence.
- **Bounded failure:** one failed agent, verification attempt, or benchmark
  does not crash the rest of the research loop.
- **Bilevel evolution:** optional outer-loop profiles learn from the complete
  filesystem archive while a fingerprinted verifier and last-known-good
  rollback profile remain fixed.

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

### Optional: launch with an on-call supervisor

`pi-kydo` is the package's supervised executable. It starts the same
interactive Pi extension, so first-run review and `/autoresearch config` work
unchanged, while an outer process watches Pi's stderr, exit status, and the
durable `.autoresearch/` event and evaluation logs.

If your Pi package installation does not expose npm executables on `PATH`,
install or link this package's command once:

```bash
npm install -g git+https://github.com/0xkydo/kydoresearch.git
pi-kydo --help
```

Then run it from the challenge checkout instead of `pi`:

```bash
cd /path/to/challenge
pi-kydo
```

Unknown launcher options are forwarded to interactive Pi. Use `--` when the
separation should be explicit:

```bash
pi-kydo --scan-interval-ms 30000 -- --model openai-codex/gpt-5.6-sol
```

The supervisor starts fresh, sessionless Pi analyst turns only when the
durable process stream changes. That analyst has no tools and can only return
a typed diagnosis. Normal candidate failures, worse scores, dry loops,
in-budget retries, Advisor notes, and church are explicitly outside its
authority. A semantic finding requires two matching high-confidence
catastrophic assessments. Process death, an opened durable recovery circuit,
or a configured no-progress deadline is a deterministic catastrophic signal.

For a catastrophe, the supervisor seals a report, exact bounded evidence, and
agent traces under `.autoresearch/oncall/incidents/`. It then dispatches an
ephemeral Codex repair turn using `gpt-5.6-sol` with high reasoning,
`workspace-write`, and no interactive approvals. The repair prompt permits
only the smallest progress-restoring change, prohibits submission/sync and
scientific-policy changes, and includes both the challenge checkout and the
installed kydoresearch runtime when they differ. After the repair turn
finishes, Pi restarts and the extension resumes the existing durable
AutoResearch phase automatically.

This is an unattended code-editing path, not a security sandbox. Use a
disposable clone or OS-level containment, review the incident archive, and
set provider spending limits. Repeated identical incidents do not dispatch
duplicate repairs, restart delay grows exponentially, and `--max-restarts`
opens the outer crash-loop circuit. Press Ctrl-C to stop intentionally. Use
`--no-repair` to retain diagnosis and restart behavior without Codex edits.

### 2. Open a clean challenge checkout

```bash
cd /path/to/ecdsafail-challenge
git status --short
pi
```

Do not start from a checkout with valuable uncommitted edits under the
manifest's `editablePaths`; applying a winner replaces those paths on the main
checkout. kydoresearch never commits challenge changes automatically.

### 3. Configure real agents

Run `/autoresearch`. On the first interactive run, a guided profile review
opens before any challenge command executes. It explains Setup, Professor,
PhD, Advisor, and God in terms of purpose, timing, authority, model, thinking
level, and tools. Meta-harness appears only when enabled. Real ECDSA.fail and
MLX Fast checkouts default this review to the subprocess runner.

The final settings page covers the runner, loop budget, optional roles, and
submission attribution. Soul, prompt, and tool-policy fields remain editable
from the same review. The complete advanced panel is also available later:

```text
/autoresearch config
```

The first-run review ends with a visible **Continue** / **Cancel** action row.
Arrow keys select an action and Enter confirms it. Escape and Ctrl-C mean
Cancel; they never silently accept the draft. Only **Continue** advances and
persists the effective configuration. Cancelling discards the review draft.
Later `/autoresearch config` edits save only when a setting actually changes,
so closing an untouched panel does not create `.autoresearch/config.json`.
Active subprocess profiles are checked against Pi's available models and
configured files before setup starts; unavailable profiles identify the exact
role and direct the operator to `/login` or the field that needs correction.

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

After profile review, Pi previews the complete setup plan, including commands,
editable paths, score direction, retry budgets, log directory, and the fact
that dependency setup may modify the checkout. Nothing runs until that plan is
confirmed. Initialization then:

1. validates the manifest and Git worktree;
2. runs the manifest's `setupCommand`;
3. asks the setup agent to read the completed setup log, relate repository
   guidance to local hardware, and select documented effective correctness and
   benchmark commands;
4. asks Setup to make supported mode, flag, and hardware decisions itself,
   choosing either full local evaluation or an explicitly reduced local signal
   whose limitations require official validation;
5. atomically checkpoints the effective commands in
   `.autoresearch/loops/init/setup-result.json`;
6. runs one baseline with the effective benchmark command; if its first
   attempt fails, gives the completed log and score artifact back to Setup for
   one bounded baseline-review before the remaining command attempt;
7. archives an editable-source snapshot; and
8. shows a readiness report and waits for an explicit **Start Research**
   confirmation.

Choosing **Stay Ready** leaves the durable phase at `ready`. A later
`/autoresearch` starts research without repeating successful setup or baseline
work.

Initialization itself does not submit. The research loop that follows may sync
challenge data and submit an improvement automatically.

### 5. Operate and resume

The interactive layout gives every stable area a name:

```text
Agent Monitor   above the Composer; Overview or focused agent trace
Composer        Pi's normal input editor
Control Deck    below the Composer; Activity Navigator, Run Overview, Controls
```

The **Agent Monitor** is one compact frame with flat, tightly spaced rows.
Overview shows only active agent invocations: running, queued, or waiting work.
Terminal invocations disappear instead of remaining as historical rows. Focus
reuses the same frame for the selected active invocation's semantic trace
history; it does not expose raw JSON as the primary view. The **Activity
Navigator** is the selected-agent row in the Control Deck. It makes the monitor
keyboard interactive without typing another slash command.

While the editor shows `NAV`, use Up/Down to select an agent, Enter to enter
Focus, and Escape to return to Overview. In Focus, Left/Right switches between
attempts for the same candidate or role invocation, Page Up/Page Down scrolls
the trace, and Home/End jumps to the first/last trace entry. Tab enters `TYPE`
mode in the Composer. Typing a printable character also enters `TYPE` and
preserves that first character. Tab returns to `NAV` when autocomplete is not
open; Escape returns from an empty Composer. The extension restores the
previous Pi editor component when the run stops, completes, or crashes.

The persistent initialization Control Deck appears below the Composer as soon
as confirmation closes. Validation, dependency setup, Setup analysis, baseline
measurement, and archival appear as a checklist whose entries move through
pending, running, retrying, passed, or failed. It uses Pi's width-aware custom-component path rather
than the ten-line-capped plain widget path, so runtime evidence is not replaced
by a `widget truncated` marker. Its hierarchy keeps the current stage,
local-evaluation fidelity, runtime command, evidence path, actionable failure,
recent activity, and controls visible. Normal progress updates the deck without
emitting a stream of notifications. An initialization failure remains on
screen with a stable category, explanation, corrective action, evidence path,
and retry behavior. This presentation is restored from
`.autoresearch/loops/init/status.json`.

After initialization, the same compact Control Deck has three rows:

- **Activity Navigator:** selected invocation, position, stage, Overview/Focus,
  and `NAV`/`TYPE` state.
- **Run Overview:** durable stage plus lifetime sealed experiment count,
  server-confirmed harness accepts, pending and rejected reviews, submissions
  from others, and tokens spent by inner-loop agents in the current loop.
- **Controls:** the available navigation keys and stop/inspection actions.

Token totals include input, output, cache-read, and cache-write tokens. A `≥`
prefix marks incomplete provider usage rather than presenting a partial total
as exact. The deck remains visible when a run pauses or completes and is
restored from durable state after Pi restarts.

Use `/autoresearch steer <direction>` to influence the next Professor
portfolio, for example:

```text
/autoresearch steer prioritize cache locality before changing algorithms
```

The direction is stored in `.autoresearch/operator-steering.json` and captured
inside the next immutable Professor task. It never rewrites an in-flight PhD
task or grants permission to weaken evidence, verification, or path
boundaries. If the current portfolio already exists, the deck and notification
say that the direction takes effect at the next proposal. Use
`/autoresearch steer clear` to return future proposals to evidence-only
direction.

Use `/autoresearch status` for the same immediate snapshot in a notification.
Use `/autoresearch inspect` to list current and recent candidates, then
`/autoresearch inspect L003-I2` to see one candidate's observation, hypothesis,
intervention, expected result, failure, and evidence paths without leaving Pi.
`/autoresearch telemetry` shows aggregate timing. Use `/autoresearch stop` for
a durable, abort-safe pause, and run `/autoresearch` again to resume the saved
checkpoint.

Setup and main-checkout evaluation output streams to `.autoresearch/logs/`.
The Setup agent treats the latest successful block in `setup.log` as evidence;
it does not rerun setup or the benchmark while classifying the repository.
Candidate verification and benchmark output is attributed under
`.autoresearch/runs/<candidateId>/logs/`.

```bash
tail -f .autoresearch/logs/setup.log
tail -f .autoresearch/runs/L001-I1/logs/verify.log
tail -f .autoresearch/runs/L001-I1/logs/benchmark.log
```

The raw logs and archived artifacts remain authoritative; the Pi dashboard is
an operator-friendly view over that durable evidence.

## Quickstart: MLX Fast

Clone through the challenge CLI, then launch Pi from the created checkout so
the MLX Fast project hooks can register the session:

```bash
mlxfast clone ./mlxfast
cd ./mlxfast
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
```

If clone or the trace gate requests a restart, relaunch Pi from that repository
root. Inside Pi, `!mlxfast trace status` should report the registered project
session. The CLI is pinned to the launch benchmark, so do not pass a benchmark
name or ID.

The first `/autoresearch` opens the guided profile review with `runner` set to
`subprocess`. Review every active role model and thinking level, then set
`submit model` to the exact underlying model name shown publicly by MLX
Fast—for this Codex agent, `GPT 5.6 Sol`. Setup remains blocked while an active
profile is unavailable or MLX Fast attribution is empty.

## The experiment loop

```text
init (once per repository)
  validate manifest + Git → setup command → setup agent → durable setup result
  → autonomous decision fallback when needed → baseline
  → bounded Setup review on failure → baseline archive

research loop
  sync leaderboard and competitor notes
  reconcile queued submission reviews from one remote snapshot
    still validating → remain pending and continue without polling
    accepted or rejected → persist the result and feed it to this loop's Professor task
  search the knowledge base, compact experiment ledger, and selected run evidence
  materialize an immutable professor task
  checkpoint normalized proposals before candidate creation
  professor proposes typed experiments with explicit archived parents
  PhDs implement in parallel (one parent-materialized worktree each)
    audit changed paths before evaluation
    verify fails → retry the same requirement with the latest verifier report
    verify passes → benchmark under a global lock with candidate-specific logs
  archive every terminal candidate and write a result-aware postmortem
  best meaningful improvement → apply to main → re-verify → re-bench → queue submission
  advisor reviews the loop; a configured blocker pauses it
  repeated evaluated dry loops → Professor goes to church and reflects with God → next loop
```

Pi subprocess sessions are deliberately fresh and ephemeral. Durable
operational state and research memory live in `.autoresearch/`, not in child
conversation history. When meta-harness evolution is disabled, role
configuration remains fixed. When enabled, the outer controller may promote
only validated candidate-local professor, PhD, and advisor souls, prompts, and
tool policies; verifier behavior, models, budgets, schemas, God, and controller
source remain fixed.

## Optional meta-harness evolution

Set `metaHarness.enabled` to `true` to evolve the research harness around
ordinary loops. The feature is opt-in because it adds an outer model role and
therefore additional inference cost.

The meta-harness proposer reads prior harness profiles plus the complete inner
evidence archive—source, diffs, metrics, logs, postmortems, and Pi traces—from
the filesystem. It writes one versioned profile that can change professor,
PhD, and advisor souls, prompts, and tool allowlists. The controller validates
and hashes the profile, runs the configured number of ordinary research loops,
and promotes it only if the unchanged challenge verifier records real
direction-aware improvement and the inner-candidate success-rate gate passes.
On a fresh archive, `H0000` first completes one ordinary loop so `H0001` has
real failure and success evidence to inspect.

The fixed comparison substrate is fingerprinted at
`.autoresearch/metaharness/verifier.json`. Drift in the declared challenge
contract or captured model and runtime policy pauses the campaign. Repository
file contents are not part of that fingerprint, so normal challenge syncs and
kydoresearch updates do not look like metaharness mutations. Candidate
validation uses a positive allowlist: only `profile.json` and the declared
candidate-local Professor, PhD, and Advisor soul and prompt files may exist in
the mutable artifact surface; the profile schema exposes only those paths and
tool arrays.

For unattended use, the outer controller provides atomic checkpoints,
completed-loop reconciliation, bounded exponential recovery, safe rollback
before inner artifacts become immutable, a last-known-good champion, proposal
circuit breaking, a durable heartbeat, and explicit wall-time and generation
budgets. See [`docs/metaharness.md`](docs/metaharness.md) for the lifecycle,
archive, reliability behavior, limitations, and the Meta-Harness/bilevel
research references behind the design.

## Commands

| Command | Effect |
|---|---|
| `/autoresearch` | Initialize and start, or resume saved state. |
| `/autoresearch run` | Explicit form of `/autoresearch`. |
| `/autoresearch status` | Show the phase, loop, scores, ideas, dry streak, advisor notes, and open task count. |
| `/autoresearch steer <direction>` | Persist a search preference for the next immutable Professor proposal task; use `steer clear` to remove it. |
| `/autoresearch inspect [candidate]` | List candidates or inspect one candidate's hypothesis, lineage, result, and evidence paths. |
| `/autoresearch telemetry` | Aggregate local flow timings by count, total, average, maximum, and failures. |
| `/autoresearch config` | Edit runner, role models, souls, prompts, thresholds, timeouts, advisor behavior, and submission model. |
| `/autoresearch stop` | Abort active work safely and persist a resumable paused state. |

The outer `pi-kydo` executable is intentionally not another slash command. It
must own the interactive Pi process in order to restart it after a fatal exit.
Run `pi-kydo --help` for analyst model, scan/stall threshold, restart backoff,
restart circuit, executable path, and Pi passthrough options.

The extension also registers two tools for interactive and subprocess agents:

| Tool | Purpose |
|---|---|
| `taskboard` | List, add, and update shared tasks in `.autoresearch/taskboard.json`. |
| `research_notes` | List and read notes, read the knowledge base, or append knowledge. |

## Local telemetry

Completed setup, agent, challenge-command, advisor, church, and full-loop flows
append compact spans to `.autoresearch/telemetry.ndjson`. Spans contain only a
flow label, loop/idea identifiers, scope, timestamps, duration, and outcome.
They exclude prompts, model responses, source, command output, file paths,
environment values, and credentials, and kydoresearch does not upload them.

Run `/autoresearch telemetry` for aggregates. PhD work can overlap, so per-flow
totals are not additive; `loop.total` is the corresponding wall-clock time.

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
benchmark. When full correctness is unavailable on the local host, Setup may
instead select a repository-supported reduced regression signal. That choice,
its limitations, and the need for official validation are durable and visible;
it is never presented as full correctness. Every successful candidate still
passes the selected local gate and the manifest-backed score gate before the
challenge CLI performs the authoritative submission validation.

## Configuration — `.autoresearch/config.json`

These are the current defaults from `src/config.ts`. Persisted JSON may omit
fields; loading deep-merges it with these defaults.

```jsonc
{
  "version": 1,
  "runner": "mock", // "mock" for the fixture demo; "subprocess" for real Pi agents
  "roles": {
    "setup": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "medium",
      "tools": ["read", "write", "edit", "bash"]
    },
    "professor": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "bash"]
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
    },
    "metaharness": {
      "model": "anthropic/claude-fable-5",
      "thinking": "high",
      "tools": ["read", "write", "edit", "bash"]
    }
  },
  "churchTriggerThreshold": 3, // consecutive evaluated dry loops before church; 0 disables
  "maxVerifyAttempts": 3, // implementation/verification cycles after agent infrastructure retries
  "maxIdeasPerLoop": 5,
  "maxLoops": null, // null means unlimited
  "minImprovement": 0.005, // 0.5% relative improvement in the manifest direction
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
  },
  "metaHarness": {
    "enabled": false, // opt in to bilevel harness-profile evolution
    "evaluationLoops": 1,
    "maxGenerations": null,
    "maxWallTimeMs": null,
    "maxRecoveryAttempts": 5, // total fatal inner-loop attempts, including the first
    "retryBaseDelayMs": 1000,
    "retryMaxDelayMs": 60000,
    "maxConsecutiveProposalFailures": 3,
    "proposalCooldownLoops": 2,
    "minCandidateSuccessRate": 0.5,
    "maxProfileBytes": 524288
  },
  // Optional name passed to CLIs that require `submit --model`:
  // "submitModelName": "my-model-label"
}
```

Existing version-1 configs that still name the former Setup default
(`anthropic/claude-sonnet-5`) are migrated in memory to GPT-5.6 Sol. Custom
Setup model selections and the PhD model are left unchanged.

### Role settings

- `model` uses Pi's `provider/model` reference.
- `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- The defaults use explicit role-level Pi tool allowlists. Omitting `tools` in
  a persisted partial role retains that role's default allowlist. A different
  array customizes it; an empty array passes `--no-tools`.
- Each role has a bundled
  `extensions/autoresearch/agents/<role>/SOUL.md`. The soul contains stable
  identity, responsibilities, boundaries, and evidence habits. There is
  intentionally **no repository-level `SOUL.md`**.
- A bare `soul` filename resolves inside that role's bundled directory. A path
  such as `.autoresearch/agents/professor/SOUL.md` resolves from the challenge
  repository.
- `prompt` remains the dynamic task-prompt template for compatibility. A bare
  filename resolves from `extensions/autoresearch/prompts/`; a path such as
  `.autoresearch/prompts/custom.md` resolves from the challenge repository.
- Challenge-specific task suffixes may override the matching file under
  `.autoresearch/prompts/tasks/`, such as `tasks/propose.md`.
- The setup role runs during initialization and bounded baseline recovery. It
  is included in first-run profile review and remains editable later through
  `/autoresearch config`.
- The meta-harness role runs only when `metaHarness.enabled` is true. Its own
  soul, prompt, model, and thinking level stay fixed during a campaign; it
  proposes candidate-local overrides for professor, PhD, and advisor.
- Older configs using `godTriggerThreshold` load it as
  `churchTriggerThreshold`.

Current loop data belongs in a versioned immutable task JSON, not in a soul.
Because ambient Pi context loading is disabled, applicable repository
instruction files are snapshotted into the candidate archive and named in the
PhD task explicitly. Postmortem invocations use a per-task read-only tool
policy; the harness writes their returned Markdown.

### Loop and execution settings

- `maxLoops: null` is unlimited. Set a finite value before unattended use when
  you need a hard research budget.
- `minImprovement` is a relative threshold interpreted in the manifest's score
  direction.
- `maxVerifyAttempts` applies per candidate after the PhD subprocess is
  available. An exhausted provider-level PhD call fails before verification;
  deterministic verifier failures may start another implementation/verification
  cycle up to this limit.
- Execution timeouts are milliseconds. Increase them only after inspecting the
  corresponding streamed log.
- `submitModelName` is used for challenge CLIs, such as MLX Fast, that require
  `submit --model`.

### Meta-harness settings

- `evaluationLoops` pins one validated profile to that many complete ordinary
  loops before promotion or rollback.
- `maxGenerations`, `maxWallTimeMs`, and the ordinary `maxLoops` are
  independent campaign budgets. Null means unlimited.
- `maxRecoveryAttempts` is a total-attempt count including the first failed
  inner-loop execution. Together with `retryBaseDelayMs` and
  `retryMaxDelayMs`, it bounds exponential recovery from fatal failures.
- `maxConsecutiveProposalFailures` opens the proposal circuit breaker;
  `proposalCooldownLoops` controls how long the last-known-good champion runs
  before another outer proposal.
- `minCandidateSuccessRate` prevents a profile from being promoted when its
  inner candidates fail too often, even if one score improves.
- `maxProfileBytes` bounds the candidate manifest and referenced role files.

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

See [`docs/agent-profiles.md`](docs/agent-profiles.md) for the six complete
role contracts, including their authority, evidence policy, and output schemas.

## Overnight failure policy

Attempt counts include the first call. By default, model tasks get **3 total
attempts**, harness commands get **2**, and submission gets **5**. Retries use
bounded exponential backoff and honor `/autoresearch stop` immediately.

| Failure | Automatic fallback |
|---|---|
| Setup or baseline command | Setup retries once. After a first baseline failure, Setup reviews the completed benchmark log and score artifact before the remaining command attempt. The durable Setup result resumes without repeating successful setup/discovery work. |
| Professor/setup/PhD model call | Retry twice. An exhausted PhD provider call fails the candidate before deterministic verification; it is not replayed as another verifier cycle. |
| Leaderboard sync/fetch | Retry once, then continue from `.autoresearch/leaderboard.json`; research is not blocked. |
| Correctness or benchmark command | Retry once. An idea that still fails is isolated; other ideas continue. |
| Best candidate fails on main | Mark only that candidate failed and try the next qualifying candidate. If all finalists fail, restore the pre-finalization main checkout snapshot. |
| Submission | Reconcile against the remote user's submissions before each of five attempts. A successful queue response is persisted immediately and research continues without waiting for official validation. An exhausted submit remains at `loop.finalizing` for durable checkpoint recovery and is never marked submitted. |
| Remote submission review | At the start of each later loop, fetch one bounded all/mine snapshot. Still-validating submissions remain pending; accepted or rejected results are persisted, announced, written once to the knowledge base, and embedded in the next immutable Professor task. Fetch failure uses cached evidence and never blocks research. |
| Notes, Advisor, or church | Retry twice, log the failure, and continue. A failed church visit preserves the dry-loop streak so it is attempted again later. |
| Worktree cleanup | Seal and index every terminal candidate, persist cleanup intent, retry once, and try it again at the next checkpoint. |
| Unexpected loop-level failure | Resume the same saved phase with a 1–15 minute backoff. After 12 consecutive failures, pause with a visible recovery reason instead of spinning or spending indefinitely. |

A loop advances `dryLoopStreak` only when at least one candidate reached the
deterministic verifier and no candidate improved the objective. A loop where
every candidate stopped at provider, worktree, implementation, or integrity
setup remains operational evidence, but it does not manufacture a scientific
plateau or trigger church. Meta-harness evaluation windows likewise skip such
loops and retain the same pinned profile for the next evaluable loop.

Successful idea work is checkpointed throughout. An unfinished loop does not
count toward `maxLoops`, so a transient failure on the final configured loop
cannot make the harness declare completion early.

## State, memory, and recovery

All runtime data lives in `.autoresearch/` inside the challenge repository:

```text
.autoresearch/
  state.json                authoritative loop state and resume checkpoints
  config.json               runner, role, limit, timeout, and advisor settings
  journal.ndjson            append-only operational transitions
  agent-invocations.ndjson  append-only agent lifecycle, activity, and usage
  telemetry.ndjson          local-only completed flow timings and outcomes
  ledger.ndjson             compact index of completed candidate experiments
  knowledge-base.md         human-readable research navigation
  operator-steering.json    active operator direction for future Professor tasks
  leaderboard.json          last parsed submission snapshot
  taskboard.json            shared persisted task board
  loops/                    immutable loop tasks and non-candidate traces
  runs/<candidateId>/       sealed empirical evidence for each candidate
  resolved-agents/          effective role configuration snapshots
  ideas/                    compatibility idea specifications
  logs/                     setup and main-checkout evaluation output
  notes/                    advisor, God, and submission notes
  worktrees/<candidateId>/  active checkout or terminal cleanup awaiting retry
  metaharness/              outer state, verifier contract, profiles, traces,
                            evaluations, ledger, frontier, and heartbeat
```

The directory is added to `.git/info/exclude`, not `.gitignore`, and
initialization refuses to continue if `.autoresearch/` falls under an editable
path. The harness never intentionally includes it in a submission.

Candidate creation never copies `.autoresearch/`, `.git/`, `.worktrees/`, or
an untracked directory. Small non-ignored setup files and symlinks are seeded
individually under a bounded byte budget; builds, caches, weights, nested
repositories, and other recursively discovered runtime trees stay outside the
candidate checkout.

`state.json` is written atomically and is the operational resume source of
truth. `ledger.ndjson` is the professor's compact search index. `runs/`
contains the evidence behind every ledger entry. A sealed run is immutable,
and resume repairs a sealed candidate whose ledger entry was interrupted.
`agent-invocations.ndjson` gives each role attempt a stable identity and
records start, compact activity, cumulative usage, and terminal status.
Restart recovery folds duplicate-safe complete records and treats a trailing
partial append as incomplete rather than corrupting prior history. Its token
usage feeds the current-loop total in Run Overview.

The useful files in a candidate run are:

| Path | What it tells you |
|---|---|
| `task.json` | The immutable role requirement for this candidate. |
| `proposal.json` | Observation, hypothesis, intervention, expected result, falsifier, and evidence references. |
| `parent.json` | Explicit parent candidate, base revision, and archived parent source. |
| `source/` | The exact editable files that were evaluated. |
| `diff.patch` | What changed relative to the declared parent candidate. |
| `metrics.json` | Score, comparison score, commands, timing, whether deterministic evaluation started, and terminal outcome. |
| `integrity.json` | Whether anything outside the allowed editable surface changed. |
| `logs/` | Candidate-specific verifier and benchmark output. |
| `postmortem.md` | What the experiment taught the research program. |
| `agent/` | Effective soul, immutable task context, invocation metadata, and raw Pi JSONL trace. |

Every terminal worktree, including a failed candidate, is removed only after
its evidence is sealed and indexed. The durable source snapshot, diff, logs,
metrics, postmortem, and agent trace remain under `runs/<candidateId>/`.

A local checkpoint prevents ordinary resume from repeating a recorded
submission. `state.json.submissionReviews` distinguishes queued, accepted, and
rejected remote outcomes. Queueing never waits for validation; each later loop
performs one snapshot reconciliation before proposal, and terminal results are
included in Professor evidence. No local state file can make the external CLI
transactional, however: a hard kill after queue creation but before the local
result is persisted leaves a narrow duplicate-submission risk.

## Security and operational guidance

kydoresearch inherits [Pi's security
model](https://pi.dev/docs/latest/security): Pi extensions and agent tools run
with the permissions of the account that launched them. Project trust, tool
allowlists, and Git worktrees are not operating-system sandboxes.

For real or unattended runs:

1. use a disposable clone, container, VM, or other OS-level sandbox;
2. expose only the source tree and credentials the challenge requires;
3. review `benchmark.json`, setup scripts, role souls, prompts, and tool access;
4. set finite `maxLoops`, appropriate timeouts, and provider spending limits;
5. inspect the challenge account and current Git diff before and after the run;
6. use `/autoresearch stop` instead of killing Pi when possible.

The harness isolates competing candidates for Git coordination and audits
their changed paths before evaluation. It does not isolate model subprocesses
or challenge commands from the host operating system.

## Mock demo

For a hands-on tour, the repository includes three distinct deterministic
challenge examples: latency minimization, ranking-quality maximization, and
peak-memory minimization. From any kydoresearch worktree, use the interactive
launcher:

```bash
npm run mock
```

Choose one of the three examples, then run `/autoresearch` inside Pi. The
launcher creates a fresh standalone Git repository, resolves Pi from the
current worktree or main checkout when it is not globally installed, and loads
the extension from the worktree where the launcher lives. Use
`npm run mock -- latency`, `npm run mock -- ranking`, or
`npm run mock -- memory` to skip the menu.

Keep the default `"runner": "mock"`; no configured role model or remote API is
called. Setting `max loops` to `6` and `mock loop delay` to `1200` ms in the
first-run review makes the complete scripted flow easy to watch. The examples
publish each scripted role call to the Agent Monitor, including a short
synthetic semantic trace, without spawning a process or calling a model. They
still use real Git worktrees, shell commands, verification, scoring, archives,
Advisor rules, church reflection, notes, and a local mock challenge CLI.

See [`examples/mock-challenges/README.md`](examples/mock-challenges/README.md)
for the scenario matrix, Pi commands, evidence to inspect, and reset guidance.
`fixtures/mock-challenge/` remains the compact integration-test fixture.

For real research, `"runner": "subprocess"` starts a fresh bounded
`pi --mode json --no-session` worker for each role invocation. It prefers the
active Pi executable, disables ambient extensions, skills, prompt templates,
and context files, appends the effective role soul as system context, applies
the role's tool policy, and retains the raw JSONL event stream.

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
  the applicable main-checkout log or
  `.autoresearch/runs/<candidateId>/logs/benchmark.log`.
- **A long command appears stuck:** `/autoresearch status` shows the active
  phase. Tail the matching main-checkout or candidate log; increase its timeout
  only after confirming useful progress.
- **A steering direction did not change active candidates:** candidate and
  Professor tasks are immutable once materialized. The control deck shows the
  saved direction; it takes effect when the next Professor task is created.
- **The loop uses canned ideas:** open `/autoresearch config` and change
  `runner` from `mock` to `subprocess`.
- **A role subprocess fails immediately:** verify the configured
  `provider/model`, provider authentication, soul and prompt paths, and tool
  allowlist. Confirm the same model works in a normal Pi session.
- **A candidate is rejected before verification:** inspect its
  `integrity.json` and `diff.patch`. The changed-path audit found an edit
  outside the declared surface or another integrity mismatch.
- **The run is paused after a restart:** run `/autoresearch status`, inspect
  the saved state and logs, then use `/autoresearch` to resume.
- **Status says `on-call inactive`:** the extension was launched through
  ordinary `pi`. Start the challenge with `pi-kydo` when you want the optional
  outer process to diagnose catastrophic pauses and own restart behavior.
- **Meta-harness reports runtime contract drift:** restore the displayed frozen
  setting to its expected value before resuming, or intentionally initialize a
  new campaign. The startup notification includes expected and observed values.
  If drift prevents a retry, it also shows the last recorded loop failure—such
  as provider credits or authentication—so both blockers can be repaired.
- **The on-call supervisor intervened:** inspect the newest directory under
  `.autoresearch/oncall/incidents/`. `report.md` is the diagnosis,
  `evidence.log` is the bounded process window, `codex.ndjson` is the repair
  trace, and `repair.json` is the structured outcome.
- **The on-call restart circuit opened:** the configured number of
  catastrophic restarts was exhausted. Repeated identical incidents are not
  sent to Codex twice; fix the remaining external or local blocker, then start
  `pi-kydo` again.
- **Meta-harness pauses for verifier drift:** inspect
  `.autoresearch/metaharness/verifier.json` and the journal. The error and
  `metaharness.verifier-drift` event identify the changed declared-contract or
  runtime components. Repository syncs and kydoresearch source updates are not
  verifier drift. Restore the contract or runtime setting, then run
  `/autoresearch` to resume.
- **Outer proposals keep failing:** inspect the candidate's `agent/` trace and
  profile validation error. The champion continues during configured cooldown
  loops unless the inner loop itself exhausted recovery.
- **Worktree cleanup is pending:** inspect `state.json` `pendingCleanup` and the
  sealed evidence under `.autoresearch/runs/<candidateId>/`, then resume the
  harness so it can retry managed removal and Git worktree pruning.

## Development

```bash
git clone https://github.com/0xkydo/kydoresearch.git
cd kydoresearch
npm ci
npm run typecheck
npm run test:related
git diff --check
```

Use a phase capsule while iterating:

```bash
npm run test:phase -- setup
npm run test:phase -- professor:proposal
npm run test:phase -- phd
npm run test:phase -- ui
```

`npm run test:explain` prints the changed files, selected tests, reason for each
selection, skipped suites, and any conservative full-suite escalation without
running tests. `npm run test:full` is the reconciliation gate for releases,
scheduled main, and shared lifecycle/evaluator changes. The automated test
paths use deterministic mock/fake/offline boundaries; they do not invoke paid
models, real leaderboard sync, or real leaderboard submission.

Load the checkout directly while developing:

```bash
cd /path/to/challenge-repo
pi -e /path/to/kydoresearch/extensions/autoresearch/index.ts
```

See [`docs/architecture.md`](docs/architecture.md) for component boundaries,
state-machine invariants, resume semantics, and the verification strategy.
See [`docs/testing.md`](docs/testing.md) for phase IDs, segments, tiers,
selection receipts, impact-map maintenance, escalation rules, and the
human-usability protocol.
Coding agents and contributors should also read [`AGENTS.md`](AGENTS.md)
before changing implementation contracts or lifecycle boundaries.
