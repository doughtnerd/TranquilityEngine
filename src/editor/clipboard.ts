// The editor's clipboard text (ADR 0226): what the node clipboard and the graph panels put on the
// system clipboard, and how a paste reads it back. A payload is JSON carrying a `format` tag, so
// text from anything else (or another kind of payload) is ignored. Each copier also keeps its
// payload in memory, which covers every window of this editor (detached panels share its realm,
// ADR 0174); the text adds pasting into another editor process and between graphs as text.
//
// A paste reads the text only from a `paste` event's `clipboardData`, never with
// `navigator.clipboard.read` (which prompts for permission): the Ctrl/Cmd+V keydown calls
// `expectPaste` without preventing the default, the browser fires `paste`, and `takePaste` hands
// its text to the paste. Where no event comes (a platform that fires none outside text fields), the
// paste runs on the next task with no text, so from memory.

/** Clipboard JSON: anything with a `format` tag naming what it holds, such as `myco.nodes@1`. */
export interface ClipboardPayload {
  readonly format: string;
}

/** The text this editor last wrote, and whether it reached the system clipboard (null: not known yet). */
let written: { readonly text: string; reached: boolean | null } | null = null;

/** The clipboard text for a payload. */
export const clipboardText = (payload: ClipboardPayload): string => JSON.stringify(payload, null, 2);

/** Put a payload on the system clipboard as text (best effort: it may be unavailable or refused). */
export function writeClipboard(payload: ClipboardPayload): void {
  const mine: { text: string; reached: boolean | null } = { text: clipboardText(payload), reached: null };
  written = mine;
  try {
    const done = globalThis.navigator?.clipboard?.writeText(mine.text);
    if (!done) mine.reached = false;
    else
      void done.then(
        () => (mine.reached = true),
        () => (mine.reached = false),
      );
  } catch {
    mine.reached = false; // no system clipboard: the copier's memory still works
  }
}

/** The payload in clipboard `text`, or null if it isn't JSON of `format` (or `valid` says it's malformed). */
export function readClipboard<T extends ClipboardPayload>(text: string, format: T["format"], valid: (v: unknown) => boolean = () => true): T | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && (v as ClipboardPayload).format === format && valid(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

/**
 * What a paste takes: the payload `read` finds in the system clipboard's `text`, unless this editor
 * wrote that text itself or its last copy never reached the system clipboard (the text is then
 * older than `memory`), in which case `memory`, the copier's own last copy. Either one when the
 * other is missing. So text copied in another editor process since this one's last copy wins.
 */
export function clipboardForPaste<T>(text: string | null, memory: T | null, read: (text: string) => T | null): T | null {
  const parsed = text ? read(text) : null;
  if (!parsed) return memory;
  if (memory && written && (written.text === text || written.reached === false)) return memory;
  return parsed;
}

/** A paste waiting for its `paste` event. */
let waiting: { readonly run: (text: string | null) => void; readonly timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Call from the Ctrl/Cmd+V keydown, without `preventDefault`, so the browser fires `paste`: `run`
 * gets that event's clipboard text through `takePaste`, or null on the next task if none comes.
 */
export function expectPaste(run: (text: string | null) => void): void {
  if (waiting) clearTimeout(waiting.timer);
  const timer = setTimeout(() => {
    if (waiting?.timer !== timer) return;
    waiting = null;
    run(null);
  }, 0);
  waiting = { run, timer };
}

/**
 * Handle a `paste` event: the paste `expectPaste` is waiting with gets its text, or `run` when none
 * is waiting (a paste from the browser's or the window's Edit menu). Claims the event.
 */
export function takePaste(e: { readonly clipboardData: Pick<DataTransfer, "getData"> | null; preventDefault(): void }, run?: (text: string | null) => void): void {
  const pending = waiting;
  if (pending) {
    clearTimeout(pending.timer);
    waiting = null;
  }
  const paste = pending?.run ?? run;
  if (!paste) return;
  e.preventDefault();
  paste(e.clipboardData?.getData("text/plain") || null);
}
