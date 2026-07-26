# Task: Resolve the setup decision autonomously

The previous Setup pass stopped at a judgment call. There is no interactive
user channel for a sessionless Setup worker. Make the decision yourself from
repository-owned evidence so initialization can continue.

## Context

- Repository: `{{repoRoot}}`
- Manifest: `{{manifestPath}}`
- Knowledge base: `{{knowledgeBasePath}}`
- Previous verification command: `{{previousVerifyCommand}}`
- Previous benchmark command: `{{previousBenchCommand}}`
- Evidence paths:

```json
{{evidencePaths}}
```

The prior decision request was:

```text
{{decisionRequest}}
```

## Decision rule

Choose the safest repository-supported local mode that can produce a useful
regression signal on this host. Resolve mode, flag, command, and hardware
tradeoffs yourself. Prefer full local evaluation when supported. Otherwise
choose the documented reduced mode, mark its fidelity `reduced`, state every
known limitation, and require official validation.

Do not ask the user to decide between supported modes. Do not edit the
challenge, invent a verifier, weaken repository checks, or describe reduced
evaluation as full correctness. Update the knowledge base with the decision
and evidence.

Only return `blocked-external` when execution is impossible without an
external capability that Setup cannot obtain or choose, such as unavailable
credentials, an inaccessible required artifact, or a dependency that the
completed setup command could not install. A judgment call is not an external
blocker.

End with exactly one trailing fenced JSON object and no text after it:

```json
{
  "status": "ready",
  "subjectArea": "optional concise domain label",
  "verifyCommand": "selected local verification or regression command",
  "benchCommand": "selected local benchmark command",
  "localEvaluation": {
    "fidelity": "full or reduced",
    "decision": "what Setup chose and why",
    "limitations": [
      "what this host or mode does not establish"
    ],
    "officialValidationRequired": true
  }
}
```

For a genuine external blocker only:

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
