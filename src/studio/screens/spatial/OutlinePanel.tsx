// The Outline panel (the prototype's outline, B.3): the scene's objects grouped by kind with counts, a filter by name or
// group, and per row select, an eye (hide it from the plan; the listener that hears the scene always shows) and a lock
// (it selects but doesn't move). Hovering a row highlights its object on the plan.
import { useState } from "preact/hooks";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
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
}

export function OutlinePanel(props: OutlinePanelProps) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<ObjectKind>>(new Set());
  const groups = outlineGroups(props.scene, filter);
  return (
    <div class="sp-outline">
      <input type="search" class="sp-outline-filter" placeholder="Filter by name or group" aria-label="Filter the outline" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)} />
      {groups.length === 0 && <p class="sp-note">Nothing matches “{filter.trim()}”.</p>}
      <ul class="sp-outline-groups" role="tree" aria-label="Scene outline">
        {groups.map((g) => {
          const open = filter.trim() !== "" || !closed.has(g.kind);
          return (
            <li key={g.kind} role="treeitem" aria-expanded={open} aria-label={`${g.title}, ${g.count}`}>
              <button
                type="button"
                class="sp-outline-group"
                onClick={() => {
                  const s = new Set(closed);
                  if (s.has(g.kind)) s.delete(g.kind);
                  else s.add(g.kind);
                  setClosed(s);
                }}
              >
                <span class="sp-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                {g.title}
                <span class="sp-count">{g.count}</span>
              </button>
              {open && g.rows.length > 0 && (
                <ul role="group">
                  {g.rows.map((r) => (
                    <li
                      key={r.id}
                      role="treeitem"
                      aria-selected={props.selected === r.id}
                      class={`sp-outline-row${props.selected === r.id ? " selected" : ""}${r.hidden ? " hidden" : ""}`}
                      onMouseEnter={() => props.onHover?.(r.id)}
                      onMouseLeave={() => props.onHover?.(null)}
                    >
                      <button type="button" class="sp-outline-name" onClick={() => props.onSelect(r.id)} title={r.active ? "Hears the scene" : undefined}>
                        {r.name}
                        {r.active && <span class="sp-tag">Listening</span>}
                        {r.moving && <span class="sp-tag quiet">Moving</span>}
                      </button>
                      <button
                        type="button"
                        class={`sp-oic${r.hidden ? " off" : ""}`}
                        aria-pressed={r.hidden}
                        aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`}
                        title={r.active ? "The listener that hears the scene always shows" : r.hidden ? "Show it in the plan" : "Hide it from the plan"}
                        disabled={props.readOnly}
                        onClick={() => props.onHidden(r.id, !r.hidden)}
                      >
                        {r.hidden ? "◌" : "◉"}
                      </button>
                      <button
                        type="button"
                        class={`sp-oic${r.locked ? " on" : ""}`}
                        aria-pressed={r.locked}
                        aria-label={r.locked ? `Unlock ${r.name}` : `Lock ${r.name}`}
                        title={r.locked ? "Locked: it selects but doesn't move" : "Lock it in place"}
                        disabled={props.readOnly}
                        onClick={() => props.onLocked(r.id, !r.locked)}
                      >
                        {r.locked ? "🔒" : "🔓"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
