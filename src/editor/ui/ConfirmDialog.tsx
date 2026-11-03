import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Listed under the message (e.g. what will change). */
  items?: string[];
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Show the confirm button as destructive (default true). */
  danger?: boolean;
  /** A checkbox under the list, e.g. "Don't ask again"; its state comes back as `option`. */
  optionLabel?: string;
}

export interface ConfirmResult {
  ok: boolean;
  option: boolean;
}

const pending = signal<(ConfirmOptions & { resolve: (r: ConfirmResult) => void }) | null>(null);

/**
 * Ask in an in-editor dialog (native dialogs can't hold a checkbox). Resolves when the user
 * confirms (Enter or the button) or cancels (Escape, Cancel, or clicking outside).
 */
export function confirmInEditor(options: ConfirmOptions): Promise<ConfirmResult> {
  pending.value?.resolve({ ok: false, option: false });
  return new Promise((resolve) => (pending.value = { ...options, resolve }));
}

export function ConfirmDialog() {
  const p = pending.value;
  const [option, setOption] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOption(false);
    confirm.current?.focus();
  }, [p]);
  if (!p) return null;
  const close = (ok: boolean) => {
    pending.value = null;
    p.resolve({ ok, option: ok && option });
  };
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close(false);
          }
        }}
      >
        <h2 id="confirm-title">{p.title}</h2>
        <p>{p.message}</p>
        {p.items && p.items.length > 0 && (
          <ul class="dialog-items">
            {p.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        {p.optionLabel && (
          <label class="dialog-option">
            <input type="checkbox" checked={option} onChange={(e) => setOption((e.currentTarget as HTMLInputElement).checked)} />
            {p.optionLabel}
          </label>
        )}
        <div class="dialog-buttons">
          <button onClick={() => close(false)}>{p.cancelLabel ?? "Cancel"}</button>
          <button ref={confirm} class={p.danger === false ? "primary" : "danger"} onClick={() => close(true)}>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
