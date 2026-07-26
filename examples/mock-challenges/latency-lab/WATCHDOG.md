# Advisor rules for Latency Lab

severity-threshold: nit

rules:
- if: ideaFailed
  severity: concern
  text: "A candidate exhausted or used a verifier retry; inspect its schema and bounds."
- if: dryLoopStreak >= 2
  severity: concern
  text: "The latency frontier is flat; change the lever family instead of replaying the baseline."
- if: submitted
  severity: nit
  text: "A local mock submission was recorded; confirm it appears on the seeded leaderboard."
