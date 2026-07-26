import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR_NAME, statePaths } from "../../src/state.ts";

const MAX_NOTE_CHARS = 20_000;

/** Read/append research notes and the knowledge base from the interactive session. */
export function registerNotesTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "research_notes",
    label: "Research Notes",
    description:
      "Access autoresearch artifacts in .autoresearch/: list notes, read a note (name required), " +
      "read the knowledge base, or append to the knowledge base (text required).",
    promptSnippet: "List/read autoresearch notes and knowledge base",
    parameters: Type.Object({
      action: StringEnum(["list", "read", "read-kb", "append-kb"] as const),
      name: Type.Optional(Type.String({ description: "Note filename, e.g. church-005.md" })),
      text: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const stateDir = path.join(ctx.cwd, STATE_DIR_NAME);
      const paths = statePaths(stateDir);
      switch (params.action) {
        case "list": {
          const notes = fs.existsSync(paths.notesDir) ? fs.readdirSync(paths.notesDir).sort() : [];
          return {
            content: [{ type: "text" as const, text: notes.length ? notes.join("\n") : "No notes yet." }],
            details: { notes },
          };
        }
        case "read": {
          if (!params.name) throw new Error("research_notes read requires a name");
          const file = path.join(paths.notesDir, path.basename(params.name));
          if (!fs.existsSync(file)) throw new Error(`No such note: ${params.name}`);
          const text = fs.readFileSync(file, "utf8").slice(0, MAX_NOTE_CHARS);
          return { content: [{ type: "text" as const, text }], details: {} };
        }
        case "read-kb": {
          if (!fs.existsSync(paths.knowledgeBase)) throw new Error("No knowledge base; run /autoresearch first.");
          const kb = fs.readFileSync(paths.knowledgeBase, "utf8");
          const text = kb.length > MAX_NOTE_CHARS ? `${kb.slice(0, MAX_NOTE_CHARS)}\n\n[truncated]` : kb;
          return { content: [{ type: "text" as const, text }], details: {} };
        }
        case "append-kb": {
          if (!params.text) throw new Error("research_notes append-kb requires text");
          fs.appendFileSync(paths.knowledgeBase, `\n${params.text}\n`);
          return { content: [{ type: "text" as const, text: "Appended to knowledge base." }], details: {} };
        }
      }
    },
  });
}
