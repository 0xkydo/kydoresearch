import * as fs from "node:fs";
import * as path from "node:path";
import type { ProposedIdea } from "./types.ts";

export const MOCK_SCENARIO_FILE = "mock-scenario.json";

export interface MockScenarioIdea {
  title: string;
  spec: string;
  attempts: unknown[];
}

export interface MockScenario {
  schemaVersion: 1;
  subjectArea: string;
  solutionPath: string;
  knowledge: {
    objective: string;
    levers: string[];
    constraints: string[];
    competitorIntel: string[];
    verification: string[];
  };
  loops: Record<string, MockScenarioIdea[]>;
  defaultIdea: MockScenarioIdea;
  churchConversation: string;
}

/**
 * Load the optional declarative playlist used by the hands-on mock examples.
 * The original fixture deliberately has no playlist and continues through the
 * legacy hard-coded scenario below.
 */
export function loadMockScenario(repoRoot: string): MockScenario | null {
  const scenarioPath = path.join(repoRoot, MOCK_SCENARIO_FILE);
  if (!fs.existsSync(scenarioPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${MOCK_SCENARIO_FILE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return validateMockScenario(parsed);
}

export function mockScenarioProposals(
  scenario: MockScenario,
  loop: number,
): ProposedIdea[] {
  const ideas = scenario.loops[String(loop)] ?? [scenario.defaultIdea];
  return ideas.map(({ title, spec }) => ({ title, spec }));
}

export function mockScenarioEdit(
  scenario: MockScenario,
  loop: number,
  ideaIndex: number,
  attempt: number,
): unknown {
  const ideas = scenario.loops[String(loop)] ?? [scenario.defaultIdea];
  const idea = ideas[ideaIndex];
  if (!idea) {
    throw new Error(
      `${MOCK_SCENARIO_FILE} has no idea ${ideaIndex + 1} for loop ${loop}`,
    );
  }
  return idea.attempts[Math.min(Math.max(attempt - 1, 0), idea.attempts.length - 1)];
}

export function mockScenarioKnowledgeBase(
  scenario: MockScenario,
  manifestName: string,
): string {
  return [
    `# Knowledge base: ${manifestName}`,
    "",
    "## Subject area",
    scenario.subjectArea,
    "",
    "## Contextual graph",
    `- Objective: ${scenario.knowledge.objective}`,
    ...scenario.knowledge.levers.map((entry) => `- Lever: ${entry}`),
    ...scenario.knowledge.constraints.map((entry) => `- Constraint: ${entry}`),
    ...scenario.knowledge.competitorIntel.map(
      (entry) => `- Competitor intel: ${entry}`,
    ),
    "",
    "## Verification scheme",
    ...scenario.knowledge.verification.map((entry) => `- ${entry}`),
    "",
    "## Loop log",
  ].join("\n");
}

export function mockScenarioNote(
  scenario: MockScenario,
  ideaTitle: string,
  score: number | undefined,
  best: number | null,
): string {
  return [
    `# Hypothesis note: ${ideaTitle}`,
    "",
    `Local score: ${score ?? "n/a"} (current best: ${best ?? "none"}).`,
    "",
    "## Interpretation",
    `This ${scenario.subjectArea.toLowerCase()} experiment did not clear the current frontier.`,
    "Treat the verifier and benchmark logs as the source of truth, then change",
    "one lever or test a different mechanism in the next loop.",
  ].join("\n");
}

function validateMockScenario(value: unknown): MockScenario {
  const scenario = record(value, MOCK_SCENARIO_FILE);
  if (scenario.schemaVersion !== 1) {
    throw new Error(`${MOCK_SCENARIO_FILE} schemaVersion must be 1`);
  }
  const solutionPath = nonEmptyString(
    scenario.solutionPath,
    `${MOCK_SCENARIO_FILE}.solutionPath`,
  );
  if (
    path.isAbsolute(solutionPath) ||
    solutionPath === "." ||
    solutionPath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `${MOCK_SCENARIO_FILE}.solutionPath must stay inside the challenge repository`,
    );
  }

  const knowledge = record(
    scenario.knowledge,
    `${MOCK_SCENARIO_FILE}.knowledge`,
  );
  const rawLoops = record(scenario.loops, `${MOCK_SCENARIO_FILE}.loops`);
  const loops = Object.fromEntries(
    Object.entries(rawLoops).map(([loop, ideas]) => {
      if (!/^[1-9]\d*$/.test(loop)) {
        throw new Error(`${MOCK_SCENARIO_FILE}.loops keys must be positive integers`);
      }
      if (!Array.isArray(ideas) || ideas.length === 0) {
        throw new Error(`${MOCK_SCENARIO_FILE}.loops.${loop} must contain ideas`);
      }
      return [
        loop,
        ideas.map((idea, index) =>
          mockScenarioIdea(
            idea,
            `${MOCK_SCENARIO_FILE}.loops.${loop}[${index}]`,
          ),
        ),
      ];
    }),
  );

  return {
    schemaVersion: 1,
    subjectArea: nonEmptyString(
      scenario.subjectArea,
      `${MOCK_SCENARIO_FILE}.subjectArea`,
    ),
    solutionPath,
    knowledge: {
      objective: nonEmptyString(
        knowledge.objective,
        `${MOCK_SCENARIO_FILE}.knowledge.objective`,
      ),
      levers: stringArray(
        knowledge.levers,
        `${MOCK_SCENARIO_FILE}.knowledge.levers`,
      ),
      constraints: stringArray(
        knowledge.constraints,
        `${MOCK_SCENARIO_FILE}.knowledge.constraints`,
      ),
      competitorIntel: stringArray(
        knowledge.competitorIntel,
        `${MOCK_SCENARIO_FILE}.knowledge.competitorIntel`,
      ),
      verification: stringArray(
        knowledge.verification,
        `${MOCK_SCENARIO_FILE}.knowledge.verification`,
      ),
    },
    loops,
    defaultIdea: mockScenarioIdea(
      scenario.defaultIdea,
      `${MOCK_SCENARIO_FILE}.defaultIdea`,
    ),
    churchConversation: nonEmptyString(
      scenario.churchConversation,
      `${MOCK_SCENARIO_FILE}.churchConversation`,
    ),
  };
}

function mockScenarioIdea(value: unknown, label: string): MockScenarioIdea {
  const idea = record(value, label);
  if (!Array.isArray(idea.attempts) || idea.attempts.length === 0) {
    throw new Error(`${label}.attempts must contain at least one file value`);
  }
  return {
    title: nonEmptyString(idea.title, `${label}.title`),
    spec: nonEmptyString(idea.spec, `${label}.spec`),
    attempts: idea.attempts,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.trim() !== "")
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

/**
 * Deterministic playlist for the fixture challenge (baseline score 10 at (0,0);
 * optimum 0 at (3,-1); direction "-"). Designed so a 6-loop run exercises every
 * transition:
 *
 *   L1-I1  invalid edit every attempt        -> verify fails 3x -> failed
 *   L1-I2  valid but worse (34)              -> done-no-improvement (streak 1)
 *   L2-I1  invalid attempt 1, fixed on 2 (2) -> retry-then-pass, loop winner -> submit
 *   L2-I2  valid improvement (4)             -> done-superseded (I1 wins; streak 0)
 *   L3-L5  baseline replays (10)             -> dry loops, streak 1..3 -> church after L5
 *   L6     analytic optimum (0)              -> improvement -> submit (church reset proven)
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

export function scriptedChurchConversation(loop: number, streak: number): string {
  return [
    `# The Professor goes to church (after loop ${loop}, ${streak} dry loops)`,
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
