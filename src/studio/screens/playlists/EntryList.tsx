// A playlist's entry list (the prototype's entry rows): a grip to drag an entry to another place (Alt+↑/↓ too), its
// type badge and name (linked ones dashed), a weight for a random Queue (0 never plays), volume and pitch per use, what
// happens at weight 0 for a Blend, › to open it and × to remove it. A click selects (the Inspector shows it); a
// double-click opens it. The row menu has Open, Edit voice curves…, Move up / down, Duplicate, Make shared or Unlink,
// and Remove. A view over props: every change is a labelled edit handed to the owner.
import { useRef, useState } from "preact/hooks";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { ContextMenu, SEPARATOR, tidyEntries } from "../../../editor/ui/ContextMenu";
import type { EditResult } from "../../../editor/sdk/editResult";
import { TypeBadge } from "../../components/TypeBadge";
import { NumberBox, SelectBox } from "../../../editor/ui/PanelFields";
import { duplicateEntry, moveEntry, setEntryUse, USE_LIMITS, type EditContext } from "./playlistEdits";
import { entryName } from "./playlistPaths";
import type { PlaylistFacts } from "./playlistTree";

export type BodyEdit = (b: PlaylistBody) => EditResult<PlaylistBody>;

export interface EntryActions {
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onSelect(index: number | null): void;
  onOpen(index: number): void;
  onRemove(index: number): void;
  onMakeShared(index: number): void;
  onUnlink(index: number): void;
  onEditCurves(index: number): void;
}

export interface EntryListProps extends EntryActions {
  readonly body: PlaylistBody;
  readonly selected: number | null;
  readonly writable: boolean;
  readonly ctx: EditContext;
  /** A linked entry's playlist facts (its badge), when it can be read. */
  facts(e: Entry): PlaylistFacts | null;
  /** Live weights per entry (a Blend's at the test values), drawn as a bar. */
  readonly weights?: readonly number[];
}

export function EntryList(props: EntryListProps) {
  const { body, writable } = props;
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ from: number; to: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showWeight = body.type === "queue" && body.queue?.pick === "random";
  const showAtZero = body.type === "blend";
  const reorderable = body.type !== "blend";

  const startGrip = (from: number, e: PointerEvent) => {
    if (!writable || e.button !== 0) return;
    e.preventDefault();
    const doc = (e.currentTarget as HTMLElement).ownerDocument;
    let to = from;
    const move = (ev: PointerEvent) => {
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])];
      const hit = rows.findIndex((r) => {
        const rect = r.getBoundingClientRect();
        return ev.clientY >= rect.top && ev.clientY < rect.bottom;
      });
      if (hit >= 0) to = hit;
      setDragging({ from, to });
    };
    const up = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      setDragging(null);
      if (to !== from) props.onEdit("Reorder entries", (b) => moveEntry(b, from, to));
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
  };

  if (body.entries.length === 0) return <p class="pl-note pl-entries-empty">No entries yet. Add samples or playlists with Add…, or drag samples here from the Library.</p>;

  return (
    <div class="pl-entries" role="list" aria-label="Entries" ref={listRef}>
      <div class="pl-entry pl-entry-head" aria-hidden="true">
        <span />
        <span>Entry</span>
        {showWeight && <span>Weight</span>}
        <span>Vol</span>
        <span>Pitch</span>
        {showAtZero && <span>At weight 0</span>}
        <span />
      </div>
      {body.entries.map((e, i) => {
        const name = entryName(e, i);
        const facts = e.kind === "embedded" ? { type: e.embedded.type, axes: e.embedded.blend?.axes.length === 2 ? (2 as const) : (1 as const) } : e.kind === "linked" ? props.facts(e) : null;
        const w = props.weights?.[i];
        return (
          <div
            key={i}
            role="listitem"
            data-entry={i}
            tabIndex={0}
            aria-selected={props.selected === i}
            class={`pl-entry${props.selected === i ? " selected" : ""}${e.kind === "linked" ? " pl-linked" : ""}${dragging?.to === i && dragging.from !== i ? " pl-drop-here" : ""}${dragging?.from === i ? " dragging" : ""}${showWeight && e.weight === 0 ? " pl-muted" : ""}`}
            onClick={() => props.onSelect(i)}
            onDblClick={() => props.onOpen(i)}
            onKeyDown={(ev) => {
              if (ev.target !== ev.currentTarget) return;
              if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && reorderable && writable) {
                ev.preventDefault();
                props.onEdit("Reorder entries", (b) => moveEntry(b, i, i + (ev.key === "ArrowUp" ? -1 : 1)));
              } else if (ev.key === "Enter") props.onOpen(i);
              else if (ev.key === "Delete" && writable) props.onRemove(i);
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              props.onSelect(i);
              setMenu({ i, x: ev.clientX, y: ev.clientY });
            }}
          >
            <span class={`pl-grip${reorderable && writable ? "" : " off"}`} aria-hidden="true" title={reorderable ? "Drag to reorder (or Alt+↑/↓)" : "A Blend orders entries by position"} onPointerDown={(ev) => reorderable && startGrip(i, ev)}>
              ⋮⋮
            </span>
            <span class="pl-entry-name" title={e.kind === "linked" ? `Linked: ${e.playlist}` : e.kind === "embedded" ? "Embedded" : e.kind === "line" || e.kind === "generator" ? name : e.sample}>
              {facts ? <TypeBadge playlist={facts.type} axes={facts.axes} /> : <TypeBadge sample />}
              <span class="pl-entry-label">{name}</span>
              {e.kind === "linked" && <span class="pl-link-mark" aria-label="Linked copy">⛓</span>}
              {Object.keys(e.curves).length > 0 && <span class="pl-row-meta" title="Has voice curves">~</span>}
              {w !== undefined && <span class="pl-weight-bar" style={{ "--w": String(Math.max(0, Math.min(1, w))) }} title={`Weight now ${(w * 100).toFixed(0)} %`} />}
            </span>
            {showWeight && (
              <NumberBox label={`Weight of ${name}`} value={e.weight} min={USE_LIMITS.weight[0]} max={USE_LIMITS.weight[1]} step={1} digits={0} disabled={!writable} title="0 never plays" onValue={(v) => props.onEdit("Weight", (b) => setEntryUse(b, i, { weight: v }))} />
            )}
            <NumberBox label={`Volume of ${name}`} value={e.volume} min={USE_LIMITS.volume[0]} max={USE_LIMITS.volume[1]} step={0.5} digits={1} disabled={!writable} title="dB" onValue={(v) => props.onEdit("Change setting", (b) => setEntryUse(b, i, { volume: v }))} />
            <NumberBox label={`Pitch of ${name}`} value={e.pitch} min={USE_LIMITS.pitch[0]} max={USE_LIMITS.pitch[1]} step={1} digits={2} disabled={!writable} title="semitones" onValue={(v) => props.onEdit("Change setting", (b) => setEntryUse(b, i, { pitch: v }))} />
            {showAtZero && (
              <SelectBox
                label={`At weight 0, ${name}`}
                value={e.atZeroWeight}
                disabled={!writable}
                title="Stop: restarts from the top when its weight returns. Continue: keeps its time silently."
                options={[{ value: "stop", label: "Stop" }, { value: "continue", label: "Continue" }]}
                onValue={(v) => props.onEdit(`At weight 0: ${v === "stop" ? "Stop" : "Continue"}`, (b) => setEntryUse(b, i, { atZeroWeight: v }))}
              />
            )}
            <span class="pl-entry-actions">
              {e.kind !== "sample" && <button type="button" class="pl-icon" aria-label={`Open ${name}`} title="Open" onClick={(ev) => (ev.stopPropagation(), props.onOpen(i))}>›</button>}
              <button type="button" class="pl-icon" aria-label={`Remove ${name}`} title={e.kind === "linked" ? "Remove link" : "Remove"} disabled={!writable} onClick={(ev) => (ev.stopPropagation(), props.onRemove(i))}>×</button>
            </span>
          </div>
        );
      })}
      {menu && body.entries[menu.i] && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          label="Entry menu"
          onClose={() => setMenu(null)}
          entries={tidyEntries([
            body.entries[menu.i]!.kind !== "sample" && { id: "open", label: "Open", run: () => props.onOpen(menu.i) },
            { id: "curves", label: "Edit voice curves…", disabled: !writable, run: () => props.onEditCurves(menu.i) },
            SEPARATOR,
            reorderable && { id: "up", label: "Move up", disabled: !writable || menu.i === 0, run: () => props.onEdit("Reorder entries", (b) => moveEntry(b, menu.i, menu.i - 1)) },
            reorderable && { id: "down", label: "Move down", disabled: !writable || menu.i === body.entries.length - 1, run: () => props.onEdit("Reorder entries", (b) => moveEntry(b, menu.i, menu.i + 1)) },
            { id: "dup", label: "Duplicate", disabled: !writable || body.type === "clip", run: () => props.onEdit("Duplicate entry", (b) => duplicateEntry(b, menu.i, props.ctx)) },
            body.entries[menu.i]!.kind === "embedded" && { id: "share", label: "Make shared", disabled: !writable, run: () => props.onMakeShared(menu.i) },
            body.entries[menu.i]!.kind === "linked" && { id: "unlink", label: "Unlink", disabled: !writable, run: () => props.onUnlink(menu.i) },
            SEPARATOR,
            { id: "remove", label: body.entries[menu.i]!.kind === "linked" ? "Remove link" : "Remove", danger: true, disabled: !writable, run: () => props.onRemove(menu.i) },
          ])}
        />
      )}
    </div>
  );
}
