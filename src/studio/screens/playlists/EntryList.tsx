// A playlist's entry list (the prototype's `.lrow` rows): a grip to drag an entry to another place (Alt+↑/↓ too) and
// its number, its type badge, its name with what it is ("Clip · 0.70 s"), a random Queue's weight with its share of
// the picks, a Blend's At weight 0 (Stop / Continue), the Voice button (the use's gain; its curves on a click, the curve
// menu on a right-click), a bar of its live level, Open and Remove. A click selects (the Inspector shows it), ↑/↓ move
// the selection, Enter or a double-click opens it, Del removes it, Ctrl+D duplicates it. The row menu has Open, Edit
// voice curves…, Move up / down, Duplicate, Make shared or Unlink, and Remove. A view over props: every change is a
// labelled edit handed to the owner.
import { useRef, useState } from "preact/hooks";
import type { Entry, PlaylistBody, SequenceSettings } from "../../../engine/audio/playlist/types";
import { ContextMenu, SEPARATOR, tidyEntries } from "../../../editor/ui/ContextMenu";
import { NumberBox } from "../../../editor/ui/PanelFields";
import type { EditResult } from "../../../editor/sdk/editResult";
import { Icon } from "../../components/Icon";
import { TypeBadge } from "../../components/TypeBadge";
import { entryMeta, pct, sequenceLength, shares } from "./entryRowModel";
import { AT_ZERO_GLYPHS, IconSegments } from "./glyphs";
import { duplicateEntry, moveEntry, setEntryUse, USE_LIMITS, type EditContext } from "./playlistEdits";
import { entryName } from "./playlistPaths";
import type { PlaylistFacts } from "./playlistTree";
import { VoiceButton } from "./VoiceButton";
import { EmptyState } from "../../../editor/ui/EmptyState";

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
  /** A linked or embedded entry's playlist (its meta line), when it can be read. */
  bodyOf?(e: Entry): PlaylistBody | null;
  /** A sample's length in seconds, null when unknown. */
  lengthOf?(sample: string): number | null;
  /** Live level per entry, 0..1 (a Blend's weights at the test values, or what the audition plays now). */
  readonly weights?: readonly number[];
  /** Only these entries (a Switch's entries no label plays); all when absent. */
  readonly only?: readonly number[];
}

/** A sequence entry's mini timeline (the prototype's `.mtl`): a bar per clip, one row per track, in the track's colour. */
function MiniTimeline(props: { readonly seq: SequenceSettings }) {
  const tracks = props.seq.tracks.slice(0, 4);
  const len = sequenceLength(props.seq) || 1;
  const h = 22 / Math.max(1, tracks.length);
  return (
    <svg class="pl-mtl" viewBox="0 0 1000 22" preserveAspectRatio="none" aria-hidden="true">
      {tracks.flatMap((t, k) => t.clips.map((c) => (
        <rect key={`${t.id}:${c.id}`} class={typeof t.color === "number" ? `studio-series-${((t.color - 1) % 8) + 1}` : undefined} style={typeof t.color === "string" ? { fill: t.color } : undefined}
          x={(c.at / len) * 1000} y={k * h + 1} width={Math.max(8, ((c.length > 0 ? c.length : 1) / len) * 1000 - 6)} height={Math.max(2, h - 2)} rx="2" />
      )))}
    </svg>
  );
}

const AT_ZERO = [
  { value: "stop" as const, label: "Stop", title: "Stop: stops, and restarts from the top when its weight returns", glyph: AT_ZERO_GLYPHS.stop },
  { value: "continue" as const, label: "Continue", title: "Continue: keeps its time silently", glyph: AT_ZERO_GLYPHS.continue },
];

export function EntryList(props: EntryListProps) {
  const { body, writable } = props;
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<{ from: number; to: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showWeight = body.type === "queue" && body.queue?.pick === "random";
  const showAtZero = body.type === "blend";
  const colA = body.type !== "layer" && body.type !== "switch";
  const reorderable = body.type !== "blend";
  const share = showWeight ? shares(body.entries) : [];
  const indices = props.only ?? body.entries.map((_, i) => i);

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
      if (hit >= 0) to = Number(rows[hit]!.dataset.entry);
      setDragging({ from, to });
    };
    const up = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      setDragging(null);
      if (ev.type !== "pointercancel" && to !== from) props.onEdit("Reorder entries", (b) => moveEntry(b, from, to));
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  };
  /** The row menu from the keyboard (the context-menu key or Shift+F10), placed at the row. */
  const menuAtRow = (i: number, row: HTMLElement) => {
    const r = row.getBoundingClientRect();
    props.onSelect(i);
    setMenu({ i, x: r.left + 24, y: r.bottom });
  };
  const focusRow = (i: number) => queueMicrotask(() => listRef.current?.querySelector<HTMLElement>(`[data-entry="${i}"]`)?.focus());
  const duplicate = (i: number) => writable && body.type !== "clip" && props.onEdit("Duplicate entry", (b) => duplicateEntry(b, i, props.ctx));

  if (body.entries.length === 0) {
    return <EmptyState compact title="No entries yet. Drag samples here from the Library, or use + to add one." />;
  }
  if (indices.length === 0) return null;

  const cols = `pl-lrow${colA ? "" : " na"}`;
  return (
    <div class="pl-entries" role="list" aria-label="Entries" ref={listRef}>
      <div class={`${cols} pl-lh`} aria-hidden="true">
        <span>#</span>
        <span />
        <span>Entry</span>
        {colA && <span title={showAtZero ? "What an entry does when its weight reaches 0: stop, or play on silently (so it comes back in step)" : undefined}>{showWeight ? "Weight" : showAtZero ? "When silent" : ""}</span>}
        <span title="Gain, pitch, pan and filters for each entry: values or curves over voice time. Gain is relative to the level prepared in Samples (0 dB = unchanged); gains add up along the playlists that contain this one, and the Mixer bus comes after.">Voice</span>
        <span class="pl-right">Now</span>
        <span />
      </div>
      {indices.map((i) => {
        const e = body.entries[i]!;
        const name = entryName(e, i);
        const inner = e.kind === "embedded" ? e.embedded : e.kind === "linked" ? (props.bodyOf?.(e) ?? null) : null;
        const facts = e.kind === "embedded" ? { type: e.embedded.type, axes: e.embedded.blend?.axes.length === 2 ? (2 as const) : (1 as const) } : e.kind === "linked" ? props.facts(e) : null;
        const meta = entryMeta(e, inner, props.lengthOf ?? (() => null));
        const w = Math.max(0, Math.min(1, props.weights?.[i] ?? 0));
        const opens = e.kind !== "sample" && e.kind !== "line" && e.kind !== "generator";
        return (
          <div
            key={i}
            role="listitem"
            data-entry={i}
            tabIndex={0}
            aria-current={props.selected === i ? "true" : undefined}
            aria-label={name}
            class={`${cols}${props.selected === i ? " on" : ""}${w > 0.001 ? " hot" : ""}${e.kind === "linked" ? " pl-linked" : ""}${dragging?.to === i && dragging.from !== i ? (dragging.to > dragging.from ? " dropa" : " dropb") : ""}${dragging?.from === i ? " dragging" : ""}${showWeight && e.weight === 0 ? " pl-muted" : ""}`}
            onClick={() => props.onSelect(i)}
            onDblClick={() => opens && props.onOpen(i)}
            onKeyDown={(ev) => {
              if (ev.target !== ev.currentTarget) return;
              const at = indices.indexOf(i);
              const mod = ev.ctrlKey || ev.metaKey;
              if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && reorderable && writable) {
                ev.preventDefault();
                props.onEdit("Reorder entries", (b) => moveEntry(b, i, i + (ev.key === "ArrowUp" ? -1 : 1)));
              } else if (!mod && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
                ev.preventDefault();
                const next = indices[Math.max(0, Math.min(indices.length - 1, at + (ev.key === "ArrowUp" ? -1 : 1)))]!;
                props.onSelect(next);
                focusRow(next);
              } else if (ev.key === "Enter" && opens) props.onOpen(i);
              else if ((ev.key === "Delete" || ev.key === "Backspace") && writable) {
                ev.preventDefault();
                props.onRemove(i);
              } else if (mod && ev.key.toLowerCase() === "d") {
                ev.preventDefault();
                duplicate(i);
              } else if (ev.key === "Escape" && props.selected !== null) {
                ev.stopPropagation();
                props.onSelect(null);
              } else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
                ev.preventDefault();
                menuAtRow(i, ev.currentTarget as HTMLElement);
              }
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              props.onSelect(i);
              setMenu({ i, x: ev.clientX, y: ev.clientY });
            }}
          >
            <span class="pl-lgr">
              <span class={`pl-grip${reorderable && writable ? "" : " off"}`} aria-hidden="true" title={reorderable ? "Drag to reorder (or Alt+↑/↓)" : "A Blend orders entries by position"} onPointerDown={(ev) => reorderable && startGrip(i, ev)}>
                <Icon name="grip" size={12} />
              </span>
              <span class="pl-index">{i + 1}</span>
            </span>
            {facts ? <TypeBadge playlist={facts.type} axes={facts.axes} /> : <TypeBadge sample />}
            <span class="pl-entry-name" title={e.kind === "linked" ? `Linked: ${e.playlist}` : e.kind === "sample" ? e.sample : name}>
              <span class="pl-entry-label">{name}</span>
              {meta && <span class="pl-row-meta"> · {meta}</span>}
              {inner?.type === "sequence" && inner.sequence && <MiniTimeline seq={inner.sequence} />}
              {e.kind === "linked" && <span class="pl-link-mark" title={`Linked copy of ${e.playlist}: edits to it change every playlist that links it`}><Icon name="link" size={12} label="Linked copy" /></span>}
            </span>
            {colA && (
              <span class="pl-cola">
                {showWeight && (
                  <>
                    <NumberBox class="pl-n40" label={`Weight of ${name}`} value={e.weight} min={USE_LIMITS.weight[0]} max={USE_LIMITS.weight[1]} step={1} digits={0} disabled={!writable} title={`Relative chance of being picked (0 never plays): ${pct(share[i] ?? 0)} of the picks`} onValue={(v) => props.onEdit("Weight", (b) => setEntryUse(b, i, { weight: v }))} />
                    <span class="pl-share">{pct(share[i] ?? 0)}</span>
                  </>
                )}
                {showAtZero && (
                  <IconSegments label={`At weight 0, ${name}`} value={e.atZeroWeight} options={AT_ZERO} disabled={!writable}
                    onChange={(v) => props.onEdit(`At weight 0: ${v === "stop" ? "Stop" : "Continue"}`, (b) => setEntryUse(b, i, { atZeroWeight: v }))} />
                )}
              </span>
            )}
            <VoiceButton use={e} name={name} writable={writable} onOpen={() => props.onEditCurves(i)} onCurves={(curves, label) => props.onEdit(label, (b) => setEntryUse(b, i, { curves }))} />
            <span class="pl-wb" role="meter" aria-label={`${name} level now`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w * 100)} title={`Now ${pct(w)}`}><em style={{ width: `${w * 100}%` }} /></span>
            <span class="pl-entry-actions">
              {opens && <button type="button" class="pl-ib" aria-label={`Open ${name}`} title={`Open ${name} (Enter)`} onClick={(ev) => (ev.stopPropagation(), props.onOpen(i))}><Icon name="chevronRight" size={12} /></button>}
              <button type="button" class="pl-ib" aria-label={`Remove ${name}`} title={e.kind === "linked" ? "Remove link (Del)" : "Remove (Del)"} disabled={!writable} onClick={(ev) => (ev.stopPropagation(), props.onRemove(i))}><Icon name="trash" size={12} /></button>
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
            { kind: "group", label: entryName(body.entries[menu.i]!, menu.i) },
            body.entries[menu.i]!.kind !== "sample" && { id: "open", label: "Open", hint: "Enter", run: () => props.onOpen(menu.i) },
            { id: "curves", label: "Edit voice curves…", disabled: !writable, run: () => props.onEditCurves(menu.i) },
            SEPARATOR,
            reorderable && { id: "up", label: "Move up", hint: "Alt+↑", disabled: !writable || menu.i === 0, run: () => props.onEdit("Reorder entries", (b) => moveEntry(b, menu.i, menu.i - 1)) },
            reorderable && { id: "down", label: "Move down", hint: "Alt+↓", disabled: !writable || menu.i === body.entries.length - 1, run: () => props.onEdit("Reorder entries", (b) => moveEntry(b, menu.i, menu.i + 1)) },
            { id: "dup", label: "Duplicate", hint: "Ctrl+D", disabled: !writable || body.type === "clip", run: () => duplicate(menu.i) },
            body.entries[menu.i]!.kind === "embedded" && { id: "share", label: "Make shared", title: "Give it a file of its own so other playlists can link it", disabled: !writable, run: () => props.onMakeShared(menu.i) },
            body.entries[menu.i]!.kind === "linked" && { id: "unlink", label: "Unlink (make a separate copy)", title: "Turn this linked copy into its own playlist inside this one", disabled: !writable, run: () => props.onUnlink(menu.i) },
            SEPARATOR,
            { id: "remove", label: body.entries[menu.i]!.kind === "linked" ? "Remove link" : "Remove", hint: "Del", danger: true, disabled: !writable, run: () => props.onRemove(menu.i) },
          ])}
        />
      )}
    </div>
  );
}
