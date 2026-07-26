import { describe, expect, it } from "vitest";
import { nodeExec } from "../src/exec.ts";

describe("nodeExec", () => {
  it("streams stdout and stderr before the command exits", async () => {
    const chunks: Array<{ chunk: string; stream: "stdout" | "stderr" }> = [];
    let sawBoth!: () => void;
    const bothStreams = new Promise<void>((resolve) => {
      sawBoth = resolve;
    });
    let settled = false;

    const running = nodeExec(
      process.execPath,
      [
        "-e",
        [
          'process.stdout.write("stdout-now\\n");',
          'process.stderr.write("stderr-now\\n");',
          "setTimeout(() => process.exit(0), 250);",
        ].join(""),
      ],
      {
        timeout: 2_000,
        onOutput: (chunk, stream) => {
          chunks.push({ chunk, stream });
          if (chunks.some((item) => item.stream === "stdout") && chunks.some((item) => item.stream === "stderr")) {
            sawBoth();
          }
        },
      },
    );
    void running.finally(() => {
      settled = true;
    });

    await Promise.race([
      bothStreams,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("output was not streamed")), 1_000)),
    ]);

    expect(settled).toBe(false);
    expect(chunks).toEqual(
      expect.arrayContaining([
        { chunk: "stdout-now\n", stream: "stdout" },
        { chunk: "stderr-now\n", stream: "stderr" },
      ]),
    );
    await expect(running).resolves.toMatchObject({ code: 0 });
  });

  it("classifies process timeout separately from a normal nonzero exit", async () => {
    const result = await nodeExec(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeout: 50 },
    );

    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(true);
  });
});
