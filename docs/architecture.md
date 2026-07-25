# Architecture

## Layering

```
extensions/autoresearch/   pi shell: /autoresearch command, taskboard + notes tools, widget
        │  (thin; all pi imports live here)
        ▼
src/                       pi-independent core, tested directly by vitest
  orchestrator.ts          state machine + loop runner
  agents/                  AgentRunner port: MockAgentRunner (v1) | PiSubprocessRunner (v2 stub)
  challenge/               ChallengeAdapter port: YukonCliAdapter (real; drives mockchal or real CLIs)
  worktree.ts              per-idea git worktrees + winner apply
  init.ts                  first-run: scaffold, guard, setup, explore, baseline
  advisor.ts               WATCHDOG.md rules → nit/concern/blocker
  taskboard.ts             shared cross-agent todo board
  state.ts / config.ts     persistence (atomic snapshot + ndjson journal)
```

The orchestrator receives everything as injected ports (`AgentRunner`,
`ChallengeAdapter`, `ExecPort`, `emit`). Swapping mock → real agents is a
constructor argument, not a rewrite.

## State machine

Top-level `phase` plus per-idea `status` fully determine resume behavior.

```
uninitialized → init.setup → init.knowledge → ready
ready → loop.syncing → loop.proposing → loop.ideas → loop.finalizing → loop.end
loop.end → (god →)? loop.syncing | done | paused
```

Idea pipeline (parallel, one per idea, own worktree):

```
proposed → implementing → verifying ─pass→ benching
                ▲              │fail
                └── attempt<3 ─┘  attempt==3 → failed
benching → (finalize) done-improved | done-superseded | done-no-improvement
```

Key invariants:
- **Bench lock**: benchmarks run one at a time even with 5 parallel ideas
  (honest scores; real challenges have thermal gates and 18 GB models).
- **Winner re-measured on main**: the best improving idea's editablePaths are
  copied to the main repo and re-verified + re-benched there before submit
  (guards against worktree-only artifacts).
- **Baseline at init**: init runs one benchmark so loop 1 has a real
  `bestScore` to beat; otherwise the first valid idea would always "improve".
- **Every transition persists**: journal line + atomic state.json write. Crash
  loses at most one transition; resume re-enters the recorded phase (verify and
  bench are idempotent; submission happens once in `loop.finalizing`).

## Persistence layout (in the TARGET challenge repo)

```
.autoresearch/
  state.json         authoritative snapshot
  config.json        user-editable (runner, roles, thresholds)
  journal.ndjson     append-only audit
  knowledge-base.md  professor context: subject area, loop log, leaderboard digests, advisor notes
  ideas/loop-NNN/idea-N.md
  logs/              append-only setup/verify/benchmark command output
  notes/             PhD hypotheses, god-NNN.md, advisor-NNN.md, submission notes
  taskboard.json     shared todo board
  leaderboard.json   last sync snapshot
  worktrees/<ideaId>/  in-flight PhD checkouts (failed ones kept for debugging)
```

Hidden from git via `.git/info/exclude` (local-only; `.gitignore` might be
outside editablePaths and dirtying it could break submission tarballs).

## v2: real agents

`PiSubprocessRunner.run(task)` will:
1. Pick `roles[task.role]` from config (model + thinking + tool allowlist).
2. Render `extensions/autoresearch/prompts/<role>.md` with `task.input`.
3. Spawn `pi --mode json -p --no-session --model <model> "<prompt>"` with
   `cwd = task.cwd` (the idea worktree for PhDs).
4. Parse the JSON event stream (crib `runSingleAgent` from pi's bundled
   subagent example) into `AgentResult` (final text + trailing JSON block).

Nothing else changes: the orchestrator, adapter, worktrees, advisor, and state
formats are already agent-agnostic. Real challenges also need no adapter work —
`YukonCliAdapter` already speaks the ecdsafail/mlxfast CLI surface
(`submit --note-file [--model]`, `submissions --all`, `sync`).
