# Advisor rules for Ranking Quality

severity-threshold: nit

rules:
- if: ideaFailed
  severity: concern
  text: "A ranker candidate violated the normalized-weight contract; inspect the verifier log."
- if: dryLoopStreak >= 2
  severity: concern
  text: "Repeated weight vectors are not exploring the quality surface; change the signal balance."
- if: submitted
  severity: nit
  text: "A higher-scoring local submission was recorded; inspect its public reproduction note."
