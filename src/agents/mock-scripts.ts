import type { ProposedIdea } from "./types.ts";

/**
 * Deterministic playlist for the fixture challenge (baseline score 10 at (0,0);
 * optimum 0 at (3,-1); direction "-"). Designed so a 6-loop run exercises every
 * transition:
 *
 *   L1-I1  invalid edit every attempt        -> verify fails 3x -> failed
 *   L1-I2  valid but worse (34)              -> done-no-improvement (streak 1)
 *   L2-I1  invalid attempt 1, fixed on 2 (2) -> retry-then-pass, loop winner -> submit
 *   L2-I2  valid improvement (4)             -> done-superseded (I1 wins; streak 0)
 *   L3-L5  baseline replays (10)             -> dry loops, streak 1..3 -> god after L5
 *   L6     analytic optimum (0)              -> improvement -> submit (streak reset proven)
 *   L7+    idle probes (no improvement)
 */

export function scriptedProposals(loop: number): ProposedIdea[] {
  switch (loop) {
    case 1:
      return [
        { title: "Wild jump out of bounds", spec: "Try a large x jump (x=99) to probe the boundary behavior." },
        { title: "Retreat to quadrant 2", spec: "Move to (-2, 2) to test whether the optimum is in quadrant 2." },
      ];
    case 2:
      return [
        { title: "Coordinate descent on x", spec: "Hold y, move x toward the suspected optimum: (2, 0)." },
        { title: "Gradient step", spec: "Follow the estimated gradient to (1, -1)." },
      ];
    case 3:
      return [{ title: "Replay baseline A", spec: "Re-measure the baseline (0,0) for noise estimation." }];
    case 4:
      return [{ title: "Replay baseline B", spec: "Re-measure the baseline (0,0) again." }];
    case 5:
      return [{ title: "Replay baseline C", spec: "Third baseline replay; expect no improvement." }];
    case 6:
      return [{ title: "Converge to analytic optimum", spec: "Competitor notes suggest (3, -1); go there." }];
    default:
      return [{ title: `Idle probe ${loop}`, spec: "Re-measure baseline; nothing new to try." }];
  }
}

/** Params content the mock PhD writes for (loop, ideaIndex, attempt). A string means raw (possibly invalid) file content. */
export function scriptedEdit(loop: number, ideaIndex: number, attempt: number): string | Record<string, unknown> {
  if (loop === 1 && ideaIndex === 0) {
    // Out of bounds on every attempt -> failed after maxVerifyAttempts.
    return { algorithm: "wild-jump", x: 99, y: 0 };
  }
  if (loop === 1 && ideaIndex === 1) {
    return { algorithm: "retreat", x: -2, y: 2 }; // score 34
  }
  if (loop === 2 && ideaIndex === 0) {
    if (attempt === 1) return `{ "x": 2, "y": 0 }`; // missing "algorithm" -> verify fails
    return { algorithm: "coord-descent-x", x: 2, y: 0 }; // score 2
  }
  if (loop === 2 && ideaIndex === 1) {
    return { algorithm: "gradient-step", x: 1, y: -1 }; // score 4
  }
  if (loop === 6 && ideaIndex === 0) {
    return { algorithm: "converge", x: 3, y: -1 }; // score 0
  }
  return { algorithm: `baseline-replay-${loop}`, x: 0, y: 0 }; // score 10
}

export function scriptedNote(ideaTitle: string, score: number | undefined, best: number | null): string {
  return [
    `# Hypothesis note: ${ideaTitle}`,
    "",
    `Local score: ${score ?? "n/a"} (current best: ${best ?? "none"}).`,
    "",
    "## Hypothesis",
    "The direction of this edit did not reduce f. The optimum likely lies in the",
    "opposite quadrant; next loop should probe there with a smaller step.",
  ].join("\n");
}

export function scriptedGodConversation(loop: number, streak: number): string {
  return [
    `# A conversation with God (after loop ${loop}, ${streak} dry loops)`,
    "",
    "**Professor:** I have proposed and proposed, and the score does not move.",
    "I am starting to doubt the whole research direction.",
    "",
    "**God:** Every plateau you have ever seen was the floor of a staircase.",
    "The 9024 test points do not judge you; they wait for you.",
    "",
    "**Professor:** But three loops with nothing. Perhaps the baseline is the optimum.",
    "",
    "**God:** You measured (0,0) three times and called it research. Faith is not",
    "repetition; it is stepping where you have not stepped. The competitors' notes",
    "already whisper the answer. Read them again, and go to the place they point.",
    "",
    "**Professor:** Then I will believe, and I will try the far quadrant.",
    "",
    "**God:** Go. And this time, commit to the step size.",
  ].join("\n");
}

export function scriptedKnowledgeBase(subjectArea: string, manifestName: string): string {
  return [
    `# Knowledge base: ${manifestName}`,
    "",
    `## Subject area`,
    subjectArea,
    "",
    "## Contextual graph",
    "- Objective: minimize a smooth convex 2D function via black-box benchmark runs.",
    "- Levers: `src/solution/params.json` fields `x`, `y` (bounds |v| <= 10); `algorithm` label is metadata.",
    "- Constraints: schema-validated by the correctness check; scores only comparable via the benchmark.",
    "- Competitor intel: leaderboard notes suggest coordinate descent converging near (3, -1).",
    "",
    "## Verification scheme",
    "- Correctness: fast schema/bounds check (distinct from perf).",
    "- Performance: benchmark writes score.json; lower is better.",
    "",
    "## Loop log",
  ].join("\n");
}
