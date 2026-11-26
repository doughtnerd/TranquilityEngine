// The Animation window (ADR 0373): a dockable panel editing the clip of the selected Animator (its default clip or one
// chosen here) or an opened `*.anim.json`. A toolbar (clip, preview, record, play/pause/loop, onion skin, add tracks,
// curves), the dope sheet (the shared `DopeSheetGrid`: rows per bound node, component and field, bone tracks, keys as
// diamonds, box select, drag to move) with the selection's tools (delete, copy, paste, scale, ripple), and the row
// editor of a selected event, marker, audio or activation key. Every edit is one labelled undo step on the clip's
// asset document; the rules are the logic modules' (`clipEditLogic.ts`, `rowEditorsLogic.ts`, `curveLanesLogic.ts`).
import { effect } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AnimSource } from "../../../../engine/animation/animSource";
import { listComponents } from "../../../../engine/editor";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { DopeSheetGrid, editor, EmptyState, openCurveEditorDialog, Panel, writeClipboard, type DopeRow, type DopeSelectMode, type EditResult } from "../../../../editor/sdk";
import { propertyChoices, type NodeFields } from "./addTrackLogic";
import { animationSession as s, relativePath, type WindowTarget } from "./animationSession";
import { addKeyedTrack, addPropertyTrack, copyKeys, deleteKeys, keysOfRows, moveKeys, pasteClipboard, removeTrack, ripple, rowsOfTrack, scaleSelectedKeys, type KeyedTrackKind, type KeysResult } from "./clipEditLogic";
import { applyCurveLanes, curveLanes } from "./curveLanesLogic";
import { DEFAULT_ONION, onionFrames, onionSprites } from "./onionSkinLogic";
import { RowEditor, ROW_EDITOR_KINDS } from "./RowEditor";
import { addRowKey } from "./rowEditorsLogic";
import { leafKeysOf, parseKeyId, parseRowId, summarySelected, trackRows, type TrackRow } from "./trackRowsLogic";
import "./animationWindow.css";

const seconds = (t: number) => `${t.toFixed(2)} s`;
const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The panel: the window bound to what the session finds, or how to bind it. */
export function AnimationWindow() {
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
        <EmptyState compact title="Nothing to animate" body={target.why} />
      </Panel>
    );
  }
  if (!doc) {
    return (
      <Panel>
        <>
          {target.kind === "animator" ? <ClipPicker target={target} /> : null}
          <EmptyState compact title={target.clip ? "Not an editable clip" : "No clip"} body={target.clip ? `${target.clip} isn't an authored clip (*.anim.json) in this project. Model clips are edited through their import settings.` : "This Animator has no default clip. Choose a clip, or set its Default Clip."} />
        </>
      </Panel>
    );
  }
  return (
    <Panel bodyClass="aw-body">
      <ClipEditor key={doc.path} target={target} clip={doc.value.value} readOnly={doc.readOnly} />
    </Panel>
  );
}

/** The bound Animator's clip choice: its default clip or another authored clip of the project. */
function ClipPicker(props: { target: Extract<WindowTarget, { kind: "animator" }> }) {
  const files = (editor.project.current?.files ?? []).filter((f) => f.toLowerCase().endsWith(".anim.json"));
  const key = props.target.path.join("/");
  const chosen = s.chosen.value.get(key) ?? "";
  return (
    <label class="aw-clip">
      <span class="aw-muted">Clip</span>
      <select
        aria-label="Clip"
        value={chosen}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          const next = new Map(s.chosen.peek());
          if (v) next.set(key, v);
          else next.delete(key);
          s.chosen.value = next;
          s.selection.value = [];
        }}
      >
        <option value="">Default clip{props.target.animator.defaultClip ? ` (${fileName(props.target.animator.defaultClip)})` : ""}</option>
        {files.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The nodes under the bound Animator with their components, for the Add Property list. */
function nodesUnder(root: GameObject): NodeFields[] {
  const out: NodeFields[] = [];
  const walk = (n: GameObject) => {
    const path = relativePath(root, n);
    if (path === null) return;
    out.push({ path, components: listComponents(n).map((c) => ({ type: c.type, fields: c.fields.map((f) => ({ name: f.name, value: f.value })) })) });
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** A drag of selected keys in progress: the clip and selection it started from, and the offset now. */
interface Drag {
  readonly base: AnimSource;
  readonly selection: readonly string[];
  shown: KeysResult | null;
}

function ClipEditor(props: { target: Exclude<WindowTarget, { kind: "none" }>; clip: AnimSource; readOnly: boolean }) {
  const { target } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const clip = drag?.shown?.clip ?? props.clip;
  const selection = drag?.shown?.selection ?? s.selection.value;
  const t = s.playhead.time.value;
  const playing = s.playhead.playing.value;
  const previewing = s.previewing.value;
  const recording = s.recording.value;
  const onion = s.onion.value;
  const [rippleBy, setRippleBy] = useState(0.25);
  const [scaleBy, setScaleBy] = useState(2);
  const [method, setMethod] = useState("");
  const rootName = target.kind === "animator" ? target.node.name : "Self";
  const rows = useMemo(() => trackRows(clip.tracks, { rootName }), [clip.tracks, rootName]);
  const selected = useMemo(() => {
    const set = new Set(selection);
    for (const id of summarySelected(rows, set)) set.add(id);
    return set;
  }, [rows, selection]);

  // The playhead follows the clip's length and loop flag; the frame clock advances it while playing.
  useEffect(() => s.playhead.setTiming({ duration: props.clip.duration, looping: s.loop.value, known: true }), [props.clip.duration, s.loop.value]);
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
  // The preview shows the clip at the playhead whenever either changes.
  useEffect(() => effect(() => (s.playhead.time.value, s.document.value?.value.value, s.previewing.value, s.show())), []);

  const apply = (result: EditResult<AnimSource>, label: string) => s.apply(result, label);
  const applyKeys = (result: EditResult<KeysResult>, label: string) => {
    if (s.apply("refused" in result ? result : { next: result.next.clip }, label) && "next" in result) s.selection.value = result.next.selection;
  };
  const select = (ids: readonly string[], mode: DopeSelectMode) => {
    const leaves = ids.flatMap((id) => leafKeysOf(rows, id));
    const cur = new Set(s.selection.peek());
    if (mode === "replace") return void (s.selection.value = leaves);
    if (mode === "add") leaves.forEach((l) => cur.add(l));
    else leaves.forEach((l) => (cur.has(l) ? cur.delete(l) : cur.add(l)));
    s.selection.value = [...cur];
  };
  const frame = (dt: number) => Math.round(dt * clip.rate) / clip.rate;
  const pasteTargets = () => {
    const active = s.activeRow.peek();
    const leaf = rows.filter((r) => r.channel);
    const from = Math.max(0, leaf.findIndex((r) => r.id === active || (rows.find((x) => x.id === active)?.leaves ?? []).includes(r.id)));
    return leaf.slice(from).map((r) => r.id);
  };
  const actions = {
    delete: () => apply(deleteKeys(props.clip, s.selection.peek()), "Delete keys") && (s.selection.value = []),
    copy: () => {
      const board = copyKeys(props.clip, s.selection.peek());
      if (!board) return editor.messages.error("Can't copy keys: no keys are selected");
      s.copied = board;
      writeClipboard(board);
    },
    paste: () => (s.copied ? applyKeys(pasteClipboard(props.clip, s.copied, pasteTargets(), t), "Paste keys") : editor.messages.error("Can't paste keys: nothing was copied")),
  };

  const activeRow = rows.find((r) => r.id === s.activeRow.value) ?? null;
  const activeTrack = activeRow?.track ?? null;
  const single = selection.length === 1 ? parseKeyId(selection[0]!) : null;
  const singleRow = single ? parseRowId(single.row) : null;
  const ghosts = onion ? onionFrames(t, clip, onion) : [];
  const sprites = onion ? onionSprites(clip, t, ghosts) : [];
  const choices = target.kind === "animator" ? propertyChoices(clip, nodesUnder(target.node), rootName) : [];

  const gridRows: DopeRow[] = rows.map((r: TrackRow) => ({
    id: r.id,
    label: r.label,
    depth: r.depth,
    heading: r.heading,
    color: r.color ? `var(--series-${r.color})` : undefined,
    keys: r.keys.map((k) => ({ id: k.id, x: k.t, label: k.label })),
    spans: r.spans,
  }));

  return (
    <div
      class="aw-root"
      // The clip's document is the active history while the window has the focus: Undo / Redo act on its steps (ADR 0145).
      data-asset-document={s.document.value?.path}
      tabIndex={0}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input, select, textarea")) return;
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Delete" || e.key === "Backspace") actions.delete();
        else if (mod && e.key.toLowerCase() === "c") actions.copy();
        else if (mod && e.key.toLowerCase() === "v") actions.paste();
        else if (e.key === " ") s.playhead.toggle();
        else return;
        e.preventDefault();
      }}
    >
      <div class="aw-toolbar" role="toolbar" aria-label="Animation">
        {target.kind === "animator" ? <ClipPicker target={target} /> : <span class="aw-file" title={target.clip}>{fileName(target.clip)}</span>}
        <span class="aw-sep" />
        <button type="button" class={`aw-tb${previewing ? " on" : ""}`} aria-pressed={previewing} disabled={target.kind !== "animator"} title={target.kind === "animator" ? "Preview the clip on the Animator in the scene view" : "Select a node with an Animator to preview on it"} onClick={() => s.setPreview(!previewing)}>
          Preview
        </button>
        <button type="button" class={`aw-tb aw-rec${recording ? " on" : ""}`} aria-pressed={recording} disabled={target.kind !== "animator" || props.readOnly} title="Record: changing an animatable field in the Inspector or with a gizmo writes a key at the playhead" onClick={() => s.setRecording(!recording)}>
          ● Record
        </button>
        <span class="aw-sep" />
        <button type="button" class="aw-tb" aria-label="To start" title="To the start" onClick={() => s.seek(0)}>
          ⏮
        </button>
        <button type="button" class={`aw-tb${playing ? " on" : ""}`} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={() => (playing ? s.playhead.pause() : (s.setPreview(target.kind === "animator" || previewing), s.playhead.play()))}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button type="button" class={`aw-tb${s.loop.value ? " on" : ""}`} aria-label="Loop" aria-pressed={s.loop.value} title="Loop the playback" onClick={() => (s.loop.value = !s.loop.value)}>
          ⟲
        </button>
        <span class="aw-time" aria-label="Playhead">
          <b>{seconds(t)}</b> / {seconds(clip.duration)} · frame {Math.round(t * clip.rate)}
        </span>
        <span class="aw-sep" />
        <button type="button" class={`aw-tb${onion ? " on" : ""}`} aria-pressed={!!onion} title="Onion skin: ghosts of the frames around the playhead" onClick={() => (s.onion.value = onion ? null : DEFAULT_ONION)}>
          Onion
        </button>
        {onion && (
          <span class="aw-onion" role="group" aria-label="Onion skin frames">
            <input type="number" min={0} max={8} aria-label="Frames before" value={onion.before} onChange={(e) => (s.onion.value = { ...onion, before: Number((e.currentTarget as HTMLInputElement).value) })} />
            <input type="number" min={0} max={8} aria-label="Frames after" value={onion.after} onChange={(e) => (s.onion.value = { ...onion, after: Number((e.currentTarget as HTMLInputElement).value) })} />
          </span>
        )}
        <span class="aw-spacer" />
        {target.kind === "animator" && (
          <select
            aria-label="Add property"
            value=""
            disabled={props.readOnly || !choices.length}
            onChange={(e) => {
              const c = choices[Number((e.currentTarget as HTMLSelectElement).value)];
              if (c) apply(addPropertyTrack(props.clip, c.binding, c.value), `Add track: ${c.label}`);
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
            const kind = (e.currentTarget as HTMLSelectElement).value as KeyedTrackKind;
            if (kind) apply(addKeyedTrack(props.clip, kind, activeRow?.track != null && kind === "activation" ? ((clip.tracks[activeRow.track] as { target?: { nodePath: string } }).target?.nodePath ?? "") : ""), `Add ${kind} track`);
          }}
        >
          <option value="">Add track…</option>
          <option value="event">Events</option>
          <option value="marker">Markers</option>
          <option value="audio">Audio</option>
          <option value="activation">Activation</option>
        </select>
        <button
          type="button"
          class="aw-tb"
          disabled={!curveLanes(clip)}
          title="Edit the clip's curves in the curve editor"
          onClick={(e) => {
            const tracks = activeTrack !== null && curveLanes(clip, [activeTrack]) ? [activeTrack] : undefined;
            const spec = curveLanes(props.clip, tracks)!;
            openCurveEditorDialog((e.currentTarget as HTMLElement).ownerDocument, {
              ...spec,
              title: "Clip curves",
              target: clip.name || s.clipFile.peek() || "clip",
              playhead: t,
              onCancel: () => {},
              onApply: (result) => apply(applyCurveLanes(s.document.peek()!.value.peek(), spec, result), "Edit curves"),
            });
          }}
        >
          Curves…
        </button>
      </div>
      {!rows.length ? (
        <EmptyState compact title="No tracks yet" body={target.kind === "animator" ? "Add a property, or turn on Record and change a field in the Inspector or with a gizmo." : "Add a track. To add properties, select a node with an Animator playing this clip."} />
      ) : (
        <DopeSheetGrid
          length={clip.duration}
          rows={gridRows}
          selected={selected}
          activeRow={s.activeRow.value}
          playhead={t}
          ghosts={ghosts.map((g) => g.t)}
          axisName="Clip time"
          nameWidth={180}
          onPlayhead={(x) => s.seek(x)}
          onRow={(id) => (s.activeRow.value = id)}
          onSelect={select}
          onDrag={(phase, dx, alt, key) => {
            if (props.readOnly) return;
            if (phase === "start") {
              const cur = s.selection.peek();
              const leaves = leafKeysOf(rows, key);
              const sel = leaves.every((l) => cur.includes(l)) ? cur : leaves;
              dragRef.current = { base: props.clip, selection: sel, shown: null };
              return;
            }
            const d = dragRef.current;
            if (!d) return;
            const dt = alt ? dx : frame(dx);
            if (phase === "move") {
              const r = moveKeys(d.base, d.selection, dt);
              d.shown = "next" in r ? r.next : null;
              setDrag({ ...d });
              return;
            }
            dragRef.current = null;
            setDrag(null);
            if (phase === "end" && dt !== 0) applyKeys(moveKeys(d.base, d.selection, dt), d.selection.length > 1 ? "Move keys" : "Move key");
          }}
          aside={(row) => {
            const r = rows.find((x) => x.id === row.id);
            const first = r && r.track !== null && (r.leaves !== undefined || (r.channel && rows.find((x) => x.track === r.track && !x.heading) === r));
            if (!first || props.readOnly) return null;
            return (
              <button type="button" class="aw-x" aria-label={`Remove track ${r!.label}`} title="Remove this track" onClick={() => (apply(removeTrack(props.clip, r!.track!), `Remove track ${r!.label}`), (s.selection.value = []))}>
                ×
              </button>
            );
          }}
        />
      )}
      <div class="aw-selbar" role="toolbar" aria-label="Keys">
        <span class="aw-muted">{selection.length ? `${selection.length} key${selection.length === 1 ? "" : "s"} selected` : "No keys selected"}</span>
        <button type="button" class="aw-tb" disabled={!selection.length || props.readOnly} onClick={actions.delete}>
          Delete
        </button>
        <button type="button" class="aw-tb" disabled={!selection.length} onClick={actions.copy}>
          Copy
        </button>
        <button type="button" class="aw-tb" disabled={props.readOnly} title="Paste the copied keys at the playhead, from the picked row down" onClick={actions.paste}>
          Paste
        </button>
        <button type="button" class="aw-tb" disabled={activeTrack === null} title="Select every key of the picked track" onClick={() => activeTrack !== null && (s.selection.value = keysOfRows(props.clip, rowsOfTrack(props.clip, activeTrack)))}>
          Select track
        </button>
        <span class="aw-sep" />
        <label class="aw-num">
          Scale ×
          <input type="number" min={0.05} step={0.25} value={scaleBy} onChange={(e) => setScaleBy(Number((e.currentTarget as HTMLInputElement).value))} />
        </label>
        <button type="button" class="aw-tb" disabled={!selection.length || props.readOnly} title="Scale the selected keys' times about the playhead" onClick={() => applyKeys(scaleSelectedKeys(props.clip, s.selection.peek(), t, scaleBy), "Scale keys")}>
          Scale
        </button>
        <span class="aw-sep" />
        <label class="aw-num">
          Ripple
          <input type="number" min={0} step={1 / clip.rate} value={rippleBy} onChange={(e) => setRippleBy(Number((e.currentTarget as HTMLInputElement).value))} />
        </label>
        <button type="button" class="aw-tb" disabled={props.readOnly} title="Insert this much time at the playhead (later keys move later)" onClick={() => apply(ripple(props.clip, t, rippleBy), "Insert time")}>
          Insert
        </button>
        <button type="button" class="aw-tb" disabled={props.readOnly} title="Remove this much time before the playhead (later keys move earlier)" onClick={() => apply(ripple(props.clip, t, -rippleBy), "Remove time")}>
          Remove
        </button>
        {activeTrack !== null && clip.tracks[activeTrack] && ROW_EDITOR_KINDS.has(clip.tracks[activeTrack]!.kind) && (
          <>
            <span class="aw-sep" />
            {(clip.tracks[activeTrack]!.kind === "event" || clip.tracks[activeTrack]!.kind === "audio") && (
              <input type="text" class="aw-method" aria-label={clip.tracks[activeTrack]!.kind === "event" ? "Method" : "Audio"} placeholder={clip.tracks[activeTrack]!.kind === "event" ? "method" : "audio asset"} value={method} onInput={(e) => setMethod((e.currentTarget as HTMLInputElement).value)} />
            )}
            <button type="button" class="aw-tb" disabled={props.readOnly} onClick={() => apply(addRowKey(props.clip, activeTrack, t, { method, audio: method }), `Add ${clip.tracks[activeTrack]!.kind} key`)}>
              Add key at playhead
            </button>
          </>
        )}
      </div>
      {single && singleRow && <RowEditor clip={props.clip} track={singleRow.track} index={single.index} onApply={(r, label) => apply(r, label)} />}
      {sprites.length > 0 && (
        <div class="aw-onion-strip" aria-label="Onion skin">
          {sprites.map((sp) => (
            <div key={`${sp.nodePath}|${sp.field}`} class="aw-onion-row">
              <span class="aw-muted">{sp.nodePath || rootName}</span>
              {sp.frames.map((f) => (
                <span key={f.offset} class={`aw-onion-frame${f.offset === 0 ? " now" : ""}`} title={`${f.offset > 0 ? "+" : ""}${f.offset} · ${seconds(f.t)}`}>
                  {fileName(f.sprite.replace(/^asset:/, "")) || "—"}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
