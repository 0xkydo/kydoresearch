# Task: Implement one research idea

Work inside the detached worktree dedicated to idea `{{ideaId}}` and implement
the specification at `{{specFile}}`.

## Context

- Loop: {{loop}}
- Attempt: {{attempt}} of {{maxVerifyAttempts}}
- Editable paths: {{editablePaths}}
- Local validation command: `{{verifyCommand}}`
- Main research state: `{{stateDir}}`

{{#localEvaluation}}
Local evaluation contract:

```json
{{localEvaluation}}
```

When its fidelity is `reduced`, treat `{{verifyCommand}}` as a local regression
signal, not proof of full correctness. Preserve the recorded limitations in
your report; official validation remains authoritative.
{{/localEvaluation}}

{{#lastVerifyError}}
## Previous-attempt evidence

The harness rejected the previous attempt:

```text
{{lastVerifyError}}
```

Find and fix the root cause. Do not suppress the symptom or relax the check.
{{/lastVerifyError}}

## Procedure

1. Read the entire idea spec and the relevant knowledge-base sections.
2. Inspect the current implementation and verify the spec's assumptions.
3. Make the smallest coherent change that completely tests the hypothesis. If
   the spec is ambiguous, take the smallest reasonable interpretation and
   record the assumption.
4. Run focused checks, then `{{verifyCommand}}` when practical.
5. Review the final diff for out-of-scope edits, generated files, debug output,
   weakened invariants, and unrelated changes.

Edit only the declared editable paths. Do not write to `.autoresearch/`, run the
full performance benchmark, create branches or commits, or manage worktrees or
stashes. The harness owns those operations.

If the experiment is impossible within the boundary or contradicts the
correctness contract, leave the checkout safe and report the blocker precisely.

## Response

Report:
- files and behavior changed;
- the score mechanism tested;
- checks run and observed outcomes;
- assumptions, remaining risks, or a precise blocker.

Do not claim a score; the harness measures it after verification.
