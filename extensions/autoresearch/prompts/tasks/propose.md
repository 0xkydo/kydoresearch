# Task: Propose the next research portfolio

Create a small set of high-information experiments for the current loop.

## Decision context

- Loop: {{loop}}
- Maximum parallel ideas: {{maxIdeasPerLoop}}
- Current best local score: {{bestScore}}
- Score direction: `{{direction}}` (`+` means higher is better; `-` means lower
  is better)
- Consecutive dry loops: {{dryLoopStreak}}
- State directory: `{{stateDir}}`

Read `{{stateDir}}/knowledge-base.md` first. Then inspect the most relevant
recent idea specs and hypothesis, Advisor, church, and submission notes. Use the
current values above when an older note differs.

{{#operatorSteering}}
The operator's current search preference is:

> {{operatorSteering.text}}

Use it as a hypothesis lead while keeping evidence and the fixed harness
boundary authoritative. State how the portfolio responds to it, including any
material conflict with observed evidence.
{{/operatorSteering}}

## Method

1. Build an evidence ledger: improvements, correctness failures, verified
   negative results, measured facts, causal hypotheses, and untouched levers.
2. Choose between 1 and {{maxIdeasPerLoop}} ideas. Use fewer when candidates
   would be correlated; use more only for genuinely independent mechanisms.
3. After an improvement, isolate or extend its mechanism. After a plateau,
   change a real assumption, representation, algorithm family, or bottleneck.
4. Make every idea independent of other ideas in this loop.
5. Prefer the smallest experiment that can falsify its hypothesis.

Do not propose implementation outside editable paths, verification weakening,
harness changes, score manipulation, full benchmark runs, submission, or sync.
Never invent competitor methods or measurements.

## Idea specification

Every `spec` must be standalone markdown with:

- `Hypothesis`
- `Evidence`
- `Mechanism`
- `Implementation`
- `Correctness constraints`
- `Verification`
- `Falsification signal`
- `Scope`

Titles must be short, unique, and mechanism-specific. If evidence is weak,
return one conservative, reversible experiment and state the uncertainty. You
must return at least one idea.

## Response

Briefly explain the portfolio logic. End with exactly one trailing fenced JSON
object and no text after it:

```json
{
  "ideas": [
    {
      "title": "mechanism-specific title",
      "spec": "standalone markdown implementation brief"
    }
  ]
}
```
