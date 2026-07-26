# Hardware-Aware Setup Evidence Design

## Summary

Keep the existing initialization order: `/autoresearch` runs the challenge manifest's `setupCommand` first, then invokes the Setup agent. Improve the handoff so Setup explicitly ingests the completed setup invocation's notes and evaluates them against repository documentation and the local host before selecting verification and benchmark commands.

The behavior remains challenge-agnostic. Kydoresearch will not encode MLX Fast memory thresholds, environment variables, or hardware policy. The repository and its setup output remain the authority.

## Goals

- Make setup-command notices first-class evidence for the Setup agent.
- Require Setup to relate repository requirements to the actual local host.
- Let Setup select repository-supported modes, profiles, flags, or alternate commands for subsequent correctness and benchmark execution.
- Persist those effective commands for the initial baseline and later research loops.
- Record local-hardware limitations and fidelity gaps in the knowledge base.
- Avoid expensive or unsafe readiness probes during Setup's classification pass.

## Non-goals

- Do not run Setup before `setupCommand`.
- Do not let Setup retroactively replace or rerun the completed setup command.
- Do not add MLX Fast-specific memory thresholds or flags to kydoresearch.
- Do not infer undocumented flags or invent workarounds.
- Do not make local reduced-fidelity execution equivalent to official or production hardware.
- Do not change challenge code, manifests, dependencies, benchmarks, or user configuration during Setup classification.

## Initialization Flow

The initialization sequence remains:

1. Read and validate `benchmark.json` and Git state.
2. Create `.autoresearch/` and its local logs.
3. Run the manifest's `setupCommand`, including existing retry behavior.
4. If setup succeeds, invoke the Setup agent with explicit setup evidence.
5. Persist Setup's effective verification and benchmark commands.
6. Run the initial baseline with the effective benchmark command.
7. Save initialized state and continue into the research loop.

If setup fails, initialization stops before invoking Setup, as it does today.

## Setup Evidence Contract

The Setup invocation will receive:

- the setup command that was executed;
- the path to the append-only setup log;
- confirmation that the setup phase completed successfully;
- the existing manifest, repository root, state directory, task path, and knowledge-base path.

The setup log path must be explicit in the generated task context rather than implied through a hard-coded `.autoresearch` location. Setup must inspect the latest completed successful invocation in that log. This accommodates retries and previous initialization attempts without copying potentially large setup output into the agent prompt.

The setup log remains local evidence. Kydoresearch does not upload it or add it to public submission notes.

## Setup Agent Responsibilities

Before declaring readiness, Setup must:

1. Read its immutable task contract.
2. Read the latest successful setup invocation from the supplied setup log.
3. Inspect the manifest and relevant repository instructions or scripts for documented hardware requirements, setup notices, supported profiles, environment flags, and local-versus-official execution differences.
4. Correlate those requirements with the local host. It may use only small, non-mutating probes when the setup log and repository documentation do not already provide enough information.
5. Select effective correctness and benchmark commands using only repository-supported commands and flags.
6. Record the evidence, selected local mode, necessary flags, limitations, and fidelity gaps in `knowledge-base.md`.
7. Return `needs-user-action` instead of guessing when the evidence is missing, ambiguous, or requires work outside Setup's authority.

Setup must not rerun setup, load a large model merely to classify readiness, run the performance benchmark, or execute another expensive validation command. The harness owns baseline measurement immediately after Setup returns.

## Effective Command Behavior

Setup continues to return `verifyCommand` and `benchCommand`. This preserves the existing state model and challenge adapter contract.

When repository-supported environment flags are needed, Setup may include them in the returned command strings. For example, a repository may document an environment prefix, low-memory profile, reduced test mode, or hardware-specific local override. Setup must preserve the manifest command's purpose and may not weaken correctness silently.

The harness will:

- use the returned `benchCommand` for the initial baseline;
- persist both returned commands in `state.challenge`;
- use them for candidate verification and benchmarking throughout the campaign;
- retain existing fallbacks when Setup omits a command.

Setup cannot change the already-executed `setupCommand`. Any setup notice relevant to later phases is carried forward through the effective commands and knowledge base.

## Knowledge-Base Requirements

The generated knowledge base must include, when applicable:

- relevant local hardware facts;
- repository-declared hardware minimums or recommended profiles;
- setup notices that selected or recommended a mode;
- effective local verification and benchmark commands;
- each non-default flag and the repository evidence supporting it;
- behavior unavailable on the local host;
- differences from official, ranked, CI, or production hardware;
- the external validation still required for unexercised paths.

For the motivating MLX Fast case, the expected result is that Setup recognizes the repository's automatic low-memory policy, does not force compiled decode without documented headroom, and records that the official higher-memory runner exercises paths the local machine cannot validate. Those details come from MLX Fast's setup output and repository documentation, not kydoresearch code.

## Error Handling

- A failed setup command remains a hard initialization failure.
- A missing or unreadable setup log is actionable because Setup cannot inspect the evidence it was promised.
- Unsupported or contradictory hardware guidance produces `needs-user-action` with the relevant location and requested action.
- Setup must distinguish a safe reduced-fidelity local mode from a broken environment. Reduced fidelity can be ready when the repository explicitly supports it and the limitation is documented.
- Setup must not convert correctness failures into success unless the repository explicitly documents the local override and the returned command preserves visible failure metadata.

## Testing

Add focused tests that verify:

1. Initialization passes the actual setup-log path and successful setup metadata to the Setup runner.
2. The generated Setup context explicitly requires reading the latest successful setup invocation.
3. The bundled Setup prompt requires hardware-aware correlation, repository-supported flags only, fidelity documentation, and non-mutating lightweight probes.
4. The prompt prohibits rerunning setup, benchmarks, large-model loads, or expensive readiness checks.
5. Setup's returned `verifyCommand` and `benchCommand`, including environment prefixes, are persisted unchanged.
6. The initial baseline uses Setup's returned benchmark command.
7. Existing command fallbacks and `needs-user-action` behavior remain intact.
8. No challenge-specific hardware threshold or MLX Fast flag is introduced into kydoresearch source.

Tests should use temporary fixture repositories and synthetic setup-log notices. They must not depend on the developer machine's physical memory or execute a real challenge benchmark.

## Documentation

Update the architecture and user documentation to state that:

- Setup runs after dependency setup;
- setup output is evidence for hardware-aware command selection;
- the selected commands may include repository-supported local profile flags;
- local reduced-fidelity modes must be documented and do not replace official-hardware validation.
