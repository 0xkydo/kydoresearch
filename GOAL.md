# GOAL — Make kydoresearch production-ready

> Follow-up: the original production-readiness checklist is complete. The
> current optional bilevel harness-evolution work is specified in
> `docs/metaharness.md`; its fixed-verifier and unattended-reliability
> contracts supersede any earlier assumption that role scaffolding is always
> static.

You are working continuously on this repo. Each session: read this file, read
`docs/architecture.md`, check off progress below, pick the highest unchecked
item, implement it with tests, verify, commit. Small commits, one concern each.

Do NOT read or execute anything under `~/.claude/`, `~/.agents/`, or
`.claude/skills/` — those are definitions for a different AI system.

## Mission

`kydoresearch` is a [pi](https://github.com/badlogic/pi-mono) extension that
runs an autonomous research loop (professor proposes ideas, PhDs implement in
parallel git worktrees, best idea is benchmarked and submitted) against yukon
AutoResearch challenges. v1 ships with deterministic mock agents and a fixture
challenge; the state machine is real and fully tested (22 vitest tests).

Make it ready for other people to install and run against real challenges.
That means: real subprocess agents (v2), robustness against a real challenge
repo, and polish on everything a stranger touches in the first 10 minutes.

## Test target: the ecdsafail challenge

A real challenge checkout lives at `~/Desktop/repos/ecdsafail-challenge`
(Rust harness, `setup.sh`, `benchmark.sh`, `benchmark.json`, `score.json`,
score = Toffoli count × peak qubit width, LOWER is better). Its shape is much
clearer than the mock fixture — use it to validate detection, init, verify,
and bench paths.

**Always work on a scratch copy, never the original:**

```bash
rm -rf /tmp/ecdsa-dev && cp -R ~/Desktop/repos/ecdsafail-challenge /tmp/ecdsa-dev
cd /tmp/ecdsa-dev && git remote remove origin 2>/dev/null; git status
```

## Hard safety rules

1. **Never submit or sync against the real leaderboard.** No `submit`, no
   `sync` network calls from dev runs. If a code path needs them, stub or
   dry-run. Add a `dryRunSubmit` config flag if useful.
2. Never modify `~/Desktop/repos/ecdsafail-challenge` itself (scratch copies only).
3. Never commit `.autoresearch/` state, worktrees, or challenge-repo files.
4. Real LLM subprocess runs cost money. Unit-test `PiSubprocessRunner` against
   a **fake `pi` shim** (a script that emits canned `--mode json` events), not
   real API calls. Leave real-model E2E to the human.
5. When you find a bug: write a failing test that reproduces it FIRST, then fix.

## Verification gate (every commit)

```bash
npm run typecheck && npm test
```

UI-affecting changes additionally get a TUI smoke test (pi drives fine in tmux):

```bash
tmux new-session -d -s pidev -x 180 -y 45 -c /tmp/ecdsa-dev \
  "pi -e $PWD/extensions/autoresearch/index.ts"
sleep 6
tmux send-keys -t pidev -l "/autoresearch status"; sleep 0.5
tmux send-keys -t pidev Enter; sleep 2
tmux capture-pane -t pidev -p | tail -20
tmux kill-session -t pidev
```

## Work items (priority order — check off as you land them)

### 1. v2: real subprocess agents
- [x] Implement `PiSubprocessRunner.run()` in `src/agents/subprocess.ts` per the
      plan in `docs/architecture.md` §v2: spawn
      `pi --mode json -p --no-session --model <model>` with `cwd = task.cwd`,
      parse the JSON event stream into `AgentResult`. Crib the parse loop from
      `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`.
      Event mapping: concatenate assistant text into `AgentResult` per the
      existing `AgentResult` type in `src/agents/types.ts` (match how
      `MockAgentRunner` fills it — mock behavior is the contract; if the
      stream's final message ends with a fenced JSON block, that is the
      structured payload). Sub-items below (prompt resolution, thinking/tools,
      timeouts/abort) may land as separate follow-up commits; run() itself
      lands first with the success + failure paths tested.
- [x] Resolve the role's prompt file: `RoleSpec.prompt` (see `src/config.ts`) —
      bare filename resolves against `extensions/autoresearch/prompts/`,
      repo-relative path against the challenge repo. Default `<role>.md`.
      This field is currently stored by the config UI but consumed by nothing.
- [x] Respect `thinking` level and `tools` allowlist from `RoleSpec`.
- [x] Timeouts + abort: honor the orchestrator's `AbortSignal`; a hung or
      crashed subprocess returns a failed `AgentResult`, never throws past the
      orchestrator (one PhD dying must not kill the loop).
- [x] Tests: fake-`pi` shim executable; cover success, malformed JSON, nonzero
      exit, timeout, abort mid-run.

### 2. Real-challenge hardening (use /tmp/ecdsa-dev)
- [x] `readManifest`/`detectCli` (`src/challenge/detect.ts`) must handle the
      ecdsafail layout. Document/fix whatever assumptions the mock fixture
      baked in (manifest fields, CLI discovery, score direction).
- [x] Score direction: ecdsafail is lower-is-better. Verify the orchestrator's
      "improvement" comparisons and `minImprovement` epsilon respect the
      challenge's direction rather than assuming one. Test both directions.
- [x] Init against the scratch copy end-to-end with the mock runner: setup.sh
      runs, baseline bench parses `score.json`, state lands in `.autoresearch/`.
- [x] Long-running bench: `benchmark.sh` on a real challenge can take minutes.
      Make exec timeouts configurable; stream/append output somewhere
      inspectable (`.autoresearch/logs/`?) instead of buffering silently.

### 3. Known bugs
- [x] `/autoresearch status` shows nothing in interactive mode:
      `extensions/autoresearch/commands.ts` sends via
      `pi.sendMessage({...}, { deliverAs: "nextTurn" })`, which only surfaces
      after the next LLM turn. Render immediately instead (notify or widget).
      Reproduce with a test or scripted TUI check first.
- [x] Mock run finishes in ~5s so the live widget is barely visible. Add a
      configurable per-loop delay for demos (`mockLoopDelayMs`?), default 0.

### 4. Stranger-proofing (the first-10-minutes experience)
- [x] `pi install git:github.com/0xkydo/kydoresearch` path: verify
      `package.json` `pi.extensions` works when installed (not just `-e` dev
      mode). Peer-dep failure modes → clear error messages.
- [x] Graceful errors when: not a git repo, no manifest, setup.sh fails,
      benchmark command missing, pi too old. Each should tell the user what to
      do next, not stack-trace.
- [x] README: quickstart against a real challenge (the ecdsafail flow), config
      reference kept in sync with `src/config.ts`, troubleshooting section.
- [x] `/autoresearch config` panel: sanity-check it against a fresh repo with
      no `.autoresearch/` yet (should it create config on save? it does — keep
      that behavior tested).

### 5. Quality passes (after 1–4)
- [x] Orchestrator failure-mode tests: subprocess runner wired in with the
      fake shim — PhD crash mid-implement, professor returns zero ideas,
      bench script exits nonzero, advisor blocker during parallel ideas.
- [x] Resume matrix: kill at every phase with runner=subprocess (shim), resume,
      assert no duplicate submissions and no orphaned worktrees.
- [x] Docs: update `docs/architecture.md` — v2 section describes what IS built,
      not what will be.

## Progress log

Append one line per session: date, what landed, what's next.

- 2026-07-25: goal file created. v1 mock loop + two-pane config UI verified in
  TUI; `RoleSpec.prompt` added but unconsumed; subprocess runner is a stub.
- 2026-07-25: core `PiSubprocessRunner.run()` landed with fake-`pi` coverage
  for success, malformed JSON, and nonzero exit; prompt resolution is next.
- 2026-07-25: subprocess roles now resolve bundled/custom prompts and render
  task context, including PhD implementation/note variants; thinking/tools is
  next.
- 2026-07-25: subprocess roles now pass configured thinking and tool allowlists
  to pi (including an explicit no-tools mode); timeout/abort handling is next.
- 2026-07-25: subprocess turns now have bounded TERM/KILL shutdown and honor
  pre/mid-run aborts; the full fake-pi matrix passes and real-challenge
  detection is next.
- 2026-07-25: real scratch detection now handles Yukon argv-array commands and
  the `ecadd-challenge-test` → `ecdsafail` identity alias while preserving
  direction `-`; direction-aware improvement tests are next.
- 2026-07-25: minimize/maximize orchestrator scenarios now prove directional
  winner selection and epsilon filtering; negative-score relative epsilon was
  fixed, and scratch init is next.
- 2026-07-25: `/tmp/ecdsa-dev` init completed with the mock runner (baseline
  2,511,992,646, phase `ready`) and an argv-manifest regression now covers the
  path; configurable streamed benchmark execution is next.
- 2026-07-25: setup/verify/benchmark deadlines are configurable and command
  output now streams into append-only `.autoresearch/logs/`; real scratch init
  and the config TUI passed, and immediate interactive status rendering is next.
- 2026-07-25: `/autoresearch status` now renders immediately through the pi UI
  instead of waiting for another LLM turn; command-level coverage and a real
  scratch TUI capture pass, and configurable mock-loop pacing is next.
- 2026-07-25: mock demos can now pause after each completed loop via
  `mockLoopDelayMs` (default 0), with abort-safe orchestration tests and TUI
  config coverage; the installed-package first-run path is next.
- 2026-07-25: the exact GitHub install and the current checkout both load
  `/autoresearch config` through isolated pi package settings without `-e` or
  peer errors; package metadata/lock regressions landed, and graceful startup
  errors are next.
- 2026-07-25: startup now gives recovery instructions for non-git directories,
  missing manifests, setup failures, missing benchmark commands, and Pi older
  than 0.75.0; installed-package TUI and 53-test gates pass, and README
  stranger-proofing is next.
- 2026-07-25: README now walks through installed-package ecdsafail setup,
  subprocess configuration, costs/submissions, logs, every persisted setting,
  mock usage, and troubleshooting; a config-derived docs contract keeps it in
  sync, and fresh-repo config behavior is next.
- 2026-07-25: `/autoresearch config` now has command-level coverage proving a
  fresh repo persists the complete defaults on close; the installed-package
  TUI and 57-test gate pass, and subprocess-backed orchestrator failure modes
  are next.
- 2026-07-25: a process-level fake Pi now drives orchestrator failures for a
  mid-implementation PhD crash, zero proposals, nonzero benchmark, and advisor
  blocker after proven parallel work; all 61 tests pass, and the subprocess
  phase-by-phase resume matrix is next.
- 2026-07-25: subprocess abort/resume now re-enters the same loop across sync,
  propose, ideas, finalize, loop-end, post-submit, and God checkpoints without
  duplicate submissions or orphaned worktrees; aborts no longer consume verify
  attempts, Git registry mutations are serialized, all 69 tests pass, and the
  architecture truth pass is next.
- 2026-07-25: architecture docs now describe the implemented subprocess
  runtime, initialization, concurrency locks, execution controls, durable
  checkpoints, persistence, and external submission boundary; documentation
  contracts and all 71 tests pass, completing every checklist item.
