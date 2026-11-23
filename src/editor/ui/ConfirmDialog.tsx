// The confirm dialog (ADR 0349 kit): a question in `KitDialog` (header band with × close, footer with Cancel then the
// confirm button), an optional list and checkbox.
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { KitDialog } from "./KitDialog";

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
  /** Makes the items links: clicking one cancels the dialog (keeping the checkbox's state) and calls this with its index. */
  onItem?: (index: number) => void;
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
    <KitDialog
      role="alertdialog"
      title={p.title}
      onClose={() => close(false)}
      buttons={
        <>
          <button onClick={() => close(false)}>{p.cancelLabel ?? "Cancel"}</button>
          <button ref={confirm} class={p.danger === false ? "primary" : "danger"} onClick={() => close(true)}>
            {p.confirmLabel}
          </button>
        </>
      }
    >
      <p class="kit-dialog-message">{p.message}</p>
      {p.items && p.items.length > 0 && (
        <ul class="dialog-items">
          {p.items.map((item, i) => (
            <li key={item}>
              {p.onItem ? (
                <button
                  class="dialog-item-link"
                  onClick={() => {
                    pending.value = null;
                    p.resolve({ ok: false, option });
                    p.onItem!(i);
                  }}
                >
                  {item}
                </button>
              ) : (
                item
              )}
            </li>
          ))}
        </ul>
      )}
      {p.optionLabel && (
        <label class="dialog-option">
          <input type="checkbox" checked={option} onChange={(e) => setOption((e.currentTarget as HTMLInputElement).checked)} />
          {p.optionLabel}
        </label>
      )}
    </KitDialog>
  );
}
