import type { RolesConfig } from "../config.ts";
import type { AgentResult, AgentRunner, AgentTask } from "./types.ts";

/**
 * v2: spawns `pi --mode json -p` subprocesses per role, with model/thinking
 * from RolesConfig and role prompts from extensions/autoresearch/prompts/.
 *
 * Interface-complete stub in v1. Implementation will crib the spawn/JSON-event
 * parse loop from the bundled pi subagent example:
 *   /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts
 */
export class PiSubprocessRunner implements AgentRunner {
  constructor(private readonly roles: RolesConfig) {}

  run(_task: AgentTask): Promise<AgentResult> {
    throw new Error(
      'runner "subprocess" is a v2 feature. Set runner to "mock" in .autoresearch/config.json, ' +
        "or wait for the release that ships real pi subprocess agents.",
    );
  }
}
