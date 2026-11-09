// The editor SDK's messages (ADR 0147): a plugin reports to the status bar and the message log
// through these, never by setting the shell's `status` signal.
import { errorStatus } from "../messages";
import { status } from "../state";

/** A button on a status message, e.g. "Undo" or "Show". */
export interface MessageAction {
  label: string;
  run: () => void;
  /** Shown once it has run. */
  done?: string;
}

export interface MessagesSurface {
  /** An info message in the status bar (and the log). `detail` is more to read in the log. */
  info(text: string, detail?: string, action?: MessageAction): void;
  /** An error message in the status bar (and the log). */
  error(text: string, detail?: string, action?: MessageAction): void;
  /** An error from a caught exception: "<context>: <its message>", its stack trace as the detail. A null context shows the message alone. */
  failed(context: string | null, err: unknown): void;
  /** Clear the status bar (the log keeps its entries). */
  clear(): void;
}

const show = (kind: "info" | "error", text: string, detail?: string, action?: MessageAction) => {
  status.value = { kind, text, ...(detail ? { detail } : {}), ...(action ? { action } : {}) };
};

export const messages: MessagesSurface = {
  info: (text, detail, action) => show("info", text, detail, action),
  error: (text, detail, action) => show("error", text, detail, action),
  failed(context, err) {
    status.value = errorStatus(context, err);
  },
  clear() {
    status.value = null;
  },
};
