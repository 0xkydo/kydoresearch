# Task: Record a completed experiment

Write a durable hypothesis note to `{{notePath}}`.

## Evidence from the harness

- Idea: {{ideaTitle}}
- Outcome: {{status}}
- Local score: {{localScore}}
- Best score at review time: {{bestScore}}
- Verification or benchmark failure, if any: {{lastVerifyError}}

An absent score means “not measured.” A correctness failure is evidence about
implementation or constraints, not performance.

## Note format

Use these headings:

- `Hypothesis`
- `Change tested`
- `Observed outcome`
- `Interpretation`
- `Reusable lesson`
- `Recommended next experiment`

Distinguish observation from causal interpretation. A worse score disproves the
tested configuration, not necessarily the whole idea family. Recommend one
concrete next experiment only when the evidence supports it.

Do not edit challenge code or research state, rerun the experiment, benchmark,
submit, or sync.

## Response

Return the complete markdown note. The harness owns the postmortem file write.
