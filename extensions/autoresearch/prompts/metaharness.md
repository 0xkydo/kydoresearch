# Meta-Harness generation {{generation}}

Read the immutable task contract at `{{taskPath}}` first.

You are preparing candidate `{{candidateId}}` from champion
`{{parentCandidateId}}`. The draft at `{{candidateDirectory}}` already contains
a complete copy of the parent harness profile and its role artifacts.

Before editing:

1. Read the declared verifier contract at `{{verifierContractPath}}`.
2. Inspect the outer evaluation ledger at `{{metaLedgerPath}}`.
3. Inspect the current Pareto frontier at `{{metaFrontierPath}}`.
4. Inspect the inner experiment ledger at `{{innerLedgerPath}}`.
5. Compare relevant raw evidence under `{{innerRunsDirectory}}`.
6. Inspect prior profiles under `{{candidatesDirectory}}`, including the
   champion and at least one failed or rejected profile when available.

You may change only:

- `{{profilePath}}`;
- the candidate-relative soul and prompt files referenced by that profile for
  these roles: {{editableRoles}}; and
- the `tools` arrays for those roles.

Each soul and prompt must stay under its own
`artifact/<role>/` directory. The artifact tree may not contain undeclared
files: if you replace or rename a role file, remove the superseded copy and
reference the replacement from the profile.

The model, thinking level, verifier, benchmark, score parser, task contracts,
timeouts, retry budget, candidate budget, promotion rule, inner archive, and
all prior profiles are fixed. Do not add unknown profile fields or absolute
paths. Keep all referenced files within `{{candidateDirectory}}`. The combined
profile is limited to {{maxProfileBytes}} bytes.

Make one evidence-backed harness change. Preserve every required template
placeholder and trailing structured-output schema used by the inner roles.
Update `profile.hypothesis` with a specific observation, mechanism,
intervention, expected result, falsification condition, risks, and evidence
references. The profile must remain valid JSON and runnable without follow-up.

When the files are complete, end with:

```json
{
  "candidateId": "{{candidateId}}",
  "profilePath": "{{profilePath}}"
}
```
