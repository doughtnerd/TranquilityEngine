// Toasts with an Undo (ADR 0349): "Deleted Engine loop · Undo", for 10 seconds. One shows at a time (a run of the
// same action merges into it, its Undo undoing them all); it leaves when its time is up, when it is dismissed, or once its Undo has run (which runs at most once, and never after
// the toast has gone). Pausing (the pointer over a toast, or focus in it) holds every toast's time, as a reader needs
// (WCAG 2.2.1). Time comes from the caller's clock, so `UndoToast.tsx` drives it with timers and tests drive it by hand.
import { signal, type ReadonlySignal } from "@preact/signals";

/** How long a toast with an Undo stays, ms. */
export const UNDO_TOAST_MS = 10_000;
/** How long a toast without one stays, ms. */
export const INFO_TOAST_MS = 5_000;

export interface ToastRequest {
  readonly text: string;
  /** "Undo" runs it; the toast then goes. */
  readonly undo?: () => void;
  /** The undo button's label (default "Undo"). */
  readonly undoLabel?: string;
  readonly kind?: "info" | "error";
  /** ms; default `UNDO_TOAST_MS` with an undo, else `INFO_TOAST_MS`. */
  readonly duration?: number;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly kind: "info" | "error";
  readonly undoLabel: string | null;
  /** ms of its time left (frozen while paused). */
  readonly remaining: number;
}

export interface ToastQueue {
  readonly toasts: ReadonlySignal<readonly Toast[]>;
  /** Show a toast; returns its id. */
  show(request: ToastRequest): number;
  /** Run a toast's Undo (once) and remove it; false when it had none or had already gone. */
  undo(id: number): boolean;
  dismiss(id: number): void;
  /** Hold or release every toast's time. */
  pause(paused: boolean): void;
  /** `ms` passed: toasts whose time is up leave. */
  tick(ms: number): void;
}

/**
 * One toast shows at a time (the owner's prototype): a new one takes its place. A run of the same action (a new toast
 * with an Undo whose first word matches the one showing, "Created … · Undo" three times) becomes one toast, "Created
 * step-wood-3 · and 2 more", whose Undo undoes all of them, newest first (journeys walk 2, V15).
 */
const MAX_TOASTS = 1;

const verbOf = (text: string): string => text.split(/\s/, 1)[0] ?? "";

export function createToastQueue(): ToastQueue {
  let nextId = 1;
  let paused = false;
  const undos = new Map<number, () => void>();
  /** A merged toast's run: how many actions it stands for. */
  const runs = new Map<number, number>();
  const toasts = signal<readonly Toast[]>([]);
  const remove = (id: number) => {
    undos.delete(id);
    runs.delete(id);
    toasts.value = toasts.peek().filter((t) => t.id !== id);
  };
  return {
    toasts,
    show(request) {
      const id = nextId++;
      const showing = toasts.peek().at(-1);
      const before = showing ? undos.get(showing.id) : undefined;
      const merge = !!request.undo && !!before && showing!.undoLabel === (request.undoLabel ?? "Undo") && verbOf(showing!.text) === verbOf(request.text);
      const count = merge ? (runs.get(showing!.id) ?? 1) + 1 : 1;
      if (request.undo) {
        const own = request.undo;
        undos.set(id, merge ? () => (own(), before!()) : own);
      }
      if (count > 1) runs.set(id, count);
      const toast: Toast = {
        id,
        text: count > 1 ? `${request.text} · and ${count - 1} more` : request.text,
        kind: request.kind ?? "info",
        undoLabel: request.undo ? (request.undoLabel ?? "Undo") : null,
        remaining: Math.max(0, request.duration ?? (request.undo ? UNDO_TOAST_MS : INFO_TOAST_MS)),
      };
      const list = [...toasts.peek(), toast];
      for (const old of list.slice(0, Math.max(0, list.length - MAX_TOASTS))) (undos.delete(old.id), runs.delete(old.id));
      toasts.value = list.slice(-MAX_TOASTS);
      return id;
    },
    undo(id) {
      const run = undos.get(id);
      if (!run) return false;
      remove(id);
      run();
      return true;
    },
    dismiss: remove,
    pause(value) {
      paused = value;
    },
    tick(ms) {
      if (paused || ms <= 0 || toasts.peek().length === 0) return;
      const next = toasts.peek().map((t) => ({ ...t, remaining: t.remaining - ms }));
      for (const t of next) if (t.remaining <= 0) undos.delete(t.id);
      toasts.value = next.filter((t) => t.remaining > 0);
    },
  };
}
