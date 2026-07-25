/** Top-level orchestrator phases. Idea-level progress lives in Idea.status. */
export type Phase =
  | "uninitialized"
  | "init.setup"
  | "init.knowledge"
  | "ready"
  | "loop.syncing"
  | "loop.proposing"
  | "loop.ideas" // parallel idea pipelines in flight
  | "loop.finalizing" // winner selection + apply to main repo + submit
  | "loop.end"
  | "god"
  | "paused"
  | "done";

export type IdeaStatus =
  | "proposed"
  | "implementing"
  | "verifying"
  | "benching"
  | "failed" // verify failed maxVerifyAttempts times
  | "done-no-improvement"
  | "done-superseded" // improved locally but another idea won the loop
  | "done-improved"; // loop winner, applied + submitted

export const TERMINAL_IDEA_STATUSES: ReadonlySet<IdeaStatus> = new Set([
  "failed",
  "done-no-improvement",
  "done-superseded",
  "done-improved",
]);

export function isIdeaTerminal(status: IdeaStatus): boolean {
  return TERMINAL_IDEA_STATUSES.has(status);
}
