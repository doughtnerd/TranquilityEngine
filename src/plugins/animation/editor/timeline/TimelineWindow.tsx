// The Timeline window (ADR 0373): a dockable panel editing the timeline of the selected TimelineDirector or an opened
// `*.timeline.json`. A toolbar (breadcrumb of nested timelines, preview, play and loop, the timeline's length and loop,
// add track and property), the grid (the shared `DopeSheetGrid`: a heading per bound node with its binding picker, a row
// per track, clips as bars that move, trim at their ends and ease in and out, blend regions where clips overlap, instant
// keys as diamonds), the selection's tools (split, duplicate, delete, blend to overlap, camera cut) and the editor of the
// one selected item. Every edit is one labelled undo step on the timeline's asset document; the rules are the logic
// modules' (`timelineModelLogic.ts`, `timelineEditLogic.ts`). Dropping clips, timelines or audio from the Assets panel on
// a row adds them there.
import { effect } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listComponents } from "../../../../engine/editor";
import type { Timeline } from "../../../../engine/animation/timeline";
import { snapToFrame } from "../../../../engine/animation/compile/frames";
import { Assets } from "../../../../engine/scene/Assets";
import { parseAnimSource } from "../../../../engine/animation/animSource";
import { parseTimeline } from "../../../../engine/animation/timeline";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { AssetPicker, DopeSheetGrid, editor, EmptyState, Panel, registerAssetDropTarget, type DopeRow, type DopeSelectMode, type EditResult } from "../../../../editor/sdk";
import { propertyChoices, type NodeFields } from "../animationWindow/addTrackLogic";
import { fieldPathValue, nodePathOf, parseFieldPath } from "../../../../engine/animation/bindingPath";
import "../animationWindow/animationWindow.css";
import { BindingPicker } from "./BindingPicker";
import { ItemEditor } from "./ItemEditor";
import {
  addCameraCut, addItem, addPropertyTrack, addTrack, asClip, assetDropKind, blendToOverlap, deleteItems, dragEdit, dragLabel, dropAssets, duplicateItems, keyProperty, moveTrack, rebindGroup, removeTrack,
  setBinding, setDuration, setLoop, splitItem, type AddableKind, type DragPart, type ItemsResult,
} from "./timelineEditLogic";
import { bindingProblem, parseItemId, refName, timelineRows, trackNodePath, type TimelineRow } from "./timelineModelLogic";
import { timelineSession as s, type TimelineTarget } from "./timelineSession";
import "./timelineWindow.css";

const seconds = (t: number) => `${t.toFixed(2)} s`;
const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The panel: the window bound to what the session finds, or how to bind it. */
export function TimelineWindow() {
  useEffect(() => {
    s.open.value = true;
    return () => {
      s.open.value = false;
      s.setPreview(false);
    };
  }, []);
  const target = s.target.value;
  const doc = s.document.value;
  if (target.kind === "none") {
    return (
      <Panel>
        <EmptyState compact title="Nothing to edit" body={target.why} />
      </Panel>
    );
  }
  if (!doc) {
    const file = s.file.value;
    return (
      <Panel>
        <>
          <Breadcrumb />
          <EmptyState
            compact
            title={file ? "Not an editable timeline" : "No timeline"}
            body={file ? `${file} isn't a timeline (*.timeline.json) in this project.` : "This TimelineDirector has no timeline. Set its Timeline field, or create one in the Assets panel."}
          />
        </>
      </Panel>
    );
  }
  return (
    <Panel bodyClass="aw-body">
      <TimelineEditor key={doc.path} target={target} timeline={doc.value.value} readOnly={doc.readOnly} file={doc.path} />
    </Panel>
  );
}

/** The nested timelines' breadcrumb: each crumb leads back to that level. */
function Breadcrumb() {
  const crumbs = s.crumbs.value;
  if (!crumbs.length) return null;
  return (
    <nav class="tw-crumbs" aria-label="Timeline path">
      {crumbs.map((c, i) => (
        <span key={c.path} class="tw-crumb">
          {i > 0 && <span class="aw-muted" aria-hidden="true">›</span>}
          {i === crumbs.length - 1 ? (
            <b aria-current="page" title={c.path}>{c.label}</b>
          ) : (
            <button type="button" class="aw-tb" title={`Back to ${c.path}`} onClick={() => s.goTo(c.stack)}>
              {c.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The nodes under the director with their components, for the Add Property list. */
function nodesUnder(root: GameObject): NodeFields[] {
  const out: NodeFields[] = [];
  const walk = (n: GameObject) => {
    const path = nodePathOf(root, n);
    if (path === null) return;
    out.push({ path, components: listComponents(n).map((c) => ({ type: c.type, fields: c.fields.map((f) => ({ name: f.name, value: f.value })) })) });
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** A clip's or timeline's own length from the project's files (undefined when unreadable). */
function lengthOf(path: string): number | undefined {
  try {
    if (!Assets.has(path)) return undefined;
    const raw = Assets.json(path);
    return (path.toLowerCase().endsWith(".timeline.json") ? parseTimeline(raw).value : parseAnimSource(raw).value).duration;
  } catch {
    return undefined;
  }
}

/** A drag of selected items in progress: the timeline and selection it started from, and what it shows now. */
interface Drag {
  readonly base: Timeline;
  readonly selection: readonly string[];
  shown: ItemsResult | null;
}

const ADD_TRACKS: readonly { readonly kind: AddableKind; readonly label: string }[] = [
  { kind: "subclip", label: "Animation / nested timeline" },
  { kind: "audio", label: "Audio" },
  { kind: "activation", label: "Activation" },
  { kind: "control", label: "Control" },
  { kind: "event", label: "Signals" },
  { kind: "marker", label: "Markers" },
];

function TimelineEditor(props: { target: Exclude<TimelineTarget, { kind: "none" }>; timeline: Timeline; readOnly: boolean; file: string }) {
  const { target, file } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const tl = drag?.shown?.timeline ?? props.timeline;
  const selection = drag?.shown?.selection ?? s.selection.value;
  const t = s.playhead.time.value;
  const playing = s.playhead.playing.value;
  const previewing = s.previewing.value;
  const root = target.kind === "director" ? target.node : null;
  const rootName = root?.name ?? "Self";
  const rows = useMemo(() => timelineRows(tl, rootName), [tl, rootName]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const [group, setGroup] = useState<string | null>(null);
  const [length, setLength] = useState<string | null>(null);

  // The playhead follows the timeline's length and the loop flag; the frame clock advances it while playing.
  useEffect(() => s.playhead.setTiming({ duration: props.timeline.duration, looping: s.loop.value, known: true }), [props.timeline.duration, s.loop.value]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      s.playhead.advance((now - last) / 1000);
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  // The preview shows the timeline at the playhead whenever either changes.
  useEffect(() => effect(() => (s.playhead.time.value, s.document.value?.value.value, s.previewing.value, s.show())), []);

  const apply = (result: EditResult<Timeline>, label: string) => s.apply(result, label);
  const applyItems = (result: EditResult<ItemsResult>, label: string) => {
    if (s.apply("refused" in result ? result : { next: result.next.timeline }, label) && "next" in result) s.selection.value = result.next.selection;
  };

  const select = (ids: readonly string[], mode: DopeSelectMode) => {
    const cur = new Set(s.selection.peek());
    if (mode === "replace") return void (s.selection.value = [...ids]);
    for (const id of ids) mode === "add" ? cur.add(id) : cur.has(id) ? cur.delete(id) : cur.add(id);
    s.selection.value = [...cur];
  };
  const frame = (dt: number) => Math.round(dt * tl.rate) / tl.rate;
  const onDrag = (phase: "start" | "move" | "end" | "cancel", part: DragPart, dx: number, alt: boolean, id: string) => {
    if (props.readOnly) return;
    if (phase === "start") {
      const cur = s.selection.peek();
      dragRef.current = { base: props.timeline, selection: part === "move" && cur.includes(id) ? cur : [id], shown: null };
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    const dt = alt ? dx : frame(dx);
    if (phase === "move") {
      const r = dragEdit(d.base, d.selection, part, id, dt);
      d.shown = "next" in r ? r.next : null;
      setDrag({ ...d });
      return;
    }
    dragRef.current = null;
    setDrag(null);
    if (phase === "end" && dt !== 0) applyItems(dragEdit(d.base, d.selection, part, id, dt), dragLabel(part, d.selection.length));
  };

  const activeRow = rows.find((r) => r.id === s.activeRow.value) ?? null;
  const activeTrack = activeRow?.track ?? null;
  const single = selection.length === 1 ? selection[0]! : null;
  const choices = root ? propertyChoices(asClip(tl), nodesUnder(root), rootName) : [];
  const actions = {
    delete: () => selection.length && apply(deleteItems(props.timeline, s.selection.peek()), "Delete items") && (s.selection.value = []),
    duplicate: () => applyItems(duplicateItems(props.timeline, s.selection.peek()), "Duplicate items"),
    split: () => {
      const ids = s.selection.peek();
      if (ids.length !== 1) return editor.messages.error("Can't split the clip: select one clip");
      applyItems(splitItem(props.timeline, ids[0]!, t), "Split clip");
    },
  };

  // The blend region between the two selected clips of one track, if they overlap.
  const pair = (() => {
    const refs = selection.map(parseItemId);
    if (refs.length !== 2 || refs.some((r) => !r || r.kind !== "key") || refs[0]!.track !== refs[1]!.track) return null;
    const [a, b] = [refs[0]!, refs[1]!].sort((x, y) => (x as { index: number }).index - (y as { index: number }).index) as { track: number; index: number }[];
    return tl.tracks[a!.track]?.kind === "subclip" ? { track: a!.track, a: a!.index, b: b!.index } : null;
  })();

  // Assets dropped from the Assets panel land on the row under the pointer, at the pointer's time.
  const gridRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ tl, rows, readOnly: props.readOnly, file, rootName });
  latest.current = { tl, rows, readOnly: props.readOnly, file, rootName };
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    /** The row and time under a client point. */
    const at = (x: number, y: number) => {
      const row = (el.ownerDocument.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-row]");
      const lane = row ?? el.querySelector<HTMLElement>("[data-row]");
      const r = lane?.getBoundingClientRect();
      const { tl: cur, rows: rs } = latest.current;
      const time = r && r.width > 0 ? snapToFrame(Math.min(Math.max((x - r.left) / r.width, 0), 1) * cur.duration, cur.rate, cur.duration) : 0;
      const hit = rs.find((q) => q.id === row?.dataset.row);
      return { time, row: hit ?? null };
    };
    const place = (assets: readonly string[], x: number, y: number) => {
      const { tl: cur, file: self } = latest.current;
      const p = at(x, y);
      const group = p.row?.heading ? (p.row.group ?? "") : p.row?.track != null ? (trackNodePath(cur.tracks[p.row.track]!) ?? "") : "";
      return dropAssets(cur, assets, p.row?.heading ? null : p.row?.track ?? null, group, p.time, self, lengthOf);
    };
    return registerAssetDropTarget(el, {
      accepts: (assets) => !latest.current.readOnly && assets.length > 0 && assets.every((a) => assetDropKind(a) !== null),
      label: (assets, pt) => {
        const r = place(assets, pt.x, pt.y);
        return "refused" in r ? null : `Add ${assets.length > 1 ? `${assets.length} items` : refName(assets[0]!)} at ${seconds(at(pt.x, pt.y).time)}`;
      },
      drop: (assets, pt) => applyItems(place(assets, pt.x, pt.y), "Drop on timeline"),
    });
  }, [target.kind === "director" ? target.node : null]);

  const gridRows: DopeRow[] = rows.map((r: TimelineRow) => {
    const trackProblem = root && r.track !== null ? bindingProblem(root, trackNodePath(tl.tracks[r.track]!) ?? "") : null;
    return {
      id: r.id,
      label: r.label,
      depth: r.depth,
      heading: r.heading,
      color: r.color ? `var(--series-${r.color})` : undefined,
      muted: !!trackProblem,
      title: trackProblem ?? undefined,
      keys: r.items.filter((i) => !i.bar).map((i) => ({ id: i.id, x: i.from, label: i.label })),
      bars: r.items.filter((i) => i.bar).map((i) => ({ id: i.id, from: i.from, to: i.to, label: i.label, easeIn: i.blendIn, easeOut: i.blendOut })),
      spans: r.blends.map((b) => ({ id: b.id, from: b.from, to: b.to, label: `Blend ${seconds(b.from)} – ${seconds(b.to)}`, blend: true })),
    };
  });

  return (
    <div
      class="aw-root"
      // The timeline's document is the active history while the window has the focus: Undo / Redo act on its steps (ADR 0145).
      data-asset-document={s.document.value?.path}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, select, textarea")) return;
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Delete" || e.key === "Backspace") actions.delete();
        else if (mod && e.key.toLowerCase() === "d") actions.duplicate();
        else if (!mod && e.key.toLowerCase() === "s") actions.split();
        else if (e.key === " ") s.playhead.toggle();
        else return;
        e.preventDefault();
      }}
    >
      <div class="aw-toolbar" role="toolbar" aria-label="Timeline">
        <Breadcrumb />
        <span class="aw-sep" />
        <button type="button" class={`aw-tb${previewing ? " on" : ""}`} aria-pressed={previewing} disabled={target.kind !== "director"} title={target.kind === "director" ? "Preview the timeline on the director in the scene view" : "Select a node with a TimelineDirector to preview on it"} onClick={() => s.setPreview(!previewing)}>
          Preview
        </button>
        <button type="button" class="aw-tb" aria-label="To start" title="To the start" onClick={() => s.seek(0)}>
          ⏮
        </button>
        <button type="button" class={`aw-tb${playing ? " on" : ""}`} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={() => (playing ? s.playhead.pause() : (s.setPreview(target.kind === "director" || previewing), s.playhead.play()))}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" class={`aw-tb${s.loop.value ? " on" : ""}`} aria-label="Loop" aria-pressed={s.loop.value} title="Loop the playback" onClick={() => (s.loop.value = !s.loop.value)}>
          ⟲
        </button>
        <span class="aw-time" aria-label="Playhead">
          <b>{seconds(t)}</b> / {seconds(tl.duration)} · frame {Math.round(t * tl.rate)}
        </span>
        <span class="aw-sep" />
        <label class="aw-num">
          Length (s)
          <input
            type="number"
            min={1 / tl.rate}
            step={1}
            aria-label="Length"
            disabled={props.readOnly}
            value={length ?? props.timeline.duration}
            onInput={(e) => setLength((e.currentTarget as HTMLInputElement).value)}
            onChange={(e) => {
              setLength(null);
              apply(setDuration(props.timeline, Number((e.currentTarget as HTMLInputElement).value)), "Set timeline length");
            }}
          />
        </label>
        <label class="aw-num" title="The timeline plays again from the start when it ends (a director's wrap mode can override).">
          <input type="checkbox" checked={tl.loop} disabled={props.readOnly} onChange={(e) => apply(setLoop(props.timeline, (e.currentTarget as HTMLInputElement).checked), "Set timeline loop")} />
          Loops
        </label>
        <span class="aw-spacer" />
        {root && (
          <select
            aria-label="Add property"
            value=""
            disabled={props.readOnly || !choices.length}
            onChange={(e) => {
              const c = choices[Number((e.currentTarget as HTMLSelectElement).value)];
              if (c) apply(addPropertyTrack(props.timeline, c.binding, c.value), `Add track: ${c.label}`);
            }}
          >
            <option value="">Add property…</option>
            {choices.map((c, i) => (
              <option key={c.label} value={i}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Add track"
          value=""
          disabled={props.readOnly}
          onChange={(e) => {
            const kind = (e.currentTarget as HTMLSelectElement).value as AddableKind;
            const node = activeRow?.group ?? group ?? (activeTrack !== null ? trackNodePath(props.timeline.tracks[activeTrack]!) : null) ?? "";
            if (kind) apply(addTrack(props.timeline, { kind, nodePath: node }), `Add ${kind === "subclip" ? "animation" : kind} track`);
          }}
        >
          <option value="">Add track…</option>
          {ADD_TRACKS.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      {!rows.length ? (
        <EmptyState compact title="No tracks yet" body={root ? "Add a track or a property, or drop animation clips, timelines and audio from the Assets panel." : "Add a track, or drop animation clips, timelines and audio from the Assets panel. Select a node with a TimelineDirector to bind tracks to nodes."} />
      ) : (
        <div class="tw-grid" ref={gridRef}>
          <DopeSheetGrid
            length={tl.duration}
            rows={gridRows}
            selected={selected}
            activeRow={s.activeRow.value}
            playhead={t}
            axisName="Timeline"
            nameWidth={190}
            onPlayhead={(x) => s.seek(x)}
            onRow={(id) => {
              s.activeRow.value = id;
              const r = rows.find((x) => x.id === id);
              setGroup(r?.heading ? r.group : null);
            }}
            onSelect={select}
            onDrag={(phase, dx, alt, key) => onDrag(phase, "move", dx, alt, key)}
            onBarDrag={(phase, part, dx, alt, id) => onDrag(phase, part, dx, alt, id)}
            onBarOpen={(id) => {
              const ref = parseItemId(id);
              const track = ref && tl.tracks[ref.track];
              const key = track?.kind === "subclip" && ref?.kind === "key" ? track.keys[ref.index] : undefined;
              if (key) s.openInner(key.clip);
            }}
            aside={(row) => {
              const r = rows.find((x) => x.id === row.id);
              if (!r || props.readOnly) return null;
              if (r.heading) {
                if (r.group === null) return null;
                return <BindingPicker path={r.group} root={root} label={`Binding of ${r.label}`} onPick={(p) => apply(rebindGroup(props.timeline, r.group!, p), "Bind tracks to node")} />;
              }
              return (
                <button type="button" class="aw-x" aria-label={`Remove track ${r.label}`} title="Remove this track" onClick={() => (apply(removeTrack(props.timeline, r.track!), `Remove track ${r.label}`), (s.selection.value = []))}>
                  ×
                </button>
              );
            }}
          />
        </div>
      )}
      <div class="aw-selbar" role="toolbar" aria-label="Items">
        <span class="aw-muted">{selection.length ? `${selection.length} item${selection.length === 1 ? "" : "s"} selected` : "No items selected"}</span>
        <button type="button" class="aw-tb" disabled={selection.length !== 1 || props.readOnly} title="Cut the selected clip in two at the playhead (S)" onClick={actions.split}>
          Split
        </button>
        <button type="button" class="aw-tb" disabled={!selection.length || props.readOnly} title="Copy the selection to follow itself (Ctrl+D)" onClick={actions.duplicate}>
          Duplicate
        </button>
        <button type="button" class="aw-tb" disabled={!selection.length || props.readOnly} onClick={actions.delete}>
          Delete
        </button>
        <button type="button" class="aw-tb" disabled={!pair || props.readOnly} title="Select two overlapping clips, then set their ease-out and ease-in to the overlap" onClick={() => pair && applyItems(blendToOverlap(props.timeline, pair.track, pair.a, pair.b), "Blend clips to overlap")}>
          Blend to overlap
        </button>
        <span class="aw-sep" />
        <button
          type="button"
          class="aw-tb"
          disabled={!root || props.readOnly}
          title="Cut to the camera selected in the hierarchy at the playhead"
          onClick={() => {
            const node = editor.scene.selection.node();
            const rel = root && node ? nodePathOf(root, node) : null;
            if (rel === null || !node) return editor.messages.error("Can't add a camera cut: select a camera node under the director first");
            applyItems(addCameraCut(props.timeline, t, rel), "Add camera cut");
          }}
        >
          Cut to camera
        </button>
        <AddAtPlayhead timeline={props.timeline} track={activeTrack} at={t} root={root} file={file} readOnly={props.readOnly} onItems={applyItems} onApply={apply} />
        {activeTrack !== null && props.timeline.tracks[activeTrack] && (
          <TrackTools timeline={props.timeline} track={activeTrack} root={root} t={t} readOnly={props.readOnly} onApply={apply} />
        )}
      </div>
      {single && <ItemEditor timeline={props.timeline} id={single} root={root} file={file} onItems={applyItems} onApply={apply} onOpen={(ref) => s.openInner(ref)} />}
    </div>
  );
}

/** "Add … at playhead" for the picked track: a clip or audio from the project, a signal's method, a marker, a span, a control. */
function AddAtPlayhead(props: { timeline: Timeline; track: number | null; at: number; root: GameObject | null; file: string; readOnly: boolean; onItems(r: EditResult<ItemsResult>, label: string): void; onApply(r: EditResult<Timeline>, label: string): void }) {
  const [text, setText] = useState("");
  const track = props.track !== null ? props.timeline.tracks[props.track] : undefined;
  if (!track || props.track === null) return null;
  const index = props.track;
  const add = (item: Parameters<typeof addItem>[3], label: string) => props.onItems(addItem(props.timeline, index, props.at, item, props.file), label);
  switch (track.kind) {
    case "subclip":
      return (
        <span class="tw-add">
          <AssetPicker value="" kinds={["animclip", "timeline"]} label="Add clip at playhead" none="Add clip at playhead…" accepts={(p) => p !== props.file} class="tw-add-pick" disabled={props.readOnly} onCommit={(v) => v && add({ kind: "subclip", clip: v, length: lengthOf(v.replace(/^asset:/, "")) }, "Add clip")} />
        </span>
      );
    case "audio":
      return (
        <span class="tw-add">
          <AssetPicker value="" kinds={["audio", "playlist"]} label="Add audio at playhead" none="Add audio at playhead…" class="tw-add-pick" disabled={props.readOnly} onCommit={(v) => v && add({ kind: "audio", audio: v }, "Add audio")} />
        </span>
      );
    case "activation":
      return (
        <button type="button" class="aw-tb" disabled={props.readOnly} onClick={() => add({ kind: "activation" }, "Add activation span")}>
          Add span at playhead
        </button>
      );
    case "event":
      return (
        <span class="tw-add">
          <input type="text" class="aw-method" aria-label="Signal method" placeholder="method" value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
          <button type="button" class="aw-tb" disabled={props.readOnly} onClick={() => add({ kind: "event", method: text }, "Add signal")}>
            Add signal at playhead
          </button>
        </span>
      );
    case "marker":
      return (
        <button type="button" class="aw-tb" disabled={props.readOnly} onClick={() => add({ kind: "marker", markerKind: "cue" }, "Add marker")}>
          Add marker at playhead
        </button>
      );
    case "control":
      return props.root ? (
        <span class="tw-add">
          <BindingPicker path={text} root={props.root} label="Control target" onPick={setText} />
          <button type="button" class="aw-tb" disabled={props.readOnly} onClick={() => add({ kind: "control", action: "particlePlay", target: text }, "Add control")}>
            Add control at playhead
          </button>
        </span>
      ) : null;
    default:
      return null;
  }
}

/** Tools of the picked track: reorder, bind (one track) and key the field of a property track at the playhead. */
function TrackTools(props: { timeline: Timeline; track: number; root: GameObject | null; t: number; readOnly: boolean; onApply(r: EditResult<Timeline>, label: string): void }) {
  const { timeline: tl, track: index } = props;
  const track = tl.tracks[index]!;
  const node = trackNodePath(track);
  const property = track.kind !== "marker" && track.kind !== "bone" && "field" in track.target && track.target.field !== "" && track.target.component !== "";
  return (
    <>
      <span class="aw-sep" />
      {node !== null && (
        <label class="aw-num">
          Track node
          <BindingPicker path={node} root={props.root} label="Binding of the track" onPick={(p) => props.onApply(setBinding(tl, index, p), "Bind track to node")} />
        </label>
      )}
      <button type="button" class="aw-tb" aria-label="Move track up" title="Move the track up" disabled={props.readOnly || index === 0} onClick={() => props.onApply(moveTrack(tl, index, -1), "Move track up")}>
        ↑
      </button>
      <button type="button" class="aw-tb" aria-label="Move track down" title="Move the track down" disabled={props.readOnly || index === tl.tracks.length - 1} onClick={() => props.onApply(moveTrack(tl, index, 1), "Move track down")}>
        ↓
      </button>
      {property && props.root && (
        <button
          type="button"
          class="aw-tb"
          disabled={props.readOnly}
          title="Key the field's value now at the playhead"
          onClick={() => {
            const b = (track as { target: { nodePath: string; component: string; field: string } }).target;
            const owner = nodesUnder(props.root!).find((n) => n.path === b.nodePath);
            const head = parseFieldPath(b.field).head;
            const whole = owner?.components.find((c) => c.type === b.component)?.fields.find((f) => f.name === head)?.value;
            props.onApply(keyProperty(tl, b, fieldPathValue(whole, b.field), props.t), `Key ${b.field}`);
          }}
        >
          Key at playhead
        </button>
      )}
    </>
  );
}
