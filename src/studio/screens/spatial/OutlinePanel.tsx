// The Outline panel (the prototype's outline, B.3; spec §4.4.3): the scene's objects grouped by kind with counts, a
// filter by name or group with Collapse all beside it, and per row select, an eye (hide it from the plan; the listener
// that hears the scene always shows) and a lock (it selects but doesn't move), both turning the warning colour when on.
// A row renames (double-click, F2, its menu) and deletes (Del, its menu), as the Scene view does. Hovering a row
// highlights its object on the plan.
import { useState } from "preact/hooks";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { ContextMenu, SEPARATOR } from "../../../editor/ui/ContextMenu";
import { RenameField } from "../../../editor/ui/RenameField";
import { Icon } from "../../components/Icon";
import { outlineGroups } from "./outline";
import type { ObjectKind } from "./sceneEdits";

export interface OutlinePanelProps {
  readonly scene: AudioTestScene;
  readonly selected: string | null;
  readonly readOnly: boolean;
  onSelect(id: string): void;
  onHidden(id: string, hidden: boolean): void;
  onLocked(id: string, locked: boolean): void;
  onHover?(id: string | null): void;
  /** Rename object `id` (the Scene view's rename). */
  onRename?(id: string, name: string): void;
  /** Delete object `id` (the Scene view's delete). */
  onDelete?(id: string): void;
  /** Why object `id` can't be deleted (a scene's only listener), or null. */
  whyNotDelete?(id: string): string | null;
}

export function OutlinePanel(props: OutlinePanelProps) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<ObjectKind>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const groups = outlineGroups(props.scene, filter);
  const filtering = filter.trim() !== "";
  const ro = props.readOnly;
  const canRename = !ro && !!props.onRename;
  const canDelete = (id: string) => !ro && !!props.onDelete && !props.whyNotDelete?.(id);
  const rowOf = (id: string) => groups.flatMap((g) => g.rows).find((r) => r.id === id);
  return (
    <div class="sp-outline">
      <div class="sp-outline-tools">
        <input type="search" class="sp-search" placeholder="Filter the outline" aria-label="Filter the outline" title="Filter emitters, zones, listeners and obstacles by name" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} />
        <button type="button" class="sp-cib" aria-label="Collapse all" title="Collapse every group" disabled={filtering} onClick={() => setClosed(new Set(groups.map((g) => g.kind)))}>
          <Icon name="collapseAll" size={14} />
        </button>
      </div>
      {groups.length === 0 && <p class="sp-nomatch">{filtering ? "No matches" : "Nothing in the scene yet"}</p>}
      <ul class="sp-outline-groups" role="tree" aria-label="Scene outline">
        {groups.map((g) => {
          const open = filtering || !closed.has(g.kind);
          return (
            <li key={g.kind} role="treeitem" aria-expanded={open} aria-label={`${g.title}, ${g.count}`}>
              <button
                type="button"
                class="sp-outline-group"
                disabled={filtering}
                title={open ? `Collapse ${g.title}` : `Expand ${g.title}`}
                onClick={() => {
                  const s = new Set(closed);
                  if (s.has(g.kind)) s.delete(g.kind);
                  else s.add(g.kind);
                  setClosed(s);
                }}
              >
                <Icon name="chevronRight" size={12} class={`sp-caret${open ? " open" : ""}`} />
                <span class="sp-outline-title">{g.title}</span>
                <span class="sp-count">{filtering ? `${g.rows.length} / ${g.count}` : g.count}</span>
              </button>
              {open && g.rows.length > 0 && (
                <ul role="group">
                  {g.rows.map((r) => (
                    <li
                      key={r.id}
                      role="treeitem"
                      aria-selected={props.selected === r.id}
                      class={`sp-outline-row${props.selected === r.id ? " selected" : ""}${r.hidden && !r.active ? " hidden" : ""}`}
                      onPointerEnter={() => props.onHover?.(r.id)}
                      onPointerLeave={() => props.onHover?.(null)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        props.onSelect(r.id);
                        setMenu({ id: r.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      {renaming === r.id ? (
                        <RenameField
                          value={r.name}
                          label="Name"
                          class="sp-outline-rename"
                          onCommit={(v) => {
                            setRenaming(null);
                            if (v.trim() && v.trim() !== r.name) props.onRename?.(r.id, v.trim());
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          class="sp-outline-name"
                          onClick={() => props.onSelect(r.id)}
                          onDblClick={() => canRename && setRenaming(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === "F2" && canRename) {
                              e.preventDefault();
                              e.stopPropagation();
                              setRenaming(r.id);
                            } else if ((e.key === "Delete" || e.key === "Backspace") && canDelete(r.id)) {
                              e.preventDefault();
                              e.stopPropagation();
                              props.onDelete!(r.id);
                            }
                          }}
                          title={`${r.active ? "Hears the scene · " : ""}${canRename ? "Double-click or F2 to rename · Del to delete" : r.name}`}
                        >
                          {r.name}
                          {r.active && <span class="sp-tag">Listening</span>}
                          {r.moving && <span class="sp-tag quiet">Moving</span>}
                        </button>
                      )}
                      <button
                        type="button"
                        class="sp-oic"
                        aria-pressed={r.hidden}
                        aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`}
                        title={r.active ? "The listener that hears the scene always shows" : r.hidden ? "Show it in the scene" : "Hide it in the scene"}
                        disabled={ro}
                        onClick={() => props.onHidden(r.id, !r.hidden)}
                      >
                        <Icon name={r.hidden ? "eyeOff" : "eye"} size={14} />
                      </button>
                      <button
                        type="button"
                        class="sp-oic"
                        aria-pressed={r.locked}
                        aria-label={r.locked ? `Unlock ${r.name}` : `Lock ${r.name}`}
                        title={r.locked ? "Locked: it selects but doesn't move" : "Lock it in place"}
                        disabled={ro}
                        onClick={() => props.onLocked(r.id, !r.locked)}
                      >
                        <Icon name="lock" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {menu && (() => {
        const r = rowOf(menu.id);
        if (!r) return null;
        const why = props.whyNotDelete?.(r.id) ?? null;
        return (
          <ContextMenu
            label={`${r.name} menu`}
            at={{ x: menu.x, y: menu.y }}
            onClose={() => setMenu(null)}
            entries={[
              { id: "rename", label: "Rename", hint: "F2", disabled: !canRename, run: () => setRenaming(r.id) },
              { id: "hide", label: r.hidden ? "Show" : "Hide", disabled: ro, run: () => props.onHidden(r.id, !r.hidden) },
              { id: "lock", label: r.locked ? "Unlock" : "Lock", disabled: ro, run: () => props.onLocked(r.id, !r.locked) },
              SEPARATOR,
              { id: "delete", label: "Delete", hint: "Del", danger: true, disabled: !canDelete(r.id), title: why ?? undefined, run: () => props.onDelete?.(r.id) },
            ]}
          />
        );
      })()}
    </div>
  );
}
