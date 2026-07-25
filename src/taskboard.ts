import { statePaths } from "./state.ts";
import { atomicWriteJson, Mutex, readJsonIfExists } from "./util.ts";

export type TaskStatus = "open" | "in-progress" | "done" | "cancelled";

export interface BoardTask {
  id: number;
  title: string;
  status: TaskStatus;
  role?: string; // which role created/owns it
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface BoardFile {
  nextId: number;
  tasks: BoardTask[];
}

const boardMutex = new Mutex();

function load(stateDir: string): BoardFile {
  return readJsonIfExists<BoardFile>(statePaths(stateDir).taskboard) ?? { nextId: 1, tasks: [] };
}

/** Shared cross-agent todo board persisted at .autoresearch/taskboard.json.
 * Mutations are serialized through an in-process mutex + atomic writes. */
export class Taskboard {
  constructor(private readonly stateDir: string) {}

  list(): BoardTask[] {
    return load(this.stateDir).tasks;
  }

  openCount(): number {
    return this.list().filter((t) => t.status === "open" || t.status === "in-progress").length;
  }

  async add(title: string, opts: { role?: string; note?: string } = {}): Promise<BoardTask> {
    return boardMutex.runExclusive(async () => {
      const board = load(this.stateDir);
      const now = new Date().toISOString();
      const task: BoardTask = {
        id: board.nextId,
        title,
        status: "open",
        role: opts.role,
        note: opts.note,
        createdAt: now,
        updatedAt: now,
      };
      board.nextId += 1;
      board.tasks.push(task);
      atomicWriteJson(statePaths(this.stateDir).taskboard, board);
      return task;
    });
  }

  async update(id: number, patch: { status?: TaskStatus; note?: string; title?: string }): Promise<BoardTask> {
    return boardMutex.runExclusive(async () => {
      const board = load(this.stateDir);
      const task = board.tasks.find((t) => t.id === id);
      if (!task) throw new Error(`taskboard: no task with id ${id}`);
      if (patch.status) task.status = patch.status;
      if (patch.note !== undefined) task.note = patch.note;
      if (patch.title !== undefined) task.title = patch.title;
      task.updatedAt = new Date().toISOString();
      atomicWriteJson(statePaths(this.stateDir).taskboard, board);
      return task;
    });
  }
}
