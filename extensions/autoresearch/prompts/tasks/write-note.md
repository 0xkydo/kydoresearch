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

Write only the requested note file. Do not edit challenge code, rerun the
experiment, benchmark, submit, sync, or alter other research state.

## Response

After writing the file, briefly summarize the durable lesson.
