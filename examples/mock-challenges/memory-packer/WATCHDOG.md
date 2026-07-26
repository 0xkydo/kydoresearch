# Advisor rules for Memory Packer

severity-threshold: nit

rules:
- if: ideaFailed
  severity: concern
  text: "A layout candidate violated the discrete compatibility contract; inspect its verifier evidence."
- if: dryLoopStreak >= 2
  severity: concern
  text: "The memory frontier is flat; combine orthogonal layout levers instead of replaying one extreme."
- if: submitted
  severity: nit
  text: "A lower-memory local submission was recorded; confirm the mock frontier and reproduction note."
