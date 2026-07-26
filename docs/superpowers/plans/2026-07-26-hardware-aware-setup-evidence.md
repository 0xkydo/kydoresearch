# Hardware-Aware Setup Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-setup Setup agent read the completed setup log, correlate repository guidance with local hardware, and select supported effective verification and benchmark commands.

**Architecture:** Extend the persisted setup task input with explicit setup evidence (`setupCommand`, `setupLogPath`, and `setupSucceeded`). Keep initialization order unchanged. Strengthen the bundled Setup prompts, then continue using the existing `verifyCommand` and `benchCommand` output fields so baseline and loop execution require no new adapter abstraction.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, Pi markdown prompt templates.

## Global Constraints

- Setup continues to run after the manifest `setupCommand` succeeds.
- Kydoresearch must not encode challenge-specific memory thresholds, profiles, or environment flags.
- Setup may select only repository-documented commands and flags.
- Setup classification may use only lightweight, non-mutating probes and must not rerun setup, benchmarks, large-model loads, or expensive verification.
- Returned effective commands must drive the initial baseline and later research loops.
- Reduced local fidelity must remain visible in the knowledge base and must not be represented as official-hardware validation.

---

### Task 1: Persist and Deliver Setup Evidence

**Files:**
- Modify: `src/experiments.ts`
- Modify: `src/init.ts`
- Test: `test/init.test.ts`

**Interfaces:**
- Produces: `SetupTaskInputV1` fields `setupCommand: string`, `setupLogPath: string`, and `setupSucceeded: true`.
- Produces: Setup runner input containing those persisted fields plus runtime-only `manifest` and `traceDir`.
- Preserves: Setup structured output fields `verifyCommand` and `benchCommand`.

- [ ] **Step 1: Write failing setup-evidence and effective-command tests**

Add an `initChallenge` test with a capturing `AgentRunner`. Assert that its `init.explore` task receives the executed setup command, the real `.autoresearch/logs/setup.log` path, and `setupSucceeded: true`; assert the persisted `setup-task.json` contains the same fields and the log contains the setup invocation.

Add a second test whose runner returns:

```ts
structured: {
  status: "ready",
  subjectArea: "hardware-aware fixture",
  verifyCommand: "FIXTURE_MODE=local ./verify.sh",
  benchCommand: "FIXTURE_MODE=local ./benchmark.sh",
}
```

Capture shell commands through `ExecPort`, then assert the prefixed benchmark command ran for baseline and both effective commands were persisted in `state.challenge`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npm test -- --run test/init.test.ts
```

Expected: FAIL because setup evidence is absent from the task contract and persisted task input.

- [ ] **Step 3: Extend the typed setup contract and initialization handoff**

Change `SetupTaskInputV1` to:

```ts
export interface SetupTaskInputV1 {
  repoRoot: string;
  manifestPath: string;
  knowledgeBasePath: string;
  setupCommand: string;
  setupLogPath: string;
  setupSucceeded: true;
}
```

Populate those fields when materializing `setupTask` in `initChallenge`. Use `paths.logsDir/setup.log` as the evidence path. Build runner input from `setupTask.input`, adding only `manifest` and `traceDir`; remove the duplicate ad hoc `setupCommand` injection.

- [ ] **Step 4: Run focused tests and confirm success**

Run:

```bash
npm test -- --run test/init.test.ts
```

Expected: all initialization tests PASS.

- [ ] **Step 5: Commit the contract change**

```bash
git add src/experiments.ts src/init.ts test/init.test.ts
git commit -m "Pass setup evidence to the setup agent"
```

---

### Task 2: Require Hardware-Aware Setup Classification

**Files:**
- Modify: `extensions/autoresearch/prompts/setup.md`
- Modify: `extensions/autoresearch/prompts/tasks/init-explore.md`
- Modify: `extensions/autoresearch/agents/setup/SOUL.md`
- Test: `test/subprocess.test.ts`
- Test: `test/architecture.test.ts`

**Interfaces:**
- Consumes: `setupCommand`, `setupLogPath`, and `setupSucceeded` from Task 1.
- Produces: rendered Setup context that explicitly identifies the latest successful setup log as evidence.
- Preserves: trailing `ready`/`needs-user-action` JSON schemas.

- [ ] **Step 1: Write failing prompt-contract tests**

Update the Setup case in `test/subprocess.test.ts` to provide:

```ts
input: {
  manifest,
  setupCommand: "./setup.sh",
  setupLogPath: "/tmp/project/.autoresearch/logs/setup.log",
  setupSucceeded: true,
}
```

Assert the rendered prompt includes the log path and requirements equivalent to:

- read the latest successful setup invocation;
- relate repository requirements to local hardware;
- use only repository-supported flags;
- document reduced-fidelity and official-hardware gaps;
- do not rerun setup, benchmark, load a large model, or run expensive verification.

Extend `test/architecture.test.ts` so the Setup role/task contract must mention setup-log evidence and local hardware.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npm test -- --run test/subprocess.test.ts test/architecture.test.ts
```

Expected: FAIL because the bundled Setup prompts do not contain the new evidence and safety requirements.

- [ ] **Step 3: Update Setup role and task prompts**

In `setup.md`, require reading `{{setupLogPath}}`, correlating setup notices plus repository guidance with the host, selecting supported effective commands, and documenting local fidelity gaps.

In `tasks/init-explore.md`, add the setup evidence fields to Context and make the Work section explicit about:

- inspecting the latest successful log block before readiness;
- lightweight non-mutating host probes only when evidence is insufficient;
- returning command strings with documented environment prefixes when necessary;
- refusing undocumented or ambiguous workarounds;
- prohibiting setup reruns, benchmark runs, large-model loads, and expensive verification.

In `agents/setup/SOUL.md`, reinforce hardware-aware evidence analysis while preserving the role's non-optimization boundary.

- [ ] **Step 4: Run focused tests and confirm success**

Run:

```bash
npm test -- --run test/subprocess.test.ts test/architecture.test.ts
```

Expected: all prompt and architecture contract tests PASS.

- [ ] **Step 5: Commit the prompt change**

```bash
git add extensions/autoresearch/prompts/setup.md extensions/autoresearch/prompts/tasks/init-explore.md extensions/autoresearch/agents/setup/SOUL.md test/subprocess.test.ts test/architecture.test.ts
git commit -m "Make setup classification hardware aware"
```

---

### Task 3: Document and Verify the End-to-End Behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Test: `test/architecture.test.ts`

**Interfaces:**
- Documents: unchanged setup-first ordering and setup-log evidence handoff.
- Documents: effective command persistence and reduced-fidelity caveats.

- [ ] **Step 1: Add failing documentation assertions**

Extend `test/architecture.test.ts` to require architecture text covering:

```text
setup-log evidence
local hardware
repository-supported flags
effective benchmark command
reduced-fidelity
```

- [ ] **Step 2: Run the documentation test and confirm failure**

Run:

```bash
npm test -- --run test/architecture.test.ts
```

Expected: FAIL until architecture documentation contains the required concepts.

- [ ] **Step 3: Update user and architecture documentation**

Update README initialization prose to explain that Setup reads the completed setup log, compares repository guidance with local hardware, and may choose documented local-mode prefixes for later verification and benchmarking.

Update `docs/architecture.md` first-run initialization to describe the explicit evidence fields, effective command persistence, baseline use, and the requirement to record reduced-fidelity gaps without claiming official validation.

- [ ] **Step 4: Run complete verification**

Run in parallel where practical:

```bash
npm test
npm run typecheck
```

Expected: the full Vitest suite and TypeScript typecheck PASS.

- [ ] **Step 5: Inspect the final diff and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~2
```

Then commit:

```bash
git add README.md docs/architecture.md test/architecture.test.ts
git commit -m "Document hardware-aware setup evidence"
```
