import type { UITextBox, UITextBoxEvents, UITextEntry } from "../ui/textEntry";

// ADR 0449: a text entry adapter held in memory, for Node tests: a UI core given one (`new UICore({ textEntry })`, or
// `UIPointer.create(..., { textEntry })`) types through it as it types through hidden DOM elements in a browser. Its
// boxes edit their text as a browser's text controls do for the few things the core relies on: typing at the caret
// (over the selection, within `maxLength`), Backspace and Delete, the caret keys (Shift extends the selection), Enter
// starting a line in a multi-line box, Tab moving focus away unless prevented, and focus moving between boxes.
// Keys reach only the box: what the game's `Input` sees goes through `DomInput` as before.

/** One box: its text, selection and focus, edited as a browser's `<input>` or `<textarea>` is. */
export class MemoryTextBox implements UITextBox {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  dir = "";
  /** The limit the core gave it (0: none). */
  maxLength = 0;
  removed = false;

  constructor(
    private readonly entry: MemoryTextEntry,
    readonly multiline: boolean,
    private readonly events: UITextBoxEvents,
  ) {}

  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none" = "none"): void {
    const n = this.value.length;
    const a = Math.max(0, Math.min(start, n));
    this.selectionStart = a;
    this.selectionEnd = Math.max(a, Math.min(end, n));
    this.selectionDirection = direction;
  }

  limit(maxLength: number): void {
    this.maxLength = maxLength > 0 ? maxLength : 0;
  }

  get focused(): boolean {
    return this.entry.focusedBox === this;
  }

  focus(): void {
    if (this.removed || this.focused) return;
    const before = this.entry.focusedBox;
    this.entry.focusedBox = this;
    before?.events.blur(); // focus moving to another element blurs the one it left
  }

  blur(): void {
    if (!this.focused) return;
    this.entry.focusedBox = null;
    this.events.blur();
  }

  remove(): void {
    if (this.focused) this.entry.focusedBox = null;
    this.removed = true;
  }

  /** The player types `text` at the caret, over the selection, as much as `maxLength` leaves room for. */
  type(text: string): void {
    let t = this.multiline ? text : text.replace(/[\r\n]/g, "");
    const s = this.selectionStart, e = this.selectionEnd;
    if (this.maxLength > 0) t = t.slice(0, Math.max(0, this.maxLength - (this.value.length - (e - s))));
    if (!t && s === e) return;
    this.replace(s, e, t);
  }

  /** The player presses `key` (the DOM's `KeyboardEvent.key`): the core hears it, then its default edits the box unless prevented. */
  press(key: string, options: { shift?: boolean; composing?: boolean } = {}): void {
    let prevented = false;
    const shift = !!options.shift;
    const composing = !!options.composing;
    this.events.key({ key, shiftKey: shift, composing, preventDefault: () => (prevented = true) });
    if (prevented || composing || this.removed || !this.focused) return;
    const s = this.selectionStart, e = this.selectionEnd, n = this.value.length;
    switch (key) {
      case "Backspace":
        if (s !== e) this.replace(s, e, "");
        else if (s > 0) this.replace(s - 1, s, "");
        return;
      case "Delete":
        if (s !== e) this.replace(s, e, "");
        else if (s < n) this.replace(s, s + 1, "");
        return;
      case "ArrowLeft":
        return this.moveCaret(shift ? this.focusEnd() - 1 : s === e ? s - 1 : s, shift);
      case "ArrowRight":
        return this.moveCaret(shift ? this.focusEnd() + 1 : s === e ? e + 1 : e, shift);
      case "Home":
        return this.moveCaret(0, shift);
      case "End":
        return this.moveCaret(n, shift);
      case "Enter":
        if (this.multiline) this.type("\n");
        return;
      case "Tab":
        this.blur(); // the browser's focus change
        return;
      default:
        if ([...key].length === 1) this.type(key);
    }
  }

  /** The end of the selection the caret keys move. */
  private focusEnd(): number {
    return this.selectionDirection === "backward" ? this.selectionStart : this.selectionEnd;
  }

  private moveCaret(to: number, extend: boolean): void {
    const at = Math.max(0, Math.min(to, this.value.length));
    if (!extend) return this.setSelectionRange(at, at);
    const anchor = this.selectionDirection === "backward" ? this.selectionEnd : this.selectionStart;
    this.setSelectionRange(Math.min(anchor, at), Math.max(anchor, at), at < anchor ? "backward" : "forward");
  }

  private replace(s: number, e: number, text: string): void {
    this.value = this.value.slice(0, s) + text + this.value.slice(e);
    const caret = s + text.length;
    this.setSelectionRange(caret, caret);
    this.events.input();
  }
}

/** Text entry in memory: the boxes a core made, and the one with the keyboard. */
export class MemoryTextEntry implements UITextEntry {
  readonly boxes: MemoryTextBox[] = [];
  /** The box with the keyboard (what `document.activeElement` is to the DOM adapter), or null. */
  focusedBox: MemoryTextBox | null = null;

  open(multiline: boolean, events: UITextBoxEvents): MemoryTextBox {
    const box = new MemoryTextBox(this, multiline, events);
    this.boxes.push(box);
    return box;
  }

  /** The box with the keyboard; throws when none has it (nothing is typing). */
  get box(): MemoryTextBox {
    if (!this.focusedBox) throw new Error("No text box has the keyboard: nothing is typing.");
    return this.focusedBox;
  }

  /** The player types `text` into the box with the keyboard. */
  type(text: string): void {
    this.box.type(text);
  }

  /** The player presses `key` in the box with the keyboard. */
  press(key: string, options?: { shift?: boolean; composing?: boolean }): void {
    this.box.press(key, options);
  }

  /** The player selects `[start, end)` in the box with the keyboard (by mouse or keys). */
  select(start: number, end: number, direction?: "forward" | "backward"): void {
    this.box.setSelectionRange(start, end, direction);
  }

  /** The keyboard leaves the page (another window takes it): the box with it blurs. */
  leave(): void {
    this.focusedBox?.blur();
  }
}
