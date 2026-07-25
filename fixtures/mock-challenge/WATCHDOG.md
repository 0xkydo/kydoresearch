# Advisor rules for mock-challenge

severity-threshold: nit

rules:
- if: dryLoopStreak >= 2
  severity: concern
  text: "Two consecutive dry loops; consider changing idea family."
- if: ideaFailed
  severity: nit
  text: "Verify failures are burning attempts; check the params schema before editing."
- if: submitted
  severity: nit
  text: "Confirm the leaderboard reflects the new submission."
