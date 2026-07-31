import * as fs from "node:fs";
import * as path from "node:path";
import {
  candidateRunPaths,
  readLedger,
} from "../../src/archive.ts";
import type {
  CandidateIntegrityV1,
  CandidateMetricsV1,
  CandidateProposalV1,
} from "../../src/experiments.ts";
import type { LoopState } from "../../src/state.ts";
import { readJsonIfExists } from "../../src/util.ts";

export function renderCandidateInspection(
  repoRoot: string,
  stateDir: string,
  state: LoopState,
  candidateId: string,
): string {
  let paths: ReturnType<typeof candidateRunPaths>;
  try {
    paths = candidateRunPaths(stateDir, candidateId);
  } catch {
    return `Invalid candidate ID "${candidateId}". Use an ID such as L003-I2.`;
  }

  const idea = state.ideas.find((candidate) => candidate.id === candidateId);
  const ledger = readLedger(stateDir).find((entry) => entry.candidateId === candidateId);
  const proposal = readJsonIfExists<CandidateProposalV1>(paths.proposal);
  const metrics = readJsonIfExists<CandidateMetricsV1>(paths.metrics);
  const integrity = readJsonIfExists<CandidateIntegrityV1>(paths.integrity);
  if (!idea && !ledger && !proposal && !fs.existsSync(paths.root)) {
    return `Candidate "${candidateId}" was not found. Run /autoresearch inspect to list known candidates.`;
  }

  const title = idea?.title ?? proposal?.title ?? ledger?.title ?? "untitled candidate";
  const status = idea?.status ?? metrics?.terminalStatus ?? ledger?.terminalStatus ?? "archived";
  const parent =
    idea?.parentCandidateId ??
    proposal?.parentCandidateId ??
    ledger?.parentCandidateId ??
    "unknown";
  const comparisonScore = idea?.comparisonScore ?? metrics?.comparisonScore ?? ledger?.comparisonScore;
  const score = idea?.localScore ?? metrics?.score ?? ledger?.score;
  const lines = [
    `${candidateId} · ${title}`,
    `Status: ${status} · parent: ${parent}` +
      (idea ? ` · verification attempts completed: ${idea.verifyAttempts}` : ""),
  ];

  if (proposal) {
    lines.push(
      `Search: ${proposal.searchMode} · edit family: ${proposal.editFamily}`,
      `Observation: ${oneLine(proposal.observation)}`,
      `Hypothesis: ${oneLine(proposal.hypothesis)}`,
      `Intervention: ${oneLine(proposal.intervention)}`,
      `Expected result: ${oneLine(proposal.expectedResult)}`,
      `Falsified when: ${oneLine(proposal.falsifiedWhen)}`,
    );
    if (proposal.risks.length > 0) lines.push(`Risks: ${proposal.risks.map(oneLine).join(" · ")}`);
    if (proposal.evidenceRefs.length > 0) {
      lines.push(`Evidence used: ${proposal.evidenceRefs.join(" · ")}`);
    }
  }

  if (score !== undefined || comparisonScore !== undefined) {
    lines.push(`Result: score ${score ?? "—"} · comparison ${comparisonScore ?? "—"}`);
  }
  if (integrity) {
    lines.push(
      `Integrity: ${integrity.passed ? "passed" : "failed"} · ${integrity.changedFiles.length} changed file(s)` +
        (integrity.unexpectedFiles.length > 0
          ? ` · ${integrity.unexpectedFiles.length} unexpected`
          : ""),
    );
  }
  const failure = idea?.lastVerifyError ?? metrics?.failure;
  if (failure) lines.push(`Last failure: ${oneLine(failure)}`);

  lines.push(
    "Evidence:",
    ...[
      paths.proposal,
      paths.diff,
      paths.metrics,
      paths.integrity,
      paths.postmortem,
      paths.verifyLog,
      paths.benchmarkLog,
      paths.agentEvents,
      paths.agentFinal,
    ].map((file) => `  ${displayPath(repoRoot, file)}${fs.existsSync(file) ? "" : " (pending)"}`),
  );
  return lines.join("\n");
}

export function renderCandidateList(stateDir: string, state: LoopState): string {
  const current = state.ideas.map((idea) => ({
    id: idea.id,
    title: idea.title,
    status: idea.status,
  }));
  const archived = readLedger(stateDir)
    .filter((entry) => !current.some((candidate) => candidate.id === entry.candidateId))
    .slice(-8)
    .reverse()
    .map((entry) => ({
      id: entry.candidateId,
      title: entry.title,
      status: entry.terminalStatus,
    }));
  const candidates = [...current, ...archived];
  if (candidates.length === 0) {
    return "No candidates yet. The Professor will create them during loop.proposing.";
  }
  return [
    "Candidates (current loop first):",
    ...candidates.map(
      (candidate) => `  ${candidate.id} · ${candidate.status} · ${oneLine(candidate.title)}`,
    ),
    "Run /autoresearch inspect <candidate-id> for its hypothesis, result, and evidence paths.",
  ].join("\n");
}

function displayPath(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file) || path.basename(file);
}

function oneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 179)}…`;
}
