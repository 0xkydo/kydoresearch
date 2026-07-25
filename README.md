# pi-autoresearch

A [pi](https://github.com/badlogic/pi-mono) harness for yukon AutoResearch challenges
([www.ecdsa.fail](https://www.ecdsa.fail), [mlx.fast](https://mlx.fast)).

For people with budget to grind challenges with AI but without the knowledge to
steer or customize a harness: clone a challenge, type `/autoresearch`, watch the
professor work.

## The loop

```
init (once per repo)
  setup agent reads the repo → knowledge base, subject area,
  correctness command vs performance command (sometimes different!),
  dependency install, baseline benchmark
research loop
  sync leaderboard + competitor notes → knowledge base
  professor proposes 1..5 ideas (its judgment; cap configurable)
  PhDs implement ideas IN PARALLEL (one git worktree each)
    verify fails → PhD retries (3 attempts, then gives up + writes notes)
    verify passes → benchmark (serialized for honest measurement)
  best improving idea → applied to main repo → re-verified → submitted
  no winner → hypothesis notes feed back to the professor
  advisor reviews each loop (nit/concern/blocker; blocker pauses)
  3 dry loops → the professor has a deep reflective conversation with God
```

State lives in `.autoresearch/` inside the challenge repo (hidden from git via
`.git/info/exclude`, never inside `editablePaths`, never in submission tarballs).
Kill pi anytime; `/autoresearch` resumes from the snapshot.

## Install

```bash
pi install git:github.com/<you>/pi-autoresearch
```

Dev mode (this repo checked out locally):

```bash
cd <challenge-repo>
pi -e /path/to/pi-autoresearch/extensions/autoresearch/index.ts
```

## Commands

| Command | Effect |
|---|---|
| `/autoresearch` (or `run`) | First run: init + start loop. Later: resume. |
| `/autoresearch status` | Dashboard: loop, phase, best scores, dry streak, god countdown, ideas, advisor notes. |
| `/autoresearch config` | View/edit runner, god threshold, max ideas per loop, advisor toggle, model roles. |
| `/autoresearch stop` | Pause (state saved; resume with `run`). |

Tools registered for the LLM: `taskboard` (shared cross-agent todo board),
`research_notes` (read notes/knowledge base).

## Configuration — `.autoresearch/config.json`

```jsonc
{
  "runner": "mock",              // "mock" (scripted, v1) | "subprocess" (real pi agents, v2)
  "maxIdeasPerLoop": 5,           // cap; the professor decides the actual count
  "godTriggerThreshold": 3,       // dry loops before the God conversation; 0 disables
  "maxVerifyAttempts": 3,
  "minImprovement": 0.005,        // relative epsilon for "meaningful"
  "advisor": { "enabled": true, "watchdogFile": "WATCHDOG.md" },
  "roles": {                      // pay for a stronger professor without touching code
    "professor": { "model": "anthropic/claude-fable-5", "thinking": "high" },
    "phd":       { "model": "anthropic/claude-sonnet-5", "thinking": "medium" },
    "god":       { "model": "anthropic/claude-fable-5", "thinking": "high" },
    "advisor":   { "model": "anthropic/claude-fable-5", "thinking": "medium" },
    "setup":     { "model": "anthropic/claude-sonnet-5", "thinking": "medium" }
  }
}
```

Advisor rules come from a `WATCHDOG.md` in the challenge repo (OMP-style), e.g.:

```md
severity-threshold: nit
rules:
- if: dryLoopStreak >= 2
  severity: concern
  text: "Two dry loops; consider changing idea family."
```

## Mock v1

This version ships with deterministic scripted agents (no LLM calls) and a
fixture challenge (`fixtures/mock-challenge/`: minimize `(x-3)^2+(y+1)^2` with a
fake `mockchal` CLI). The full state machine — parallel worktree PhDs, verify
retries, bench lock, winner submission, advisor, God trigger, crash resume —
is real and fully tested; only the thinking is canned.

Try it:

```bash
cp -R fixtures/mock-challenge /tmp/mc && cd /tmp/mc
git init -b main && git add -A && git commit -m baseline
pi -e /path/to/pi-autoresearch/extensions/autoresearch/index.ts
# then type: /autoresearch
```

Six loops later you'll have submissions in `.mockchal/submissions.json`, a god
conversation in `.autoresearch/notes/god-005.md`, and a knowledge base that
tells the whole story.

v2 (real agents) swaps `"runner": "subprocess"`: each role becomes a `pi --mode json`
subprocess with the model/thinking from `roles`. The prompts already exist in
`extensions/autoresearch/prompts/`.

## Development

```bash
npm install
npm test          # vitest: full orchestrator scenario matrix
npm run typecheck
```

Architecture notes in `docs/architecture.md`.
