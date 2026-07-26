import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildStatusSemanticModel,
  renderStatusDashboardLines,
  renderStatusLines,
} from "../../extensions/autoresearch/widget.ts";
import {
  candidateStatusScenario,
  phaseScenarios,
  statusScenario,
  stripTerminalStyles,
  testTheme,
} from "./fixtures.ts";

describe("UI semantic contract matrix", () => {
  it("renders every phase across narrow and wide terminals in light and dark themes", () => {
    for (const report of phaseScenarios()) {
      for (const width of [20, 32, 48, 80, 120]) {
        for (const variant of ["light", "dark"] as const) {
          const lines = renderStatusDashboardLines(
            "mock challenge",
            report,
            width,
            testTheme(variant),
          );
          expect(
            lines.every((line) => visibleWidth(line) <= Math.max(32, width)),
            `${report.phase} at ${width} columns (${variant})`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps TUI and plain/RPC projections aligned on critical facts", () => {
    const report = candidateStatusScenario();
    const semantic = buildStatusSemanticModel("demo", report);
    const plain = renderStatusLines("demo", report).join("\n");
    const styled = stripTerminalStyles(
      renderStatusDashboardLines("demo", report, 160, testTheme()).join("\n"),
    );

    for (const fact of [
      semantic.challengeName,
      semantic.phaseLabel.toUpperCase(),
      semantic.localScore,
      semantic.submittedScore,
      semantic.directionLabel,
      ...semantic.candidateIds,
    ]) {
      expect(plain, `plain projection missing ${fact}`).toContain(fact);
      expect(styled, `styled projection missing ${fact}`).toContain(fact);
    }
    expect(plain).toContain("/autoresearch steer <direction>");
    expect(styled).toContain("/autoresearch steer <direction>");
    expect(plain).toContain("/autoresearch inspect <candidate>");
    expect(styled).toContain("/autoresearch inspect <candidate>");
  });

  it("sanitizes Unicode, multiline, long-path, ANSI, OSC, and control-character input", () => {
    const report = statusScenario({
      ideas: [{
        id: "L004-I1",
        title: "multiline\nタイトル \u001b[31mred\u001b[0m \u001b]52;c;secret\u0007 \u0000",
        parentCandidateId: "baseline",
        status: "failed",
        verifyAttempts: 3,
        lastVerifyError: "/very/long/".repeat(30) + "\u0001failure",
      }],
    });
    const plain = renderStatusLines("\u001b]0;owned\u0007 demo", report).join("\n");
    const styled = stripTerminalStyles(
      renderStatusDashboardLines(
        "\u001b]0;owned\u0007 demo",
        report,
        80,
        testTheme(),
      ).join("\n"),
    );

    for (const rendered of [plain, styled]) {
      expect(rendered).not.toContain("secret");
      expect(rendered).not.toContain("owned");
      expect(rendered).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      expect(rendered).toContain("タイトル");
    }
  });
});
