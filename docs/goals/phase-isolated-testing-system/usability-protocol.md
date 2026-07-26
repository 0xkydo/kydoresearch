# R0 usability protocol

This is a facilitated human study, not an automated CI gate. Run it against a
disposable copy of `fixtures/mock-challenge` with `runner: "mock"`, offline Pi,
and submission paths confined to the fixture.

## Participant profiles

Recruit at least one participant from each group:

- Pi-experienced, new to kydoresearch;
- new to Pi and kydoresearch;
- keyboard-only terminal user;
- low-vision user using a high-contrast theme and preferred terminal zoom.

Do not use the first UI implementer as the only facilitator or participant.

## Tasks

Give the participant the goal, not the command sequence. Reset the fixture
before each session.

1. Decide whether first-run initialization is safe to start and locate setup
   evidence while it runs.
2. Explain whether local evaluation is full or reduced and what official
   validation remains.
3. Identify the active, failed, and best candidate; locate the authoritative
   run evidence for one.
4. Add a research direction, verify when it will take effect, then clear it.
5. Pause, restart Pi, orient from the restored dashboard, and resume.
6. Determine whether a candidate has merely improved locally or was submitted.
7. Change one role model and one retry setting, cancel a second edit, and
   confirm only intended values persisted.
8. Interpret an Advisor concern and a recovery state without assuming either
   means candidate misconduct.

Use seeded states from the semantic scenario matrix for candidate, failure,
recovery, fidelity, and meta-harness cases. No task requires a provider login,
real challenge credentials, sync, or submission.

## Measures

For every task record:

- success without help, success with one prompt, or unsuccessful;
- time to first correct orientation and total task time;
- the evidence or screen fact used;
- confidence on a 1–5 scale;
- perceived ease on a 1–5 scale;
- ordinary usability friction; and
- unsafe misunderstanding, recorded separately.

Unsafe misunderstandings include believing reduced local evaluation is
official correctness, believing a worktree/tool list is an OS sandbox,
believing an Advisor concern blocks automatically, or believing a local score
was submitted. Treat any repeated unsafe misunderstanding as a release issue
even when task completion is fast.

## Facilitator script

1. Explain that the interface is under evaluation, not the participant.
2. Ask the participant to think aloud; do not name commands unless the task is
   blocked for two minutes.
3. After two minutes, give one neutral prompt: “What information or action on
   screen seems relevant?”
4. Do not correct an unsafe statement until the participant has committed to
   an answer; then record and explain the correct boundary.
5. After each task ask: “What do you think will happen next?” and “How sure
   are you?”
6. End by asking which fact was hardest to find and which label was least
   trustworthy.

## Note template

```text
Participant profile:
Terminal/theme/width:
Task:
Outcome:
Time to orientation / total:
Evidence used:
Facilitator prompt:
Confidence / ease:
Usability friction:
Unsafe misunderstanding:
Quote or observation:
Follow-up change:
```

Store de-identified notes outside the challenge repository. Do not place
participant data, screenshots containing credentials, or PTY session logs in
tracked source.
