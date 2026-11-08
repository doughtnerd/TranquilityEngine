// The editor's message log: every status-bar message, plus errors nobody caught (uncaught
// exceptions, rejected promises, console errors and warnings), with stack traces. The status bar
// shows the latest; clicking it opens the log so whole messages and their details can be read.
import { effect, signal } from "@preact/signals";
import { persisted } from "./preferences";
import { status, type Status } from "./state";

export interface LogEntry {
  readonly id: number;
  readonly time: Date;
  readonly kind: "info" | "warning" | "error";
  readonly text: string;
  /** More to read: a stack trace, or the full list behind a summary. */
  readonly detail?: string;
}

/** The most entries kept; older ones drop off. */
export const LOG_LIMIT = 300;

/** Messages, oldest first. */
export const messageLog = signal<readonly LogEntry[]>([]);
/** Errors logged since the log was last opened. */
export const unseenErrors = signal(0);
/** The log panel is open. */
export const logOpen = signal(false);

/** Every kind of entry, in the order the log's filter toggles list them. */
export const LOG_KINDS: readonly LogEntry["kind"][] = ["info", "warning", "error"];

/** Which kinds of entry the log panel shows (its filter toggles); remembered per user. */
export const logShown = persisted<Record<LogEntry["kind"], boolean>>("myco.editor.logShown", { info: true, warning: true, error: true });

/** Whether entries of `kind` are shown; a kind missing from a stored preference is shown. */
export function kindShown(kind: LogEntry["kind"], shown: Partial<Record<LogEntry["kind"], boolean>> = logShown.value): boolean {
  return shown[kind] !== false;
}

/** Show or hide one kind of entry in the log panel. */
export function toggleLogKind(kind: LogEntry["kind"]): void {
  logShown.value = { ...logShown.value, [kind]: !kindShown(kind) };
}

/** The entries the log panel's filter lets through, oldest first. */
export function shownEntries(entries: readonly LogEntry[] = messageLog.value, shown: Partial<Record<LogEntry["kind"], boolean>> = logShown.value): readonly LogEntry[] {
  return LOG_KINDS.every((k) => kindShown(k, shown)) ? entries : entries.filter((e) => kindShown(e.kind, shown));
}

let nextId = 1;

export function logMessage(kind: LogEntry["kind"], text: string, detail?: string): void {
  const entry: LogEntry = { id: nextId++, time: new Date(), kind, text, ...(detail ? { detail } : {}) };
  messageLog.value = [...messageLog.value, entry].slice(-LOG_LIMIT);
  if (kind === "error" && !logOpen.peek()) unseenErrors.value++;
}

/** An error's message and its stack trace (when it has one beyond the message). */
export function describeError(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) {
    const message = err.message || err.name;
    // V8 stacks start with "Name: message"; WebKit's and Gecko's are frames only.
    const detail = err.stack && !err.stack.includes(message) ? `${err.name}: ${message}\n${err.stack}` : err.stack;
    return { message, ...(detail ? { detail } : {}) };
  }
  if (typeof err === "string") return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

/** A status-bar error for `err`, its message after `context` ("Couldn't save x"), its stack as the detail. */
export function errorStatus(context: string | null, err: unknown): Status {
  const { message, detail } = describeError(err);
  return { kind: "error", text: context ? `${context}: ${message}` : message, ...(detail ? { detail } : {}) };
}

export function clearLog(): void {
  messageLog.value = [];
  unseenErrors.value = 0;
}

/** The log as plain text, for copying. */
export function logText(entries: readonly LogEntry[] = messageLog.value): string {
  return entries.map((e) => `[${e.time.toLocaleTimeString()}] ${e.kind.toUpperCase()} ${e.text}${e.detail ? `\n${e.detail}` : ""}`).join("\n\n");
}

/**
 * Start logging: status messages as they're set, uncaught errors and rejections, and console
 * errors and warnings (which still go to the console). Returns a function that stops it.
 */
export function installMessageLog(target: Window = window): () => void {
  let last: Status | null = null;
  const stopStatus = effect(() => {
    const s = status.value;
    if (!s || s === last) return;
    last = s;
    logMessage(s.kind, s.text, s.detail);
  });

  /** Point at the log from the status bar, without logging that pointer as an error of its own. */
  const flag = (message: string) => {
    const s: Status = { kind: "error", text: `Something went wrong: ${message}. Click the status bar for details.` };
    last = s;
    status.value = s;
  };
  const onError = (e: ErrorEvent) => {
    const { message, detail } = describeError(e.error ?? e.message);
    logMessage("error", `Uncaught error: ${message}`, detail ?? (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined));
    flag(message);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const { message, detail } = describeError(e.reason);
    logMessage("error", `Unhandled promise rejection: ${message}`, detail);
    flag(message);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  const original = { error: console.error, warn: console.warn };
  const capture = (kind: "error" | "warning", args: unknown[]) => {
    const err = args.find((a) => a instanceof Error) as Error | undefined;
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : describeError(a).message)).join(" ");
    // Logged just after, never inside the caller: a library can log from inside its own signal
    // effects (uikit warns about missing glyphs while it lays out text), and writing the log's
    // signals there re-runs effects in the same batch until preact gives up with "Cycle detected".
    queueMicrotask(() => logMessage(kind, text, err?.stack));
  };
  console.error = (...args: unknown[]) => {
    original.error.apply(console, args);
    capture("error", args);
  };
  console.warn = (...args: unknown[]) => {
    original.warn.apply(console, args);
    capture("warning", args);
  };

  return () => {
    stopStatus();
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    console.error = original.error;
    console.warn = original.warn;
  };
}
