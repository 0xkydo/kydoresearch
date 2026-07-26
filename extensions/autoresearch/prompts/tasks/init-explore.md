# Task: Classify setup and confirm readiness

Organize the repository's existing pieces into the buckets required by the
harness, and determine whether the challenge is ready to run.

## Context

- Working directory: `{{cwd}}`
- State directory: `{{stateDir}}`
- Setup command already run by the harness: `{{setupCommand}}`
- Parsed manifest:

```json
{{manifest}}
```

## Work

1. Read the manifest and only the repository documentation or scripts needed
   to classify the existing:
   - dependency and setup command;
   - correctness command;
   - performance benchmark;
   - editable paths;
   - score artifact and score direction.
2. Confirm that the setup command completed and its required dependency is
   usable. Use only a tiny, non-mutating local probe when confirmation is
   necessary.
3. Prefer the manifest's `preSubmitCommand` for correctness when present and
   its benchmark command for performance. Use another existing command only
   when the repository clearly declares it for that bucket.
4. Write a concise `{{stateDir}}/knowledge-base.md` with:
   - `Challenge`
   - `Dependency`
   - `Correctness`
   - `Benchmark`
   - `Editable paths`
   - `Score`
   - `Readiness`

Do not create or modify challenge code, dependencies, scripts, manifests,
tests, correctness gates, benchmarks, git history, or user configuration. Do
not devise a creative workaround for a missing verifier or dependency. Only a
trivial, non-mutating readiness check is within scope.

If a dependency, command, or required configuration is missing, ambiguous, or
must be handled somewhere else, stop and return `needs-user-action`. Tell the
user what is needed, where to do it, and whether the user or another agent
should own the work.

## Response

When ready, briefly summarize the classification. End with exactly one trailing
fenced JSON object and no text after it:

```json
{
  "status": "ready",
  "subjectArea": "concise domain label",
  "verifyCommand": "existing correctness command",
  "benchCommand": "existing performance benchmark command"
}
```

When work is required outside Setup, do not continue. End with exactly one
trailing fenced JSON object and no text after it:

```json
{
  "status": "needs-user-action",
  "userAction": {
    "reason": "why the harness is not ready",
    "location": "where the work must happen",
    "instructions": [
      "specific action to take"
    ],
    "suggestedOwner": "user or another agent"
  }
}
```
