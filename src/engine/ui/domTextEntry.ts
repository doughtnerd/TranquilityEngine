/**
 * The browser's text entry adapter (ADR 0449, the port in `textEntry.ts`): each text box is a hidden DOM `<input>` (or,
 * multi-line, a `<textarea>`) off-screen, so the browser does the editing (the caret keys, the clipboard, IMEs) and
 * the UI core mirrors what it holds. Without a `document` (Node) it makes none. The UI core's default.
 */
import type { UITextBox, UITextBoxEvents, UITextEntry } from "./textEntry";

/** Text entry through hidden DOM elements. */
export function domTextEntry(): UITextEntry {
  return { open: openDomTextBox };
}

function openDomTextBox(multiline: boolean, events: UITextBoxEvents): UITextBox | null {
  if (typeof document === "undefined" || !document.body) return null;
  const el = document.createElement(multiline ? "textarea" : "input") as HTMLInputElement;
  if (!multiline) el.type = "text";
  el.autocomplete = "off";
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  const onInput = () => events.input();
  const onKey = (e: KeyboardEvent) =>
    events.key({
      key: e.key,
      shiftKey: !!e.shiftKey,
      // keyCode 229: a key the IME took (Safari reports composing keys only this way).
      composing: !!e.isComposing || e.keyCode === 229,
      preventDefault: () => e.preventDefault?.(),
    });
  const onBlur = () => events.blur();
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", onBlur);
  document.body.appendChild(el);
  return new DomTextBox(el, () => {
    el.removeEventListener("input", onInput);
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("blur", onBlur);
    el.remove();
  });
}

class DomTextBox implements UITextBox {
  constructor(
    private readonly el: HTMLInputElement,
    private readonly detach: () => void,
  ) {}

  get value(): string {
    return this.el.value;
  }

  set value(v: string) {
    this.el.value = v;
  }

  get selectionStart(): number | null {
    return this.el.selectionStart;
  }

  get selectionEnd(): number | null {
    return this.el.selectionEnd;
  }

  get selectionDirection(): "forward" | "backward" | "none" | null {
    return this.el.selectionDirection;
  }

  setSelectionRange(start: number, end: number, direction?: "forward" | "backward"): void {
    this.el.setSelectionRange(start, end, direction);
  }

  get dir(): string {
    return this.el.dir;
  }

  set dir(d: string) {
    this.el.dir = d;
  }

  limit(maxLength: number): void {
    if (maxLength > 0) this.el.maxLength = maxLength;
    else this.el.removeAttribute("maxlength");
  }

  get focused(): boolean {
    return typeof document !== "undefined" && document.activeElement === this.el;
  }

  focus(): void {
    this.el.focus();
  }

  blur(): void {
    this.el.blur();
  }

  remove(): void {
    this.detach();
  }
}
