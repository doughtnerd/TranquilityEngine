// The toasts of a toast queue (ADR 0335, `undoToastModel.ts`): bottom-left, newest last, each with its text, an Undo
// when it has one, and a close button. A polite live region announces them; the pointer over them or focus in them
// holds their time. One `UndoToasts` per page draws its queue and drives its clock.
import { useEffect } from "preact/hooks";
import type { ToastQueue } from "./undoToastModel";
import "./kit.css";

export { createToastQueue, UNDO_TOAST_MS, type Toast, type ToastQueue, type ToastRequest } from "./undoToastModel";

/** How often the clock ticks, ms. */
const TICK = 250;

export function UndoToasts(props: { queue: ToastQueue }) {
  const { queue } = props;
  const list = queue.toasts.value;
  const running = list.length > 0;
  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      queue.tick(now - last);
      last = now;
    }, TICK);
    return () => clearInterval(timer);
  }, [queue, running]);
  return (
    <div
      class="kit-toasts"
      role="status"
      aria-live="polite"
      onPointerEnter={() => queue.pause(true)}
      onPointerLeave={() => queue.pause(false)}
      onFocusIn={() => queue.pause(true)}
      onFocusOut={() => queue.pause(false)}
    >
      {list.map((t) => (
        <div key={t.id} class={`kit-toast kit-toast-${t.kind}`}>
          <span class="kit-toast-text">{t.text}</span>
          {t.undoLabel && (
            <button class="kit-toast-undo" onClick={() => queue.undo(t.id)}>
              {t.undoLabel}
            </button>
          )}
          <button class="kit-toast-close" aria-label="Dismiss" title="Dismiss" onClick={() => queue.dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
