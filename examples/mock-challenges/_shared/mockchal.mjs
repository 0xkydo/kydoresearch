#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

function findRepoRoot(start) {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, "benchmark.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      console.error("mockchal: no benchmark.json found");
      process.exit(1);
    }
    current = parent;
  }
}

function flagsFrom(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) continue;
    const next = args[index + 1];
    flags[value.slice(2)] = next && !next.startsWith("--") ? next : true;
    if (flags[value.slice(2)] !== true) index += 1;
  }
  return flags;
}

const repoRoot = findRepoRoot(process.cwd());
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "benchmark.json"), "utf8"),
);
const scenario = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "mock-scenario.json"), "utf8"),
);
const stateDir = path.join(repoRoot, ".mockchal");
const submissionsPath = path.join(stateDir, "submissions.json");

function seedSubmissions() {
  return (scenario.leaderboard ?? []).map((entry, index) => ({
    id: `seed-${String(index + 1).padStart(4, "0")}`,
    score: entry.score,
    author: entry.author,
    note: entry.note,
    promoted: true,
    createdAt: entry.createdAt ?? "2026-07-01T00:00:00.000Z",
  }));
}

function loadSubmissions() {
  if (!fs.existsSync(submissionsPath)) {
    return { submissions: seedSubmissions() };
  }
  return JSON.parse(fs.readFileSync(submissionsPath, "utf8"));
}

function saveSubmissions(data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    submissionsPath,
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

function bestScore(data) {
  const scores = data.submissions
    .filter((entry) => entry.promoted)
    .map((entry) => entry.score);
  if (scores.length === 0) return null;
  return manifest.direction === "+" ? Math.max(...scores) : Math.min(...scores);
}

function improves(score, best) {
  if (best === null) return true;
  return manifest.direction === "+" ? score > best : score < best;
}

const [, , command, ...args] = process.argv;
const flags = flagsFrom(args);

switch (command) {
  case "setup":
    execFileSync("./setup.sh", { cwd: repoRoot, stdio: "inherit" });
    break;
  case "run":
    execFileSync("./benchmark.sh", { cwd: repoRoot, stdio: "inherit" });
    break;
  case "submit": {
    const noteFile = flags["note-file"];
    if (typeof noteFile !== "string") {
      console.error("mockchal submit: --note-file is required");
      process.exit(1);
    }
    const notePath = path.resolve(process.cwd(), noteFile);
    if (
      !fs.existsSync(notePath) ||
      fs.readFileSync(notePath, "utf8").trim() === ""
    ) {
      console.error(`mockchal submit: note file missing or empty: ${noteFile}`);
      process.exit(1);
    }
    const scorePath = path.join(repoRoot, manifest.scorePath);
    if (!fs.existsSync(scorePath)) {
      console.error(`mockchal submit: run the benchmark to create ${manifest.scorePath}`);
      process.exit(1);
    }
    const score = JSON.parse(fs.readFileSync(scorePath, "utf8")).score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      console.error("mockchal submit: benchmark score is not finite");
      process.exit(1);
    }
    const data = loadSubmissions();
    const promoted = improves(score, bestScore(data));
    const id = `sub-${randomBytes(4).toString("hex")}`;
    data.submissions.push({
      id,
      score,
      author: "me",
      note: fs.readFileSync(notePath, "utf8"),
      model: typeof flags.model === "string" ? flags.model : null,
      promoted,
      createdAt: new Date().toISOString(),
    });
    saveSubmissions(data);
    console.log(
      `Submitted ${id} (score ${score}) — ${
        promoted ? "PROMOTED (new best)" : "not promoted"
      }`,
    );
    break;
  }
  case "submissions": {
    const data = loadSubmissions();
    const rows = flags.all
      ? data.submissions
      : data.submissions.filter((entry) => entry.author === "me");
    console.log("ID\tSCORE\tAUTHOR\tPROMOTED\tCREATED");
    for (const entry of rows) {
      console.log(
        `${entry.id}\t${entry.score}\t${entry.author}\t${
          entry.promoted ? "yes" : "no"
        }\t${entry.createdAt}`,
      );
    }
    break;
  }
  case "sync": {
    const best = bestScore(loadSubmissions());
    console.log(
      best === null
        ? "Nothing to sync"
        : `Synced local mock frontier (best score ${best})`,
    );
    break;
  }
  case "config":
    console.log(
      `api: local-only\nchallenge: ${manifest.name}\nstate: ${stateDir}`,
    );
    break;
  default:
    console.error(
      `mockchal: unknown command ${command ?? "(none)"}. ` +
        "Commands: setup run submit submissions sync config",
    );
    process.exit(1);
}
