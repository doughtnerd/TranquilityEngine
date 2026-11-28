/**
 * Text entry (ADR 0449): how the UI core takes the player's typing. The core is given a `UITextEntry`, a port that makes
 * hidden text controls (`UITextBox`): the platform edits text in one (the browser's editing, IMEs, the clipboard) and
 * the core mirrors it into the focused input field (ADR 0309, 0340) or the editable text being edited (ADR 0429).
 * `domTextEntry.ts` is the browser's adapter, the default; Node has none (no `document`), so a core there types nothing
 * unless it's given another adapter. Nothing here is public API (ADR 0010).
 *
 * `UITextEntryBridge` is the part that doesn't depend on the platform: which control has focus, what it holds, and what
 * the player's input, keys and blur do to fields and editable texts. The core owns one.
 */
import type { World } from "../core/World";
import type { UIComponentType, UIInputField, UIText } from "./components";
import { uiEventRecord } from "./events";
import { uiInteractions } from "./interactions";
import { applyInlineEdit } from "./text/inlineEdit";
import type { UITextRun } from "./uiCoreTypes";

/** A key pressed in a text box, as the platform reports it. */
export interface UITextKey {
  /** The DOM's `KeyboardEvent.key` ("Enter", "Escape", "Tab", "a"). */
  readonly key: string;
  readonly shiftKey: boolean;
  /** An IME is composing (CJK, ADR 0356): its own keys pick or drop candidates. */
  readonly composing: boolean;
  /** Stop the platform's default for the key (Tab moving focus). */
  preventDefault(): void;
}

/** What a text box tells the core. */
export interface UITextBoxEvents {
  /** The player changed its value (typing, deleting, pasting, an IME's commit). */
  input(): void;
  /** A key went down in it. */
  key(e: UITextKey): void;
  /** It lost focus (a programmatic `blur()` included). */
  blur(): void;
}

/** One hidden text control the player types in: a one-line field's or a multi-line one's. */
export interface UITextBox {
  /** Its text. Setting it doesn't send `input`. */
  value: string;
  /** The selection (`[start, end)`, the caret when equal), and which end the player moves. Null: unknown. */
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly selectionDirection: "forward" | "backward" | "none" | null;
  setSelectionRange(start: number, end: number, direction?: "forward" | "backward"): void;
  /** Its base direction (`ltr`, `rtl`): an IME and the selection follow it. */
  dir: string;
  /** The most characters the player may type; 0 or less: no limit. */
  limit(maxLength: number): void;
  /** Whether it has the keyboard. */
  readonly focused: boolean;
  focus(): void;
  blur(): void;
  /** Let go of it: no more events, and the platform's control is gone. */
  remove(): void;
}

/** The port: a platform's way to make text boxes. */
export interface UITextEntry {
  /** A new text box (multi-line: Enter starts a line in it) that reports to `events`; null when the platform has none. */
  open(multiline: boolean, events: UITextBoxEvents): UITextBox | null;
}

/** The editable text being edited (ADR 0429), as the core keeps it: its selection and the text the box was given. */
export interface UITextEdit {
  readonly entry: { readonly comp: UIComponentType; readonly run: UITextRun | null };
  anchor: number;
  focus: number;
  text: string;
  /** The selection changed in the core (a press or drag), to be put into the box. */
  selectionChanged: boolean;
}

/** The field that should have the keyboard: its component, whether it's multi-line, and its text's direction. */
export interface UITextEntryWant {
  readonly field: UIInputField;
  readonly multiline: boolean;
  readonly direction: "ltr" | "rtl";
}

/** What the bridge reads from and asks of its core. */
export interface UITextEntryCore {
  world(): World | null;
  /** The left button was down or held at the last routing (a press on the canvas takes the platform's focus first). */
  pointerHeld(): boolean;
  editing(): UITextEdit | null;
  /** Stop editing the editable text (the core sends `blur` and calls `stopEditing`). */
  endEditing(): void;
}

/** The platform-neutral half of typing: one box per kind, shared by whichever field (or editable text) has focus. */
export class UITextEntryBridge {
  /** The boxes made so far: a one-line one and (ADR 0428) a multi-line one. */
  private readonly boxes: { line?: UITextBox; area?: UITextBox } = {};
  /** The box in use. */
  private box: UITextBox | null = null;
  /** The field the box holds. */
  private active: UIInputField | null = null;
  /** ADR 0429: the editable text the multi-line box holds. */
  private editActive: UIText | null = null;
  /** The bridge itself is moving focus (its blur isn't the player's). */
  private programmatic = false;
  /** Keys the box took since the last routing (Tab, Escape leaving a field), claimed from the game until released. */
  private swallowed: string[] = [];

  constructor(
    private readonly port: UITextEntry,
    private readonly core: UITextEntryCore,
  ) {}

  /** The caret index in a field's text, or null when it isn't the one being typed in. */
  caretOf(c: UIInputField): number | null {
    if (!this.box || this.active !== c) return null;
    return this.box.selectionStart ?? this.box.value.length;
  }

  /** ADR 0432: the selection (`[start, end)`) in the field being typed in, or null when it isn't the one or nothing is selected. */
  selectionOf(c: UIInputField): readonly [number, number] | null {
    if (!this.box || this.active !== c) return null;
    const s = this.box.selectionStart, e = this.box.selectionEnd;
    return s !== null && e !== null && e > s ? [s, e] : null;
  }

  /** The keys the box took since the last call (routing claims them from the game). */
  takeKeys(): string[] {
    const keys = this.swallowed;
    this.swallowed = [];
    return keys;
  }

  /**
   * Move focus to or from the box, and mirror into it: the editable text being edited (`edit`) or else the field that
   * should have the keyboard (`want`), its value and `maxLength`.
   */
  sync(want: UITextEntryWant | null, edit: UITextEdit | null): void {
    // ADR 0429: an editable text being edited holds the multi-line box (its runs' text, images as U+FFFC).
    if (edit) return this.syncEdit(edit);
    if (this.editActive) {
      this.editActive = null;
      this.unfocus();
    }
    if (!want) {
      if (this.active) this.unfocus();
      return;
    }
    const el = this.ensureBox(want.multiline);
    if (!el) return;
    const wantComp = want.field;
    if (this.box !== el) {
      this.box = el;
      this.active = null; // the other box: take the value and focus over
    }
    if (this.active !== wantComp) {
      this.active = wantComp;
      el.value = wantComp.value;
      this.focusBox(el);
      el.setSelectionRange(el.value.length, el.value.length);
    } else if (!el.focused) this.focusBox(el);
    el.limit(wantComp.maxLength);
    if (el.dir !== want.direction) el.dir = want.direction; // the language's direction (ADR 0356 §5)
    if (el.value !== wantComp.value) el.value = wantComp.value; // a script changed it
  }

  /** A field went away: the box lets go of it. */
  release(c: UIComponentType): void {
    if (this.active === c) this.unfocus();
  }

  /** ADR 0429: the editable text stopped being edited: the box lets go of it. */
  stopEditing(): void {
    if (!this.editActive) return;
    this.editActive = null;
    this.unfocus();
  }

  dispose(): void {
    this.unfocus();
    this.editActive = null;
    for (const box of [this.boxes.line, this.boxes.area]) box?.remove();
    this.boxes.line = this.boxes.area = undefined;
    this.box = null;
  }

  /** The box a field types in, made on first use: a one-line one, or (ADR 0428) a multi-line one, where Enter starts a line. */
  private ensureBox(multiline: boolean): UITextBox | null {
    const have = multiline ? this.boxes.area : this.boxes.line;
    if (have) return have;
    let made: UITextBox | null = null;
    made = this.port.open(multiline, {
      input: () => made && this.onInput(made),
      key: (e) => made && this.onKey(made, e, multiline),
      blur: () => this.onBlur(),
    });
    if (!made) return null;
    if (multiline) this.boxes.area = made;
    else this.boxes.line = made;
    return made;
  }

  /** The player's typing: the value now, the change event for the World's next frame (ADR 0309). */
  private onInput(el: UITextBox): void {
    // ADR 0429: an editable text's edit goes into its runs' components; `input` follows in the next frame.
    const ed = this.core.editing();
    if (ed && this.editActive && this.box === el) return this.editInput(ed, el);
    const c = this.active;
    if (!c) return;
    let v = el.value;
    if (c.maxLength > 0 && v.length > c.maxLength) {
      v = v.slice(0, c.maxLength);
      el.value = v;
    }
    if (v === c.value) return;
    c.value = v;
    uiInteractions(c._world).record("change", c);
  }

  /**
   * Enter submits; Tab, Shift+Tab and Escape leave the field through navigation (ADR 0340), and their presses stay the
   * UI's until released, so the game (and the `ui` context) never sees them as new ones.
   */
  private onKey(el: UITextBox, e: UITextKey, multiline: boolean): void {
    // ADR 0429: Escape leaves an editable text (Enter starts a line in it); Tab leaves it for navigation.
    if (this.core.editing() && this.editActive && this.box === el && !e.composing) {
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Tab") e.preventDefault();
        this.swallowed.push(e.key === "Tab" ? "tab" : "escape");
        this.core.endEditing();
        const world = this.core.world();
        if (e.key === "Tab" && world) uiInteractions(world).request(e.shiftKey ? "previous" : "next");
      }
      return;
    }
    const c = this.active;
    if (!c) return;
    // While an IME composes (CJK, ADR 0356), Enter picks its candidate and Escape drops the composition.
    if (e.composing) return;
    const log = uiInteractions(c._world);
    if (e.key === "Enter") {
      if (!multiline) log.record("submit", c);
    } else if (e.key === "Escape") {
      this.swallowed.push("escape");
      log.request("cancel");
    } else if (e.key === "Tab") {
      e.preventDefault(); // not the platform's focus change
      this.swallowed.push("tab");
      if (e.shiftKey) this.swallowed.push("shift");
      log.request(e.shiftKey ? "previous" : "next");
    }
  }

  private onBlur(): void {
    const pointerHeld = this.core.pointerHeld();
    if (!this.programmatic && this.core.editing() && this.editActive && !pointerHeld) return this.core.endEditing();
    if (this.programmatic || !this.active) return;
    // A press on the canvas takes the platform's focus first; routing re-focuses the field that press hit.
    if (pointerHeld) return;
    uiInteractions(this.active._world).blur(this.active, "script");
  }

  // --- Editable text (ADR 0429) ----------------------------------------------------------------

  /** The box an editable text types in: its text mirrored, focused, and the selection either way between them. */
  private syncEdit(ed: UITextEdit): void {
    const el = this.ensureBox(true);
    if (!el) return;
    this.box = el;
    this.active = null;
    const run = ed.entry.run!;
    const comp = ed.entry.comp as UIText;
    if (this.editActive !== comp) {
      this.editActive = comp;
      el.value = ed.text = run.text;
      el.limit(0);
      this.focusBox(el);
      ed.selectionChanged = true;
    } else if (!el.focused) this.focusBox(el);
    if (run.text !== ed.text && el.value === ed.text) {
      // A script changed the text (or an edit couldn't go in whole: an image stays): take it as it is now.
      el.value = ed.text = run.text;
      ed.anchor = Math.min(ed.anchor, run.text.length);
      ed.focus = Math.min(ed.focus, run.text.length);
      ed.selectionChanged = true;
    }
    if (el.dir !== run.direction) el.dir = run.direction;
    if (ed.selectionChanged) {
      ed.selectionChanged = false;
      const a = Math.min(ed.anchor, ed.focus), b = Math.max(ed.anchor, ed.focus);
      el.setSelectionRange(a, b, ed.anchor > ed.focus ? "backward" : "forward");
    } else {
      // The player moved the caret or the selection with the keys (or the IME did).
      const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
      const backward = el.selectionDirection === "backward";
      ed.anchor = backward ? e : s;
      ed.focus = backward ? s : e;
    }
  }

  /** The player typed in an editable text: the edit goes into its runs' components; `input` is sent in the next routing. */
  private editInput(ed: UITextEdit, el: UITextBox): void {
    const next = el.value;
    if (next === ed.text || !ed.entry.run?.runs) return;
    applyInlineEdit(ed.entry.comp as UIText, ed.entry.run.runs, ed.text, next);
    ed.text = next;
    const s = el.selectionStart ?? next.length, e = el.selectionEnd ?? s;
    ed.anchor = s;
    ed.focus = e;
    uiInteractions(ed.entry.comp._world).queue(uiEventRecord("input", ed.entry.comp));
  }

  private focusBox(el: UITextBox): void {
    this.programmatic = true;
    try {
      el.focus();
    } finally {
      this.programmatic = false;
    }
  }

  private unfocus(): void {
    const el = this.box;
    this.active = null;
    if (el?.focused) {
      this.programmatic = true;
      try {
        el.blur();
      } finally {
        this.programmatic = false;
      }
    }
  }
}
