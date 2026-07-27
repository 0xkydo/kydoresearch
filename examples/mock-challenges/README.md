# Hands-on mock challenges

These three tiny Yukon-style repositories exercise kydoresearch without a
provider, account, network call, or real leaderboard:

| Challenge | Objective | What feels different |
|---|---|---|
| `latency-lab` | Minimize request latency | Cache, batching, and prefetch tuning |
| `ranking-quality` | Maximize ranking quality | Direction-aware maximization with constrained weights |
| `memory-packer` | Minimize peak memory | Discrete layout, precision, and buffer-reuse choices |

Each challenge has its own task, correctness gate, benchmark, seeded local
leaderboard, Advisor rules, and declarative deterministic-agent playlist. The
playlist intentionally produces:

1. an invalid candidate and an isolated verifier failure;
2. a valid non-improvement;
3. a verifier retry that is repaired;
4. two improving siblings and one selected winner;
5. a local mock submission;
6. three dry loops and a church reflection; and
7. a post-reflection improvement.

The benchmark and Git worktrees are real. Only the model thinking and remote
challenge service are replaced with deterministic local scripts.

## One-command launcher

From any kydoresearch worktree, run:

```bash
npm run mock
```

The launcher presents a three-item menu, prepares only the selected challenge
in a fresh standalone repository, finds Pi from `PATH`, the current worktree,
or the main checkout, and starts Pi with that worktree's extension.

You can skip the menu:

```bash
npm run mock -- latency
npm run mock -- ranking
npm run mock -- memory
```

Each invocation creates a fresh directory under `/tmp` and prints its path.
The evidence remains there after Pi exits.

## Prepare disposable repositories

The launcher is the recommended path. To prepare all three examples without
launching Pi, use the lower-level script:

```bash
./examples/mock-challenges/prepare.sh
```

This creates three new, disposable repositories under
`/tmp/kydoresearch-mock-challenges`. Pass another empty destination if desired:

```bash
./examples/mock-challenges/prepare.sh /tmp/my-mock-challenges
```

The preparation step creates only the initial baseline commit in each newly
generated mock repository. Autoresearch itself never commits challenge
changes.

## Start Pi

Choose one prepared repository:

```bash
cd /tmp/kydoresearch-mock-challenges/latency-lab
pi -e /absolute/path/to/kydoresearch/extensions/autoresearch/index.ts
```

If kydoresearch is already installed as a Pi package, `pi` is enough.

Inside Pi, run:

```text
/autoresearch
```

Keep `runner` set to `mock`. For a flow that is easy to watch, the recommended
first-run settings are:

- `max loops`: `6`
- `mock loop delay`: `1200` ms
- `max ideas/loop`: leave at `5`
- Advisor and church: leave enabled

The first confirmation performs initialization and establishes the baseline.
Choose **Start Research** on the readiness screen to run the playlist. No
configured role model is called while the runner is `mock`. Each deterministic
Setup, Professor, PhD, Advisor, and God role call appears as its own Agent
Monitor invocation with a small synthetic trace. These are visual stand-ins
for subprocess agents; no child Pi process is spawned.

Useful commands while it runs:

```text
/autoresearch status
/autoresearch inspect
/autoresearch inspect L002-I1
/autoresearch telemetry
/autoresearch steer focus on the most promising discrete lever
/autoresearch stop
```

You can also watch the durable evidence from another terminal:

```bash
tail -f .autoresearch/journal.ndjson
tail -f .autoresearch/runs/L002-I1/logs/verify.log
tail -f .autoresearch/runs/L002-I1/logs/benchmark.log
./bin/mockchal submissions --all
```

To start fresh, prepare the examples into a new destination. The preparation
script refuses to overwrite an existing challenge directory.

## Manual challenge commands

Every prepared example supports:

```bash
./setup.sh
./verify.sh
./benchmark.sh
./bin/mockchal submissions --all
./bin/mockchal sync
```

`./bin/mockchal submit --note-file <path>` records only local JSON under
`.mockchal/`; it never contacts a service.
