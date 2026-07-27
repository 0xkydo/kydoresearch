import type {
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  ResearchEditor,
  type ResearchNavigationAction,
} from "../../extensions/autoresearch/research-editor.ts";

describe("ResearchEditor", () => {
  it("navigates agents in NAV without mutating composer text", () => {
    const { editor, actions } = makeEditor();

    editor.handleInput("\u001b[B");
    editor.handleInput("\r");
    editor.handleInput("\u001b");

    expect(actions).toEqual([
      { type: "select", direction: 1 },
      { type: "focus" },
      { type: "overview" },
    ]);
    expect(editor.getText()).toBe("");
    expect(editor.getMode()).toBe("nav");
  });

  it("hands the first printable key to the ordinary editor", () => {
    const { editor, modes } = makeEditor();

    editor.handleInput("h");
    editor.handleInput("i");

    expect(editor.getMode()).toBe("type");
    expect(editor.getText()).toBe("hi");
    expect(modes).toEqual(["type"]);
  });

  it("toggles typing with Tab and returns to NAV after submit", () => {
    const { editor, modes } = makeEditor();
    const submitted = vi.fn();
    editor.onSubmit = submitted;

    editor.handleInput("\t");
    editor.handleInput("hello");
    editor.handleInput("\r");

    expect(submitted).toHaveBeenCalledWith("hello");
    expect(editor.getText()).toBe("");
    expect(editor.getMode()).toBe("nav");
    expect(modes).toEqual(["type", "nav"]);
  });

  it("keeps invocation and trace navigation out of the editor buffer", () => {
    const { editor, actions } = makeEditor();

    editor.handleInput("\u001b[D");
    editor.handleInput("\u001b[C");
    editor.handleInput("\u001b[5~");
    editor.handleInput("\u001b[6~");
    editor.handleInput("\u001b[H");
    editor.handleInput("\u001b[F");

    expect(actions).toEqual([
      { type: "switchInvocation", direction: -1 },
      { type: "switchInvocation", direction: 1 },
      { type: "scroll", direction: -1 },
      { type: "scroll", direction: 1 },
      { type: "selectBoundary", boundary: "first" },
      { type: "selectBoundary", boundary: "last" },
    ]);
    expect(editor.getText()).toBe("");
  });
});

function makeEditor(): {
  editor: ResearchEditor;
  actions: ResearchNavigationAction[];
  modes: string[];
} {
  const actions: ResearchNavigationAction[] = [];
  const modes: string[] = [];
  const tui = {
    requestRender: vi.fn(),
  } as unknown as TUI;
  const theme: EditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const keybindings = {
    matches: () => false,
  } as unknown as KeybindingsManager;
  const editor = new ResearchEditor(tui, theme, keybindings, {
    onAction: (action) => actions.push(action),
    onModeChange: (mode) => modes.push(mode),
  });
  return { editor, actions, modes };
}
