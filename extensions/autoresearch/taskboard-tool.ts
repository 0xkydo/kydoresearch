import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as path from "node:path";
import { STATE_DIR_NAME } from "../../src/state.ts";
import { Taskboard } from "../../src/taskboard.ts";

/**
 * Cross-agent todo board. Pi has no built-in todo tool; professor/PhD
 * subprocess agents (v2) and the interactive session share this board via
 * .autoresearch/taskboard.json.
 */
export function registerTaskboardTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "taskboard",
    label: "Taskboard",
    description:
      "Shared autoresearch task board (persisted in .autoresearch/taskboard.json). " +
      "Actions: list, add (title required), update (id required; status open|in-progress|done|cancelled, note).",
    promptSnippet: "List/add/update shared autoresearch tasks",
    promptGuidelines: [
      "Use taskboard to coordinate multi-step autoresearch work instead of ad-hoc notes.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "add", "update"] as const),
      title: Type.Optional(Type.String()),
      id: Type.Optional(Type.Number()),
      status: Type.Optional(StringEnum(["open", "in-progress", "done", "cancelled"] as const)),
      note: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const board = new Taskboard(path.join(ctx.cwd, STATE_DIR_NAME));
      switch (params.action) {
        case "list": {
          const tasks = board.list();
          const text =
            tasks.length === 0
              ? "Taskboard empty."
              : tasks.map((t) => `#${t.id} [${t.status}] ${t.title}${t.role ? ` (${t.role})` : ""}${t.note ? ` — ${t.note}` : ""}`).join("\n");
          return { content: [{ type: "text" as const, text }], details: { tasks } };
        }
        case "add": {
          if (!params.title) throw new Error("taskboard add requires a title");
          const task = await board.add(params.title, { role: params.role, note: params.note });
          return { content: [{ type: "text" as const, text: `Added #${task.id}: ${task.title}` }], details: { task } };
        }
        case "update": {
          if (params.id === undefined) throw new Error("taskboard update requires an id");
          const task = await board.update(params.id, { status: params.status, note: params.note, title: params.title });
          return { content: [{ type: "text" as const, text: `Updated #${task.id} [${task.status}] ${task.title}` }], details: { task } };
        }
      }
    },
  });
}
