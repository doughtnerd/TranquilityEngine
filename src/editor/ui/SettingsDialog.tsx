import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { askBeforeClearingReferences, askBeforeDeletingAssets, historyLocation } from "../preferences";
import "./history.css";

/** Whether the Settings dialog is open. */
export const settingsOpen = signal(false);

/** Editor settings (per user): where edit history is kept, and the delete-reference prompt. */
export function SettingsDialog() {
  const close = useRef<HTMLButtonElement>(null);
  const open = settingsOpen.value;
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    // On the window, not the dialog: some browsers (WebKit) don't focus checkboxes when clicked,
    // so a key press after ticking one wouldn't reach the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      settingsOpen.value = false;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const location = historyLocation.value;
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && (settingsOpen.value = false)}>
      <div
        class="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title">Settings</h2>
        <fieldset>
          <legend>Edit history location</legend>
          <label>
            <input type="radio" name="history-location" checked={location === "project"} onChange={() => (historyLocation.value = "project")} />
            Project folder (.tranquility/history)
          </label>
          <label>
            <input type="radio" name="history-location" checked={location === "user"} onChange={() => (historyLocation.value = "user")} />
            Per user (outside the project)
          </label>
          <p class="note">Read-only projects, such as the bundled demo, always keep history per user.</p>
        </fieldset>
        <fieldset>
          <legend>Deleting</legend>
          <label>
            <input
              type="checkbox"
              checked={askBeforeClearingReferences.value}
              onChange={(e) => (askBeforeClearingReferences.value = (e.currentTarget as HTMLInputElement).checked)}
            />
            Ask before deleting a node other nodes reference
          </label>
          <label>
            <input
              type="checkbox"
              checked={askBeforeDeletingAssets.value}
              onChange={(e) => (askBeforeDeletingAssets.value = (e.currentTarget as HTMLInputElement).checked)}
            />
            Ask before deleting an asset or script
          </label>
        </fieldset>
        <div class="dialog-buttons">
          <button ref={close} onClick={() => (settingsOpen.value = false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
