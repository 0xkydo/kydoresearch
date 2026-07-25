import * as fs from "node:fs";
import * as path from "node:path";

export type AdviceSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
  severity: AdviceSeverity;
  text: string;
}

export interface WatchdogRule {
  if: string; // condition, e.g. "dryLoopStreak >= 2" or a boolean flag name
  severity: AdviceSeverity;
  text: string;
}

export interface WatchdogConfig {
  severityThreshold: AdviceSeverity;
  rules: WatchdogRule[];
}

const SEVERITY_ORDER: Record<AdviceSeverity, number> = { nit: 0, concern: 1, blocker: 2 };

const DEFAULT_RULES: WatchdogRule[] = [
  { if: "dryLoopStreak >= 2", severity: "concern", text: "Multiple dry loops; consider changing idea family." },
  { if: "ideaFailed", severity: "nit", text: "Verify failures are burning attempts; re-read the correctness contract." },
  { if: "submitted", severity: "nit", text: "Confirm the leaderboard reflects the new submission." },
];

/**
 * Parse a WATCHDOG.md file. Loose format:
 *   severity-threshold: nit
 *   rules:
 *   - if: <condition>
 *     severity: nit|concern|blocker
 *     text: "..."
 * Falls back to built-in default rules when the file is missing or has none.
 */
export function loadWatchdog(repoRoot: string, watchdogFile: string): WatchdogConfig {
  const filePath = path.join(repoRoot, watchdogFile);
  if (!fs.existsSync(filePath)) {
    return { severityThreshold: "nit", rules: DEFAULT_RULES };
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  let severityThreshold: AdviceSeverity = "nit";
  const rules: WatchdogRule[] = [];
  let current: Partial<WatchdogRule> | null = null;

  const flush = () => {
    if (current?.if && current.severity && current.text) rules.push(current as WatchdogRule);
    current = null;
  };

  for (const line of lines) {
    const thresholdMatch = line.match(/^severity-threshold:\s*(nit|concern|blocker)\s*$/);
    if (thresholdMatch) {
      severityThreshold = thresholdMatch[1] as AdviceSeverity;
      continue;
    }
    const ifMatch = line.match(/^-\s*if:\s*(.+?)\s*$/);
    if (ifMatch) {
      flush();
      current = { if: ifMatch[1] };
      continue;
    }
    const severityMatch = line.match(/^\s+severity:\s*(nit|concern|blocker)\s*$/);
    if (severityMatch && current) {
      current.severity = severityMatch[1] as AdviceSeverity;
      continue;
    }
    const textMatch = line.match(/^\s+text:\s*"?(.+?)"?\s*$/);
    if (textMatch && current) {
      current.text = textMatch[1];
    }
  }
  flush();

  return { severityThreshold, rules: rules.length > 0 ? rules : DEFAULT_RULES };
}

export function filterByThreshold(notes: AdvisorNote[], threshold: AdviceSeverity): AdvisorNote[] {
  return notes.filter((n) => SEVERITY_ORDER[n.severity] >= SEVERITY_ORDER[threshold]);
}

export function hasBlocker(notes: AdvisorNote[]): boolean {
  return notes.some((n) => n.severity === "blocker");
}
