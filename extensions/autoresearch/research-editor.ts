import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

export type ResearchEditorMode = "nav" | "type";

export type ResearchNavigationAction =
  | { type: "select"; direction: -1 | 1 }
  | { type: "focus" }
  | { type: "overview" }
  | { type: "switchInvocation"; direction: -1 | 1 }
  | { type: "scroll"; direction: -1 | 1 }
  | { type: "selectBoundary"; boundary: "first" | "last" };

export interface ResearchEditorOptions {
  onAction: (action: ResearchNavigationAction) => void;
  onModeChange?: (mode: ResearchEditorMode) => void;
}

/**
 * Pi-compatible editor that adds an explicit agent-navigation mode while
 * preserving the normal CustomEditor behavior in typing mode.
 */
export class ResearchEditor extends CustomEditor {
  private mode: ResearchEditorMode = "nav";

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly research: ResearchEditorOptions,
  ) {
    super(tui, theme, keybindings);
  }

  getMode(): ResearchEditorMode {
    return this.mode;
  }

  setMode(mode: ResearchEditorMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.research.onModeChange?.(mode);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "nav") {
      if (matchesKey(data, "up")) {
        this.emit({ type: "select", direction: -1 });
        return;
      }
      if (matchesKey(data, "down")) {
        this.emit({ type: "select", direction: 1 });
        return;
      }
      if (matchesKey(data, "enter")) {
        this.emit({ type: "focus" });
        return;
      }
      if (matchesKey(data, "escape")) {
        this.emit({ type: "overview" });
        return;
      }
      if (matchesKey(data, "left")) {
        this.emit({ type: "switchInvocation", direction: -1 });
        return;
      }
      if (matchesKey(data, "right")) {
        this.emit({ type: "switchInvocation", direction: 1 });
        return;
      }
      if (matchesKey(data, "pageUp")) {
        this.emit({ type: "scroll", direction: -1 });
        return;
      }
      if (matchesKey(data, "pageDown")) {
        this.emit({ type: "scroll", direction: 1 });
        return;
      }
      if (matchesKey(data, "home")) {
        this.emit({ type: "selectBoundary", boundary: "first" });
        return;
      }
      if (matchesKey(data, "end")) {
        this.emit({ type: "selectBoundary", boundary: "last" });
        return;
      }
      if (matchesKey(data, "tab")) {
        this.setMode("type");
        return;
      }
      if (isPrintableInput(data)) {
        this.setMode("type");
        super.handleInput(data);
        return;
      }
      super.handleInput(data);
      return;
    }

    if (
      matchesKey(data, "tab") &&
      !this.isShowingAutocomplete()
    ) {
      this.setMode("nav");
      return;
    }
    if (matchesKey(data, "escape") && this.getText().length === 0) {
      this.setMode("nav");
      this.emit({ type: "overview" });
      return;
    }

    const before = this.getText();
    super.handleInput(data);
    if (
      matchesKey(data, "enter") &&
      before.trim().length > 0 &&
      this.getText().length === 0
    ) {
      this.setMode("nav");
    }
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    const label = this.mode === "nav" ? " NAV " : " TYPE ";
    const last = lines.length - 1;
    const current = lines[last] ?? "";
    if (visibleWidth(current) >= label.length) {
      lines[last] = `${truncateToWidth(current, Math.max(0, width - label.length), "")}${label}`;
    }
    return lines;
  }

  private emit(action: ResearchNavigationAction): void {
    this.research.onAction(action);
    this.tui.requestRender();
  }
}

function isPrintableInput(data: string): boolean {
  if (data.includes("\x1b[200~")) return true;
  if (decodeKittyPrintable(data) !== undefined) return true;
  if (data.length === 1) {
    const code = data.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }
  return data.length > 1 && !data.startsWith("\x1b");
}
