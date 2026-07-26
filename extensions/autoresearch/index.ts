import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoresearchCommand } from "./commands.ts";
import { registerNotesTool } from "./notes-tool.ts";
import { registerTaskboardTool } from "./taskboard-tool.ts";

/**
 * kydoresearch: a harness for yukon AutoResearch challenges
 * (www.ecdsa.fail, mlx.fast). Professor proposes ideas, parallel PhDs
 * implement them in isolated worktrees, local verify/bench gate submissions,
 * and after three dry loops the Professor goes to church.
 *
 * Commands: /autoresearch [run|status|steer|inspect|telemetry|config|stop]
 * Tools: taskboard, research_notes
 */
export default function (pi: ExtensionAPI) {
  registerTaskboardTool(pi);
  registerNotesTool(pi);
  const { restoreWidget } = registerAutoresearchCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    restoreWidget(ctx);
  });
}
