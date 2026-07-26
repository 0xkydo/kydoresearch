# Task: Classify setup and confirm readiness

Organize the repository's existing pieces into the buckets required by the
harness, and determine whether the challenge is ready to run.

## Context

- Working directory: `{{cwd}}`
- State directory: `{{stateDir}}`
- Setup command already run by the harness: `{{setupCommand}}`
- Setup completed successfully: `{{setupSucceeded}}`
- Latest successful setup log: `{{setupLogPath}}`
- Parsed manifest:

```json
{{manifest}}
```

## Work

1. Read the manifest, then inspect the latest successful setup invocation in
   `{{setupLogPath}}`. Treat its notices, selected modes, and warnings as setup
   evidence rather than incidental output.
2. Read only the repository documentation or scripts needed to classify the
   existing dependency/setup command, correctness command, performance
   benchmark, editable paths, score artifact, and score direction.
3. Connect the setup evidence and repository-declared hardware requirements to
   the local hardware. If those sources are insufficient, use only a tiny,
   non-mutating host probe. Do not infer hardware policy from assumptions.
4. Select effective verification and benchmark commands. Prefer the manifest's
   `preSubmitCommand` for correctness when present and its benchmark command
   for performance. Add environment prefixes or repository-supported flags
   only when repository evidence documents them for this host or mode.
5. Write a concise `{{stateDir}}/knowledge-base.md` with:
   - `Challenge`
   - `Dependency`
   - `Correctness`
   - `Benchmark`
   - `Editable paths`
   - `Score`
   - `Readiness`

The knowledge base must cite relevant setup notices and document the effective
commands, every non-default flag, local hardware limitations, reduced-fidelity
behavior, paths not exercised locally, and remaining official-hardware
validation. A repository-supported reduced mode may be ready; do not describe
it as equivalent to official execution.

Do not create or modify challenge code, dependencies, scripts, manifests,
tests, correctness gates, benchmarks, git history, or user configuration. Do
not devise a creative workaround for a missing verifier or dependency. Only a
trivial, non-mutating readiness check is within scope.

A timing-only override that keeps a score usable while recording failed
correctness is not a full correctness command. Do not describe it as verified
correctness. If this host cannot provide full local correctness, choose the
safest documented reduced local regression command yourself, return `ready`
with `fidelity: "reduced"`, record every gap, and require official validation.

Do not rerun the setup command. Do not run the performance benchmark. Do not
load a large model merely to classify readiness or run expensive verification.
The harness runs the baseline after Setup returns.

Resolve ambiguous but repository-supported mode, flag, and hardware decisions
yourself. If full evaluation is unavailable, choose reduced evaluation and
continue. Stop only when no supported mode can execute without a genuinely
external capability, such as unavailable credentials, an inaccessible
required artifact, or a dependency the completed setup command could not
install.

## Response

When ready, briefly summarize the classification. End with exactly one trailing
fenced JSON object and no text after it:

```json
{
  "status": "ready",
  "subjectArea": "concise domain label",
  "verifyCommand": "existing correctness command",
  "benchCommand": "existing performance benchmark command",
  "localEvaluation": {
    "fidelity": "full or reduced",
    "decision": "what Setup selected and why",
    "limitations": [
      "what local evaluation does not establish"
    ],
    "officialValidationRequired": false
  }
}
```

When a genuine external capability makes every supported local mode
unexecutable, end with exactly one trailing fenced JSON object and no text
after it:

```json
{
  "status": "blocked-external",
  "externalBlocker": {
    "reason": "why no supported local mode can execute",
    "location": "where the blocker is evidenced",
    "instructions": [
      "specific external action required"
    ]
  }
}
```
