// The Packages screen's package list (ADR 0351 §6): each package with how many assets it holds, Preload, a note when it
// doesn't ship on the chosen platform and its problems; New package; Rename (F2, double-click or the menu) and Delete;
// a sound dragged from the screen's tables onto a package is added to it. A view over props.
import { useState } from "preact/hooks";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { PackageListRow } from "./packagesModel";

/** The drag type a sound row carries (its project path). */
export const SOUND_DRAG_TYPE = "application/x-myco-audio-path";

export interface PackageListViewProps {
  readonly rows: readonly PackageListRow[];
  readonly selected: string | null;
  readonly platform: ImportPlatform;
  readonly readOnly?: boolean;
  onSelect(name: string): void;
  onAdd(): void;
  onRename(from: string, to: string): void;
  onDelete(name: string): void;
  onDropSound(name: string, path: string): void;
}

export function PackageListView(props: PackageListViewProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; at: Element | { x: number; y: number } } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const entries = (name: string): MenuEntry[] => [
    { id: "rename", label: "Rename", hint: "F2", disabled: props.readOnly, run: () => setRenaming(name) },
    SEPARATOR,
    { id: "delete", label: "Delete package", danger: true, disabled: props.readOnly, run: () => props.onDelete(name) },
  ];
  return (
    <div class="pk-list">
      <div class="pk-toolbar">
        <button disabled={props.readOnly} onClick={props.onAdd}>New package</button>
      </div>
      {props.rows.length === 0 ? (
        <EmptyState compact title="No packages" body="Every sound ships loose and loads when played. A package groups sounds a script or a scene loads and unloads together." />
      ) : (
        <ul class="pk-rows" role="listbox" aria-label="Packages">
          {props.rows.map((r) => (
            <li
              key={r.name}
              role="option"
              aria-selected={props.selected === r.name}
              class={`pk-row${props.selected === r.name ? " selected" : ""}${over === r.name ? " drop" : ""}${r.ships ? "" : " off"}`}
              tabIndex={props.selected === r.name || (props.selected === null && r === props.rows[0]) ? 0 : -1}
              onClick={() => props.onSelect(r.name)}
              onDblClick={() => !props.readOnly && setRenaming(r.name)}
              onKeyDown={(e) => {
                if (e.key === "F2" && !props.readOnly) setRenaming(r.name);
                if (e.key === "Delete" && !props.readOnly) props.onDelete(r.name);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ name: r.name, at: { x: e.clientX, y: e.clientY } });
              }}
              onDragOver={(e) => {
                if (props.readOnly || !e.dataTransfer?.types.includes(SOUND_DRAG_TYPE)) return;
                e.preventDefault();
                setOver(r.name);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                const path = e.dataTransfer?.getData(SOUND_DRAG_TYPE);
                if (!path) return;
                e.preventDefault();
                props.onDropSound(r.name, path);
              }}
            >
              {renaming === r.name ? (
                <input
                  class="pk-rename"
                  aria-label={`Rename ${r.name}`}
                  value={r.name}
                  ref={(el) => el?.focus()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => {
                    const to = (e.currentTarget as HTMLInputElement).value;
                    setRenaming(null);
                    if (to !== r.name) props.onRename(r.name, to);
                  }}
                />
              ) : (
                <span class="pk-name">{r.name}</span>
              )}
              <span class="pk-meta">
                {r.preload && <span class="pk-badge">Preload</span>}
                {!r.ships && <span class="pk-badge" title={`Not shipped on ${props.platform}`}>not on {props.platform}</span>}
                {r.problems > 0 && <span class="pk-badge warn" title="Includes that match nothing, or dependencies missing from the project">{r.problems} problem{r.problems === 1 ? "" : "s"}</span>}
                <span class="pk-count">{r.count}</span>
              </span>
              <button class="pk-more" aria-label={`${r.name} menu`} onClick={(e) => { e.stopPropagation(); setMenu({ name: r.name, at: e.currentTarget as Element }); }}>⋯</button>
            </li>
          ))}
        </ul>
      )}
      {menu && <ContextMenu entries={entries(menu.name)} at={menu.at} label={`${menu.name} menu`} onClose={() => setMenu(null)} />}
    </div>
  );
}
