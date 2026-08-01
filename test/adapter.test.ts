import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YukonCliAdapter } from "../src/challenge/adapter.ts";
import { detectCli, isInsideEditablePaths, readManifest } from "../src/challenge/detect.ts";
import type { ExecOptions, ExecPort } from "../src/exec.ts";
import { nodeExec } from "../src/exec.ts";
import { makeTmpChallenge } from "./helpers/tmp-challenge.ts";

describe("YukonCliAdapter against mockchal", () => {
  let repoRoot: string;
  let cleanup: () => void;
  let adapter: YukonCliAdapter;

  beforeEach(() => {
    ({ repoRoot, cleanup } = makeTmpChallenge());
    const manifest = readManifest(repoRoot);
    adapter = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: detectCli(repoRoot, manifest),
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      exec: nodeExec,
    });
  });

  afterEach(() => cleanup());

  it("detects manifest and repo-local CLI", () => {
    const manifest = readManifest(repoRoot);
    expect(manifest.name).toBe("mock-challenge");
    expect(manifest.direction).toBe("-");
    expect(detectCli(repoRoot, manifest)).toBe("./bin/mockchal");
  });

  it("handles the ecdsafail argv-command manifest and ecadd challenge name", () => {
    fs.writeFileSync(
      path.join(repoRoot, "benchmark.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          name: "ecadd-challenge-test",
          description: "Optimize reversible elliptic-curve point addition.",
          category: "rust",
          direction: "-",
          editablePaths: ["src/point_add"],
          setupCommand: ["bash", "-lc", "./setup.sh"],
          benchmarkCommand: ["bash", "-lc", "./benchmark.sh"],
          scorePath: "score.json",
        },
        null,
        2,
      ),
    );

    const manifest = readManifest(repoRoot);
    expect(manifest).toMatchObject({
      name: "ecadd-challenge-test",
      direction: "-",
      editablePaths: ["src/point_add"],
      setupCommand: "bash -lc ./setup.sh",
      benchmarkCommand: "bash -lc ./benchmark.sh",
      scorePath: "score.json",
    });
    expect(detectCli(repoRoot, manifest)).toBe("ecdsafail");
  });

  it("editablePaths guard works", () => {
    expect(isInsideEditablePaths(".autoresearch", ["src/solution/"])).toBe(false);
    expect(isInsideEditablePaths("src/solution/params.json", ["src/solution/"])).toBe(true);
    expect(isInsideEditablePaths("src/solution", ["src/solution/"])).toBe(true);
  });

  it("setup → verify → bench round trip", async () => {
    expect((await adapter.setup()).ok).toBe(true);
    expect((await adapter.verify()).ok).toBe(true);
    const bench = await adapter.bench();
    expect(bench.ok).toBe(true);
    expect(bench.score).toBe(10); // baseline (0,0)
  });

  it("applies phase timeouts and appends live command output to inspectable logs", async () => {
    const manifest = readManifest(repoRoot);
    const seen: Array<{ command: string; timeout: number | undefined }> = [];
    const logDir = path.join(repoRoot, ".autoresearch", "logs");
    const exec: ExecPort = async (_cmd, args, opts) => {
      const command = args[1] ?? "";
      seen.push({ command, timeout: opts?.timeout });
      const onOutput = (
        opts as ExecOptions & {
          onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
        }
      )?.onOutput;
      onOutput?.(`${command}: stdout\n`, "stdout");
      onOutput?.(`${command}: stderr\n`, "stderr");
      if (command === "./benchmark.sh") {
        fs.writeFileSync(path.join(opts?.cwd ?? repoRoot, manifest.scorePath), JSON.stringify({ score: 7 }));
      }
      return { stdout: "captured stdout", stderr: "captured stderr", code: 0 };
    };
    const loggedAdapter = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: null,
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      exec,
      execution: {
        setupTimeoutMs: 111,
        verifyTimeoutMs: 222,
        benchmarkTimeoutMs: 333,
      },
      logDir,
    });

    await loggedAdapter.setup();
    await loggedAdapter.verify();
    await loggedAdapter.bench();
    await loggedAdapter.bench();
    const candidateVerifyLog = path.join(repoRoot, ".autoresearch", "runs", "L001-I1", "logs", "verify.log");
    const candidateBenchLog = path.join(repoRoot, ".autoresearch", "runs", "L001-I1", "logs", "benchmark.log");
    await loggedAdapter.verify(repoRoot, undefined, candidateVerifyLog);
    await loggedAdapter.bench(repoRoot, undefined, candidateBenchLog);

    expect(seen.map(({ command, timeout }) => [command, timeout])).toEqual([
      ["./setup.sh", 111],
      ["./verify.sh", 222],
      ["./benchmark.sh", 333],
      ["./benchmark.sh", 333],
      ["./verify.sh", 222],
      ["./benchmark.sh", 333],
    ]);
    expect(fs.readFileSync(path.join(logDir, "setup.log"), "utf8")).toContain("./setup.sh: stdout");
    expect(fs.readFileSync(path.join(logDir, "verify.log"), "utf8")).toContain("./verify.sh: stderr");
    const benchmarkLog = fs.readFileSync(path.join(logDir, "benchmark.log"), "utf8");
    expect(benchmarkLog.match(/\$ \.\/benchmark\.sh/g)).toHaveLength(2);
    expect(benchmarkLog).toContain("./benchmark.sh: stdout");
    expect(fs.readFileSync(candidateVerifyLog, "utf8")).toContain("./verify.sh: stdout");
    expect(fs.readFileSync(candidateBenchLog, "utf8")).toContain("./benchmark.sh: stderr");
  });

  it("verify fails before setup (marker missing)", async () => {
    const result = await adapter.verify();
    expect(result.ok).toBe(false);
    expect(result.raw).toContain("setup has not been run");
    expect(result.failureKind).toBe("command-exit");
  });

  it("classifies missing and malformed benchmark score artifacts", async () => {
    const manifest = readManifest(repoRoot);
    const missing = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: null,
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    expect((await missing.bench()).failureKind).toBe("score-file-missing");

    const invalidJson = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: null,
      exec: async (_cmd, _args, opts) => {
        fs.writeFileSync(path.join(opts?.cwd ?? repoRoot, manifest.scorePath), "{");
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect((await invalidJson.bench()).failureKind).toBe("score-json-invalid");

    const invalidScore = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: null,
      exec: async (_cmd, _args, opts) => {
        fs.writeFileSync(
          path.join(opts?.cwd ?? repoRoot, manifest.scorePath),
          JSON.stringify({ score: "fast" }),
        );
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect((await invalidScore.bench()).failureKind).toBe("score-value-invalid");
  });

  it("submit requires note file and records submission; leaderboard parses", async () => {
    await adapter.setup();
    await adapter.bench();

    const badSubmit = await adapter.submit({ noteFile: path.join(repoRoot, "nonexistent.md") });
    expect(badSubmit.ok).toBe(false);

    const noteFile = path.join(repoRoot, ".autoresearch", "note.md");
    fs.mkdirSync(path.dirname(noteFile), { recursive: true });
    fs.writeFileSync(noteFile, "Baseline submission.");
    const submit = await adapter.submit({ noteFile });
    expect(submit.ok).toBe(true);
    expect(submit.submissionId).toMatch(/^sub-/);
    expect(submit.promoted).toBe(true); // 10 beats seeded best of 18

    const all = await adapter.listSubmissions(true);
    expect(all.length).toBe(3); // 2 seeds + ours
    const mine = await adapter.listSubmissions(false);
    expect(mine.length).toBe(1);
    expect(mine[0]!.score).toBe(10);

    expect((await adapter.sync()).ok).toBe(true);
  });

  it("parses queued mlxfast submissions and their asynchronous review states", async () => {
    const manifest = readManifest(repoRoot);
    const submissionId = "019fba1d-d5eb-7633-b93f-f713966c02a7";
    const exec: ExecPort = async (_cmd, args) => {
      const command = args[1] ?? "";
      if (/\bsubmit\b/.test(command.replaceAll('"', ""))) {
        return {
          stdout: [
            "Submission queued",
            "benchmark   eigenlabs/mlxfast-challenge",
            `submission  ${submissionId}`,
            "status      validating",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      if (command.includes(" submissions")) {
        return {
          stdout: [
            "MLX Fast submissions",
            "submission  solver  status         score  metrics        diff  commit   created",
            "----------  ------  -------------  -----  -------------  ----  -------  ----------------",
            "019fba1     me      validating     n/a    n/a            n/a   1234567  7/31/26, 9:00 AM",
            "029fba2     me      rejected       n/a    verifier fail  n/a   2345678  7/31/26, 9:01 AM",
            "039fba3     me      promoted       1.25   {\"ok\":true}    -0.5  3456789  7/31/26, 9:02 AM",
            "049fba4     me      not promoted   1.5    {\"ok\":true}    0     4567890  7/31/26, 9:03 AM",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const currentAdapter = new YukonCliAdapter({
      repoRoot,
      manifest,
      cli: "mlxfast",
      verifyCommand: "./verify.sh",
      benchCommand: "./benchmark.sh",
      exec,
    });
    const noteFile = path.join(repoRoot, "submission-note.md");
    fs.writeFileSync(noteFile, "Detailed submission note.");

    await expect(currentAdapter.submit({ noteFile, model: "GPT-5.6" })).resolves.toMatchObject({
      ok: true,
      submissionId,
      status: "pending",
      promoted: false,
    });
    await expect(currentAdapter.listSubmissions(true)).resolves.toEqual([
      {
        id: "019fba1",
        score: null,
        author: "me",
        status: "pending",
        rawStatus: "validating",
        metrics: undefined,
        promoted: false,
        createdAt: "7/31/26, 9:00 AM",
      },
      {
        id: "029fba2",
        score: null,
        author: "me",
        status: "rejected",
        rawStatus: "rejected",
        metrics: "verifier fail",
        promoted: false,
        createdAt: "7/31/26, 9:01 AM",
      },
      {
        id: "039fba3",
        score: 1.25,
        author: "me",
        status: "accepted",
        rawStatus: "promoted",
        metrics: '{"ok":true}',
        promoted: true,
        createdAt: "7/31/26, 9:02 AM",
      },
      {
        id: "049fba4",
        score: 1.5,
        author: "me",
        status: "accepted",
        rawStatus: "not promoted",
        metrics: '{"ok":true}',
        promoted: false,
        createdAt: "7/31/26, 9:03 AM",
      },
    ]);
  });
});
