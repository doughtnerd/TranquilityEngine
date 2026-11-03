import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { engineWorld } from "../../engine/editor";
import { highlightLive, inspectWorld, inspectedWorld, liveRows, liveSelection } from "../runtimeInspect";
import { playing } from "../session";
import { playState } from "../state";
import "./playdebug.css";

/** The live tree refreshes this often (not every frame). */
const REFRESH_MS = 300;

/** Collapsed live nodes, by entity. */
const collapsed = signal<ReadonlySet<number>>(new Set());

/** Re-render every `ms` while mounted and `on`. */
function useTick(ms: number, on = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return tick;
}

/**
 * While playing: which World the Hierarchy and Inspector show, the edited scene or a live World
 * of the running game (Worlds created at runtime included). Nothing while editing.
 */
export function WorldPicker() {
  const session = playing.value;
  const active = playState.value === "playing" && !!session;
  useTick(500, active); // Worlds come and go at runtime
  if (!active) return null;
  const names = session!.engine.worlds().map((w) => w.name);
  const current = inspectedWorld.value;
  const value = current !== null && names.includes(current) ? current : "";
  return (
    <div class="world-picker">
      <label>
        <span class="world-picker-label">Show</span>
        <select aria-label="Inspect World" value={value} onChange={(e) => inspectWorld(e.currentTarget.value || null)}>
          <option value="">Scene (editing)</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n} (live)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** A live World's node tree: scene nodes, nodes made at runtime, ghosts and connections, refreshed as it changes. */
export function RuntimeHierarchy() {
  useTick(REFRESH_MS);
  const session = playing.value;
  const name = inspectedWorld.value;
  const world = session && name ? engineWorld(session.engine, name) : null;
  const selected = liveSelection.value;
  if (!world) {
    return (
      <div class="runtime-hierarchy">
        <WorldPicker />
        <p class="empty">
          World {name} is gone.{" "}
          <button class="link-button" onClick={() => inspectWorld(null)}>
            Show the scene
          </button>
        </p>
      </div>
    );
  }
  const rows = liveRows(world, collapsed.value);
  const toggle = (entity: number) => {
    const next = new Set(collapsed.value);
    if (!next.delete(entity)) next.add(entity);
    collapsed.value = next;
  };
  const choose = (node: (typeof rows)[number]["node"]) => {
    liveSelection.value = node;
    highlightLive(session!.engine, name, node);
    if (session!.paused) session!.redraw();
  };
  return (
    <div class="runtime-hierarchy">
      <WorldPicker />
      <div class="scene-name live-name" title={`The running World "${name}": edits here change the game only`}>
        {name}
        <span class="live-badge">live{session!.paused ? " · paused" : ""}</span>
      </div>
      {rows.length === 0 && <p class="empty">This World has no nodes.</p>}
      <ul class="tree live-tree" role="tree" aria-label="Live nodes">
        {rows.map((r) => {
          const isSelected = selected === r.node && r.node.isValid;
          const open = !collapsed.value.has(r.node.entity);
          return (
            <li key={r.node.entity} role="treeitem" aria-selected={isSelected} aria-expanded={r.children > 0 ? open : undefined} aria-level={r.depth + 1}>
              <div
                class={`row${isSelected ? " selected" : ""}${r.inactive ? " inactive" : ""}${r.kind ? ` live-${r.kind}` : ""}`}
                data-entity={r.node.entity}
                data-name={r.name}
                style={{ paddingLeft: `${r.depth * 14 + 4}px` }}
                onClick={() => choose(r.node)}
              >
                <span
                  class={`caret${r.children > 0 ? "" : " leaf"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (r.children > 0) toggle(r.node.entity);
                  }}
                >
                  {r.children > 0 ? (open ? "▾" : "▸") : ""}
                </span>
                <span class="name">{r.name}</span>
                {r.badge && (
                  <span class={`badge live-kind-${r.kind}`} title={r.detail ?? undefined}>
                    {r.badge}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
