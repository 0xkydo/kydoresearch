# Autoresearch Agent Monitor UI Plan

**Status:** Implemented

**Last updated:** 2026-07-26

**Goal:** Make `/autoresearch` easy to understand and navigate while agents are
working, without requiring typed inspection commands.

## Product Decisions

- Replace the current below-composer activity and candidate sections with one
  live `Agent Monitor` above the composer.
- The Agent Monitor is one component with two views:
  - `Overview` shows all agent invocations and their current activity.
  - `Focus` shows the selected invocation's rendered trace and history.
- Keep the persistent `Control Deck` below the composer, but make it compact.
  Its `Activity Navigator` controls selection in the Agent Monitor.
- `Up`/`Down`, `Enter`, and `Escape` are the primary select, enter, and exit
  controls. No `/autoresearch inspect ...` command is required for navigation.
- Use one shared frame and flat rows rather than a separate box around every
  agent.
- Do not include mouse interaction in the first implementation. Preserve a
  state model that can accept row-click events later if Pi exposes reliable
  mouse coordinates.
- Replace the implicit Escape-to-finish onboarding behavior with visible
  `Continue` and `Cancel` actions. Escape cancels; it never means continue.

## OMP Reference and Adaptation

This design borrows the structure of OMP's Agent Hub at version `17.1.3`:

- [Agent Hub source](https://github.com/can1357/oh-my-pi/blob/v17.1.3/packages/coding-agent/src/modes/components/agent-hub.ts)
- [Agent transcript viewer source](https://github.com/can1357/oh-my-pi/blob/v17.1.3/packages/coding-agent/src/modes/components/agent-transcript-viewer.ts)

Patterns to retain:

1. One component owns both the list and transcript views.
2. Selection is stored by stable agent/invocation ID, not row number.
3. Row order remains stable while the operator is navigating, so live updates
   do not move the selected target.
4. The selected row stays in a height-bounded window when there are more
   agents than can fit.
5. Trace files are tailed incrementally; partial JSONL lines are held until
   complete, and truncation or replacement triggers a safe full reload.
6. Raw trace events are converted into normal assistant/tool renderings rather
   than displayed as JSON.
7. Focus follows the newest event until the operator scrolls upward. Reaching
   the bottom restores follow mode.

Kydoresearch adaptations:

- Keep the monitor persistent above the composer instead of opening a
  full-screen overlay.
- Use a single compact row per agent in Overview.
- Put the title inside the top border instead of spending separate lines on a
  border, title, and second border.
- Use one column of interior horizontal padding, no blank row between agents,
  and no blank row before key hints.
- Keep agent navigation in the below-composer Control Deck because ordinary Pi
  widgets do not receive keyboard focus.
- Do not import or depend on OMP. Reimplement the behavior against the current
  Pi extension and trace contracts.

## Shared Vocabulary

These names are the product vocabulary for future discussion:

| Position | Name | Purpose |
| --- | --- | --- |
| Above the input | **Monitor Zone** | Persistent area that shows live agent work. |
| Main component in the Monitor Zone | **Agent Monitor** | One component that switches between Overview and Focus. |
| Agent Monitor list view | **Overview** | Compact roster of all current and recent agent invocations. |
| One Overview line | **Agent Row** | Role, invocation, state, progress, and current activity. |
| Agent Monitor detail view | **Focus** | The selected agent invocation's rendered trace. |
| Focus event stream | **Agent Trace** | Semantic assistant, reasoning, and tool events plus history. |
| Pi's normal input | **Composer** | The operator's ordinary text entry area. |
| Below the input | **Control Zone** | Persistent interactive research controls and summary. |
| Main component in the Control Zone | **Control Deck** | Compact wrapper around navigation, run summary, and keys. |
| First Control Deck row | **Activity Navigator** | Selects which Agent Row is active and opens Focus. |
| Second Control Deck row | **Run Overview** | Stage, experiment, remote, competitor, and token counters. |
| Last Control Deck row | **Controls** | Context-sensitive keyboard hints and pause/resume actions. |
| First-run profile screen | **Profile Review** | Reviews active agent profiles before setup. |
| Profile Review footer | **Onboarding Actions** | Visible Continue and Cancel buttons. |

`Agent Activity Rail` is retired as a product term because it ambiguously
referred to both the list and trace. The visible list is Overview; the
single-line controller below the composer is the Activity Navigator.

## Density Rules

The UI should feel tighter than OMP while remaining readable:

- Outer horizontal margin: `0`.
- Frame inset: `1` column on each side.
- Inter-column gap inside a row: `2` columns.
- Vertical gap between Agent Rows: `0`.
- Overview row height: `1` line. Truncate current activity before adding a
  second line.
- Focus header height: `1` line inside the top frame label.
- Focus footer: at most `2` lines, including stats and key hints.
- Control Deck: `3` interior lines at normal widths; `4` only when a narrow
  terminal forces Controls to wrap.
- Never nest a border around an individual Agent Row or Control Deck section.
- Use color, a cursor glyph, and short uppercase labels to establish hierarchy.
- At narrow widths, remove optional metadata in this order: elapsed age,
  attempt fraction, candidate title, role label. Never remove agent ID, state,
  or the selection cursor.

## Text Mockups

### Overview

The Agent Monitor is above the Composer. The selected row in Overview and the
Activity Navigator below refer to the same invocation ID.

```text
╭─ Agent Monitor · Overview · 2 running · 1 waiting ─────────────────────────╮
│ ▸ ● PhD L004-I1       verifying 2/3   running npm test                     │
│   ● PhD L004-I2       implementing    editing src/cache.ts                 │
│   ◌ Professor L004    complete        proposed 3 experiments               │
│   ◌ Advisor L003      waiting         watching sealed loop evidence        │
╰────────────────────────────────────────────────────────────────────────────╯

> Ask or steer the research loop…

╭─ Control Deck · LIVE · Loop 4 · Verify ────────────────────────────────────╮
│ AGENT  1/4  ▸ PhD L004-I1 · verifying 2/3                                 │
│ RUN    Experiments 17 · Remote accepted 3 · Others 48 · Loop tokens 198k  │
│ KEYS   ↑↓ select · Enter focus · Tab composer · /autoresearch stop        │
╰────────────────────────────────────────────────────────────────────────────╯
```

### Focus

Entering Focus changes the contents of the same Agent Monitor frame. It does
not open another nested box and does not hide the Composer or Control Deck.

```text
╭─ Agent Monitor · Focus · PhD L004-I1 · verifying 2/3 · LIVE ──────────────╮
│ 14:31:08  Read      src/cache.ts                                           │
│ 14:31:19  Thought   The cache key omits the device capability…             │
│ 14:31:42  Edit      src/cache.ts · 8 lines changed                          │
│ 14:32:03  Bash      npm test -- --run test/cache.test.ts                    │
│ 14:32:11  Result    18 passed · 1 failed                                    │
│ 14:32:18  Thought   The legacy fallback needs the same key component…       │
├─ attempt 2/3 · 67k tokens · 3m12s · following latest ──────────────────────┤
│ PgUp/PgDn scroll · ←→ invocation · Esc overview                            │
╰────────────────────────────────────────────────────────────────────────────╯

> Ask or steer the research loop…

╭─ Control Deck · LIVE · Loop 4 · Verify ────────────────────────────────────╮
│ AGENT  1/4  ▸ PhD L004-I1 · FOCUS                                         │
│ RUN    Experiments 17 · Remote accepted 3 · Others 48 · Loop tokens 198k  │
│ KEYS   ↑↓ agent · ←→ invocation · Esc overview · Tab composer             │
╰────────────────────────────────────────────────────────────────────────────╯
```

### Overflow

Keep the selected row visible and summarize omitted rows without changing the
frozen order.

```text
╭─ Agent Monitor · Overview · 9 agents ──────────────────────────────────────╮
│ … 3 earlier                                                               │
│   ◌ PhD L004-I1       complete        archived no-improvement              │
│ ▸ ● PhD L004-I2       benchmarking    waiting for benchmark lock           │
│   ● PhD L004-I3       implementing    running focused tests                │
│ … 3 later                                                                 │
╰────────────────────────────────────────────────────────────────────────────╯
```

### Profile Review

```text
╭─ Profile Review · First-run agent profiles ────────────────────────────────╮
│ Setup        model openai/gpt-5.6  thinking high                           │
│ Professor    model openai/gpt-5.6  thinking high                           │
│ PhD          model openai/gpt-5.6  thinking high                           │
│                                                                            │
│ ↑↓ choose · Enter edit · Tab actions                                       │
│                                      [ Continue to setup ]  [ Cancel ]      │
╰────────────────────────────────────────────────────────────────────────────╯
```

`Continue to setup` advances to the existing setup-plan confirmation.
`Cancel` or Escape returns without saving the onboarding checkpoint or
starting setup.

## Interaction Contract

### Input focus

The implementation needs a small editor wrapper, `ResearchEditor`, that owns
the navigation mode while delegating ordinary text editing to Pi's editor.
Rendering the Control Deck as a widget alone is insufficient because widgets
cannot receive keystrokes.

There are two explicit focus states:

- `NAV` — Activity Navigator receives navigation keys.
- `TYPE` — Composer behaves like the normal Pi editor.

When autoresearch starts, focus is `NAV`. The Activity Navigator visibly marks
this state. Typing any printable character switches to `TYPE` and forwards the
same character, so beginning a message does not require a preliminary key.
After submitting a message, focus returns to `NAV`. `Tab` toggles the two
states.

### Keys in NAV

| Key | Overview | Focus |
| --- | --- | --- |
| `Up` / `Down` | Select previous/next Agent Row. | Select previous/next agent and keep Focus open. |
| `Enter` | Open Focus for the selected invocation. | No-op unless a future trace action is selected. |
| `Escape` | Keep Overview and return selection to the first live agent. | Return to Overview. |
| `Left` / `Right` | Select the previous/next invocation for the same role or candidate when available. | Same, while keeping Focus open. |
| `PgUp` / `PgDn` | Move the roster window by one viewport. | Scroll the Agent Trace. |
| `Home` / `End` | Select first/last Agent Row. | Scroll trace to top/bottom; End restores follow mode. |
| `Tab` | Move focus to Composer. | Move focus to Composer without closing Focus. |
| Printable input | Move focus to Composer and insert the key. | Same. |

### Keys in TYPE

Pi's ordinary editor bindings remain unchanged. `Tab` returns to `NAV` only
when the completion menu is closed; otherwise Pi keeps ownership of Tab. The
wrapper must restore Pi's original editor component and bindings when the run
ends, pauses, or the extension unloads.

### Mouse

Agent Rows should expose stable hit targets in the render model, but mouse
events are a follow-up. A click would select a row; a second click or double
click would enter Focus. Keyboard behavior is the release gate for v1.

## Run Overview Semantics

The Run Overview shows exactly five concepts:

| Field | Meaning |
| --- | --- |
| `Stage` | Human label for the durable orchestrator phase, shown in the Control Deck title. |
| `Experiments` | Lifetime count of terminal, sealed candidate records in `ledger.ndjson`. Active candidates are visible in Overview but are not counted early. |
| `Remote accepted` | Unique submissions from this harness that the server accepted, including reconciled submissions. It is not limited to promoted leaderboard entries. |
| `Others` | Unique remote submission IDs in the latest all-submissions snapshot minus IDs attributed to this harness. |
| `Loop tokens` | Input, output, cache-read, and cache-write tokens consumed by all inner-loop agent invocations attributed to the current loop. |

Rules:

- Counters survive restart and resume.
- Submission counts are deduplicated by durable submission receipt/remote ID.
- Cached leaderboard data is acceptable when sync is unavailable; render the
  count dimmed with a `cached` suffix rather than hiding it.
- Loop tokens include Professor, all PhD attempts and postmortems, Advisor, and
  church work for the current loop. Initialization and outer meta-harness
  evaluation are excluded from the inner-loop total.
- If a model omits a token category, count the categories it does provide and
  show `≥` before the total.

## Activity and Trace Data Model

### Invocation identity

Every call through `AgentRunner` receives a stable `invocationId` and
attribution:

```ts
interface AgentInvocationIdentity {
  invocationId: string;
  role: Role;
  kind: TaskKind;
  loop?: number;
  candidateId?: string;
  attempt?: number;
  tracePath?: string;
}
```

An invocation, not a role, is the selectable unit. This lets Left/Right move
through Professor or PhD retries without conflating their histories.

### Durable index

Add `.autoresearch/agent-invocations.ndjson` as an append-only index. Events
record invocation start, compact activity changes, usage updates, and terminal
status. The full transcript remains in each invocation's existing
`events.ndjson`; the index is navigation metadata, not a replacement for raw
evidence.

On restart, fold the index to rebuild Agent Rows, validate each referenced
trace stays inside `.autoresearch/`, and mark an invocation `interrupted` when
it was running but no owning process remains.

### Live event path

`PiSubprocessRunner` already parses each complete stdout JSON line before
writing the final `AgentResult`. Extend that boundary with an optional
invocation observer:

1. Persist the raw bytes to `events.ndjson` as today.
2. Parse complete lines only.
3. Convert relevant events into a small semantic `AgentActivityEvent`.
4. Update the durable invocation index before publishing the UI event.
5. Coalesce UI renders to roughly 100 ms.

The monitor uses this callback while the process is live. Historical and
restart viewing uses the trace tailer.

### Trace tailer

The tailer keeps:

- file identity;
- last complete byte offset;
- pending partial line;
- last known size and modification time;
- a bounded parsed-event cache.

It appends only complete JSONL events. File replacement, truncation, or a
sentinel mismatch causes a full safe reload. Poll around 250 ms only when a
live callback is unavailable; active callbacks should drive rendering without
duplicate parsing.

### Semantic rendering

Map Pi events into:

- assistant text;
- reasoning summaries when present;
- tool start with concise arguments;
- tool result with success/failure and a bounded preview;
- usage/turn completion;
- lifecycle errors, aborts, and retries.

Use the same formatting helpers for live and historical events. Raw JSON is
never the default view. Unknown events are retained in the file and skipped
without breaking the stream.

## Implementation Plan

### Phase 0 — Confirm the Pi keyboard integration seam

- [x] Install the locked dependencies and inspect the exact Pi `0.82.1`
  editor/component interfaces.
- [x] Build a small test component proving that the normal editor can be
  wrapped, input can be delegated without loss, and the original editor can be
  restored.
- [x] Confirm Pi has a supported persistent editor wrapper, so no fallback
  shortcut, input hook, or always-open modal is needed.
- [x] Add interaction tests for `NAV`/`TYPE`, printable-key handoff, and
  cleanup.

Likely files:

- `extensions/autoresearch/research-editor.ts` (new)
- `extensions/autoresearch/commands.ts`
- `test/ui/research-editor-interaction.test.ts` (new)

### Phase 1 — Make Profile Review explicit

- [x] Add `Continue` and `Cancel` results to the onboarding form.
- [x] Add an Onboarding Actions row with keyboard-visible buttons.
- [x] Keep editing fields in a draft config until Continue.
- [x] Make Escape and Ctrl-C return Cancel and discard the draft.
- [x] Keep `/autoresearch config` behavior separate from first-run onboarding.
- [x] Test Continue, Cancel, Escape, nested edit dialogs, and reopening at the
  same navigation position.

Likely files:

- `extensions/autoresearch/config-ui.ts`
- `extensions/autoresearch/commands.ts`
- `test/config-ui.test.ts`
- `test/ui/config-interaction.test.ts`
- `test/commands.test.ts`

### Phase 2 — Add durable invocation and token accounting

- [x] Extend `AgentTask`/`AgentResult` with invocation attribution and detailed
  token usage while preserving existing cost/turn compatibility.
- [x] Parse token categories from Pi `message_end` usage.
- [x] Add append/fold helpers for `agent-invocations.ndjson`.
- [x] Record start before spawning, then activity, usage, and terminal status.
- [x] Rebuild correctly after restart, partial final lines, duplicate events,
  abort, retry, and legacy state without an index.
- [x] Add the five Run Overview fields to `StatusReport`.

Likely files:

- `src/agents/types.ts`
- `src/agents/subprocess.ts`
- `src/agent-activity.ts` (new)
- `src/orchestrator.ts`
- `src/state.ts`
- `src/metaharness.ts`
- `test/subprocess.test.ts`
- `test/orchestrator.test.ts`
- `test/resilience.test.ts`
- `test/agent-activity.test.ts` (new)

### Phase 3 — Build the shared Agent Monitor

- [x] Add a pure `AgentMonitorModel` with stable ID selection, frozen row order,
  overflow windowing, Overview/Focus state, and follow-bottom state.
- [x] Add the incremental trace tailer and semantic event mapper.
- [x] Render Overview as flat one-line Agent Rows in one frame.
- [x] Render Focus inside the same frame with a bounded trace viewport.
- [x] Place the monitor above the Composer with the custom-component widget
  path and retain an RPC-safe string-array fallback.
- [x] Coalesce activity renders and stop watchers/timers on pause or teardown.

Likely files:

- `extensions/autoresearch/agent-monitor.ts` (new)
- `extensions/autoresearch/trace-view.ts` (new)
- `extensions/autoresearch/commands.ts`
- `test/agent-monitor.test.ts` (new)
- `test/trace-view.test.ts` (new)
- `test/ui/agent-monitor-interaction.test.ts` (new)

### Phase 4 — Reduce the Control Deck

- [x] Delete the current persistent `CANDIDATES` and `LIVE ACTIVITY` sections.
- [x] Replace the current top status block with the compact Run Overview.
- [x] Add the one-line Activity Navigator connected to Agent Monitor selection.
- [x] Keep Controls context-sensitive and show whether keys target `NAV` or
  `TYPE`.
- [x] Apply the density rules at wide and narrow terminal widths.
- [x] Keep recovery, Advisor blockers, and meta-harness detail available
  through plain status, notifications, and inspection rather than permanent
  Control Deck sections.

Likely files:

- `extensions/autoresearch/widget.ts`
- `extensions/autoresearch/commands.ts`
- `test/widget.test.ts`
- `test/commands.test.ts`
- `test/pty/visible-screen.test.ts`

### Phase 5 — Document and verify

- [x] Update README usage and keyboard controls.
- [x] Update `docs/architecture.md` with Agent Monitor, invocation index,
  token accounting, and editor restoration.
- [x] Add legacy and RPC fallback coverage.
- [x] Run focused UI, subprocess, orchestrator, resilience, and architecture
  tests.
- [x] Run `npm run typecheck`, `npm test`, and `git diff --check`.
- [x] Inspect the final diff and confirm no `.autoresearch/`, trace, log,
  score, worktree, or temporary artifacts are included.

## Acceptance Criteria

1. First-run Profile Review has visible Continue and Cancel actions; Escape
   cannot advance onboarding.
2. While a run is active, all current agent invocations appear together in one
   compact Agent Monitor above the Composer.
3. Up/Down changes the selected Agent Row without a typed command.
4. Enter changes the same Agent Monitor from Overview to Focus; Escape returns
   to Overview.
5. Focus displays live and historical semantic trace events and follows new
   events until the operator scrolls away.
6. Selection never jumps because activity timestamps or status values changed.
7. The Control Deck contains Activity Navigator, Run Overview, and Controls;
   it contains no Candidate or Live Activity section.
8. Run Overview reports Stage, Experiments, Remote accepted, Others, and Loop
   tokens with restart-safe semantics.
9. The Composer retains normal typing behavior and is fully restored after
   autoresearch stops.
10. At an 80-column viewport, the normal Overview plus Control Deck has no
    nested boxes, no blank rows between agents, and no more than one column of
    interior frame padding.

## Deferred Decisions

- Mouse selection and double-click-to-focus.
- Sending a message directly to a child agent. Focus is read-only in this
  version; the Composer continues to address the main interactive Pi session.
- Search/filter within long traces.
- Exporting a focused trace from the TUI.
- A separate meta-harness token total.

## Iteration Log

| Date | Decision |
| --- | --- |
| 2026-07-26 | Replaced separate activity rail and trace concepts with one Agent Monitor having Overview and Focus. |
| 2026-07-26 | Kept the Agent Monitor above the Composer and the compact Activity Navigator inside the Control Deck below it. |
| 2026-07-26 | Adopted OMP's stable selection, two-view model, incremental trace tailing, and semantic rendering. |
| 2026-07-26 | Tightened the OMP-inspired layout to zero outer margin, one-column frame inset, flat one-line rows, and embedded border titles. |
