// The keyboard shortcuts dialog (ADR 0349, "?"): every shortcut in its groups, the keys as the platform writes them,
// a search, and (when the host has one) the single-key shortcuts switch. Escape, Close or a click outside closes it.
import { useState } from "preact/hooks";
import { isMacPlatform } from "./keyCombo";
import { shownShortcuts, type ShortcutGroup } from "./shortcutListModel";
import "./kit.css";

export type { ShortcutEntry, ShortcutGroup } from "./shortcutListModel";

export interface KeyboardShortcutsDialogProps {
  readonly groups: readonly ShortcutGroup[];
  /** The single-key shortcuts preference, when the host has one. */
  readonly singleKeys?: { readonly on: boolean; set(on: boolean): void };
  /** Write keys as macOS does (default: this platform). */
  readonly mac?: boolean;
  onClose(): void;
}

export function KeyboardShortcutsDialog(props: KeyboardShortcutsDialogProps) {
  const [query, setQuery] = useState("");
  const shown = shownShortcuts(props.groups, query, props.mac ?? isMacPlatform());
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        class="dialog kit-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kit-shortcuts-title"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      >
        <h2 id="kit-shortcuts-title">Keyboard shortcuts</h2>
        <input type="search" class="kit-shortcuts-search" placeholder="Search shortcuts" aria-label="Search shortcuts" value={query} autoFocus onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <div class="kit-shortcuts-list">
          {shown.length === 0 && <p class="kit-shortcuts-none">No shortcut matches “{query.trim()}”.</p>}
          {shown.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.entries.map((e) => (
                  <div key={e.label} class={`kit-shortcut${e.off ? " off" : ""}`} title={e.off ? "Single-key shortcuts are off" : undefined}>
                    <dt>{e.label}</dt>
                    <dd>
                      {e.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div class="dialog-buttons kit-shortcuts-buttons">
          {props.singleKeys && (
            <label class="kit-shortcuts-single">
              <input type="checkbox" checked={props.singleKeys.on} onChange={(e) => props.singleKeys!.set((e.target as HTMLInputElement).checked)} />
              Single-key shortcuts
            </label>
          )}
          <button class="primary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
