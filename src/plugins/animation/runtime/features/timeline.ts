// Timelines (ADR 0371, 0372; T22t): `TimelineDirector.play`, `pause` and `stop`, its lifecycle, and the per-frame work of
// `animation.Timeline` (`stages/timeline.ts`, before `animation.Gather`) and of the apply stage (`stages/apply/tweens.ts`).
//
// - **Loading:** on activation the director starts the World's core and loads its `*.timeline.json`. Until T19's compile
//   worker makes compiled timelines, the host writes the timeline as a raw `myco.anim@1` clip (the engine's one raw
//   clip writer, `compileRawClip`, ADR 0451; D46: a clip used as a timeline) and loads it into the core, keyed by path
//   and content. `subclip` keys' clips load
//   with it: another `*.timeline.json` or a `*.anim.json` source (written the same way: their property and keyed tracks),
//   or a compiled clip file (`acquireFile`), nested up to the core's three levels, and are bound with `timeline_bind`.
//   A loaded timeline is kept while its path stays, unless one of the files it read changed since
//   (`Assets.notifyChanged`): then the next activation or preview loads it again.
// - **Instance:** one core timeline instance per active director (`TIMELINE_CREATE`, scaled time), playing at once when
//   `playOnStart` (or `play()` was called while it loaded), starting at `playhead`. `wrapMode` `hold` and `loop` are the
//   core's hold and loop; `none` plays as hold and, at the end, stops: the playhead goes back to 0 and the fields take
//   the timeline's values there. The wrap mode is read when the instance is made (on activation).
// - **Playhead:** advanced on the host by the frame's scaled `dt` as the core advances it (wrapped or held the same
//   way) and written to `playhead` before evaluation, so scripts read the time being shown. A script writing `playhead`
//   seeks (`OP_SEEK`): no keys fire for the skipped span.
// - **Values:** block 0 (the timeline's own property tracks) goes through the property binding table
//   (`properties/bindings.ts`), bound relative to the director's node. `bindingTracks[i]` names a track group by its
//   node path (every track whose `nodePath` is that string) and `bindingNodes[i]` is the node it drives instead (Unity's
//   track bindings). Subclip blocks (the crossfaded entries of a subclip track, laid out as its first entry's clip) are
//   written through the tween targets (`tweens/target.ts`), which can read: at a partial block weight (an entry blending
//   in from or out to nothing) the field blends from the value it had when the block started to weigh, as Unity's
//   Timeline blends with the scene's values.
// - **Records:** `audio` keys play through the audio plugin (`events/audio.ts`), at the track's node; `control` keys go
//   to the control dispatch point (`events/controls.ts`); `activation` levels are columns, written with the values.
//   `event` keys aren't delivered yet: `AnimationEvent.animator` is an Animator (a public type), and a timeline's event
//   needs a record to widen it; one warning per timeline.
// - **Promises:** `play()` resolves `finished` at the end (`hold`, `none`), `stopped` on `stop()`, deactivation or
//   destruction, `interrupted` when `play()` is called again while one waits. A looping timeline's resolves only when
//   stopped or interrupted.
// - **Edit mode** (ADR 0026, D135): inside a scene being edited the director activates (`_activatesInEditMode`) but stays
//   inert: nothing loads, nothing plays, no field is written. An editor preview loads it with `previewTimeline` (never
//   playing on start; the preview writes `playhead` to seek) and lets it go with `endTimelinePreview`, which destroys the
//   instance again. Audio and control keys don't fire in edit mode.
import { parseAnimSource } from "../../../../engine/animation/animSource";
import { parseTimeline } from "../../../../engine/animation/timeline";
import { compileRawClip, usesBones, type RawClipSource, type SubclipRef } from "../../../../engine/animation/compile/rawClip";
import { TRACK_KINDS, CONTROL_ACTIONS } from "../../../../engine/animation/tracks";
import type { Component } from "../../../../engine/core/Component";
import { getComponentClass } from "../../../../engine/core/registry";
import type { World } from "../../../../engine/core/World";
import { Quaternion } from "../../../../engine/core/math";
import { Assets, normalizeAssetPath } from "../../../../engine/scene/Assets";
import { clipRefKind } from "../../../../engine/animation/compile/keys";
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { TimelineDirector } from "../components/TimelineDirector";
import type { AnimationWorldCore } from "../core/AnimationWorldCore";
import { getRecord, recordOpcode } from "../core/records";
import { startAnimationCore } from "../core/service";
import type { LifecycleHooks } from "../lifecycle";
import type { AnimationFrame } from "../stages/frame";
import type { AnimationPlayEndReason, AnimationPlayResult, TweenTarget } from "../types";
import {
  BLOCK_ROOT,
  BLOCK_SUBCLIP,
  CHANGE_FINISHED,
  FLAG_PLAY,
  MAX_DEPTH,
  OP_KILL,
  OP_PAUSE,
  OP_PLAY,
  OP_SEEK,
  OP_STOP,
  WRAP_HOLD,
  WRAP_LOOP,
} from "../wasm/wire/timeline";
import { ACTIVATION_EDGE, AUDIO, CONTROL, EVENT, MARKER, NOTIFY_STATE, SUBCLIP_STATE } from "../wasm/wire/tracks";
import { TIME_SCALED } from "../wasm/wire/tween";
import { playAudioKey } from "./events/audio";
import { dispatchControl, type AnimationControl } from "./events/controls";
import { bindClip, bindingsValid, type BindingTable } from "./properties/bindings";
import { clipData, type ClipColumn, type ClipData } from "./properties/clipData";
import type { ClipTrack, ClipTracks } from "./properties/clipTracks";
import { resolveTweenTarget, type TweenBinding } from "./tweens/target";

const ACTIVATION = TRACK_KINDS.indexOf("activation");

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

// ------------------------------------------------------------------------------------------------ loading

/** A loaded clip (a timeline, a source written raw, or a compiled file) and the binds of its subclips. */
interface LoadedClip {
  readonly handle: number;
  readonly path: string;
  /** Per subclip track of this clip: its keys' clip string ids. */
  readonly subclips: ReadonlyMap<number, readonly SubclipRef[]>;
}

interface Loaded {
  readonly path: string;
  readonly root: LoadedClip;
  /** `timeline_bind` calls: owner clip, string id, asset. */
  readonly binds: readonly { readonly owner: number; readonly stringId: number; readonly asset: number }[];
  /** Every handle acquired (released on detach or reload). */
  readonly handles: readonly number[];
  /** Each file read (the timeline and the clips nested in it) and its change count when read. */
  readonly files: ReadonlyMap<string, number>;
}

/**
 * How often each project file has changed (`Assets.notifyChanged`: the editor saved or replaced it). A loaded timeline
 * whose files changed since it read them is stale: the next activation or preview loads it again, so an editor preview
 * after an edit saved at the same path shows the new content.
 */
const changes = new Map<string, number>();
Assets.onChanged((path) => changes.set(path, (changes.get(path) ?? 0) + 1));

/** Whether a file `loaded` read has changed since. */
function stale(loaded: Loaded): boolean {
  for (const [path, n] of loaded.files) if ((changes.get(path) ?? 0) !== n) return true;
  return false;
}

/** FNV-1a over bytes: the raw clip's content key. */
function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h.toString(16);
}

/**
 * The timing and track list of a `*.timeline.json` or `*.anim.json` file, or null (warned). A clip source played as a
 * timeline keeps only these: its additive flag, bone rotation mode and root motion are an Animator's.
 */
function sourceOf(path: string): RawClipSource | null {
  let raw: unknown;
  try {
    raw = Assets.has(path) ? Assets.json(path) : undefined;
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    warnOnce(`missing:${path}`, `[myco] animation: the timeline "${path}" isn't in the project.`);
    return null;
  }
  const parsed = clipRefKind(path) === "source" ? parseAnimSource(raw, path) : parseTimeline(raw, path);
  for (const p of parsed.problems) warnOnce(`problem:${p}`, `[myco] ${p}`);
  const { name, rate, duration, loop, tracks } = parsed.value;
  return { name, rate, duration, loop, tracks };
}

interface LoadOut {
  binds: Loaded["binds"][number][];
  handles: number[];
  files: Map<string, number>;
}

async function loadClip(ns: AnimationWorldCore, ref: string, depth: number, out: LoadOut, chain: readonly string[]): Promise<LoadedClip | null> {
  const path = normalizeAssetPath(ref);
  if (!path) return null;
  out.files.set(path, changes.get(path) ?? 0);
  const kind = clipRefKind(path);
  if (kind === "timeline" || kind === "source") {
    if (chain.includes(path)) {
      warnOnce(`cycle:${path}`, `[myco] animation: the timeline "${path}" nests itself; the inner one doesn't play.`);
      return null;
    }
    const src = sourceOf(path);
    if (!src) return null;
    const written = compileRawClip(src, null, "", (curve, rate, end, frames) => ns.core.curveSamples(curve, rate, end, frames));
    if (usesBones(src)) warnOnce(`dropped:${path}`, `[myco] animation: "${path}" has bone tracks, which a timeline doesn't play (a character's motion comes through its own Animator); left out.`);
    for (const p of written.problems) if (!p.includes("bone track")) warnOnce(`written:${path}:${p}`, `[myco] animation: "${path}": ${p}`);
    const handle = ns.acquire(`${path}#raw:${fnv(written.bytes)}`, "clip", { kind: "clip", bytes: written.bytes });
    if (handle === 0) {
      warnOnce(`refused:${path}`, `[myco] animation: the core refused the timeline "${path}" (status ${ns.core.lastStatus()}).`);
      return null;
    }
    out.handles.push(handle);
    const clip: LoadedClip = { handle, path, subclips: written.subclips };
    const byRef = new Map<string, LoadedClip | null>();
    for (const refs of written.subclips.values()) {
      for (const r of refs) {
        if (depth + 1 >= MAX_DEPTH) {
          warnOnce(`deep:${path}`, `[myco] animation: "${path}" nests timelines deeper than ${MAX_DEPTH} levels; the deepest don't play.`);
          continue;
        }
        let child = byRef.get(r.ref);
        if (child === undefined) byRef.set(r.ref, (child = await loadClip(ns, r.ref, depth + 1, out, [...chain, path])));
        if (child) out.binds.push({ owner: handle, stringId: r.stringId, asset: child.handle });
      }
    }
    return clip;
  }
  const handle = await ns.acquireFile(path, "clip");
  if (handle === 0) {
    warnOnce(`clip:${path}`, `[myco] animation: the clip "${path}" didn't load (a missing file, or a source not compiled yet).`);
    return null;
  }
  out.handles.push(handle);
  return { handle, path, subclips: new Map() };
}

// ------------------------------------------------------------------------------------------------ runtime state

/** One written column of a subclip block, and the value its field had when the block started to weigh. */
interface SubEntry {
  readonly offset: number;
  readonly width: number;
  readonly binding: TweenBinding | null;
  readonly activation: GameObject | null;
  base: number[] | null;
}

interface Block {
  readonly index: number;
  readonly kind: number;
  readonly offset: number;
  readonly track: number;
  /** A subclip block's entries, bound on first use (rebound when a target goes away). */
  entries: SubEntry[] | null;
}

interface DirectorRuntime {
  readonly director: TimelineDirector;
  readonly world: World;
  ns: AnimationWorldCore | null;
  active: boolean;
  epoch: number;
  loaded: Loaded | null;
  instance: number;
  readonly hostId: number;
  duration: number;
  valueOffset: number;
  weightOffset: number;
  blocks: Block[];
  tables: BindingTable[] | null;
  /** The binding arrays the tables were made with. */
  overrides: { tracks: string[]; nodes: (GameObject | null)[] } | null;
  wrap: "hold" | "loop" | "none";
  playing: boolean;
  /** `play()` was called before the instance existed. */
  wantPlay: boolean;
  /** The host's copy of the core's playhead, and the value last written to `playhead`. */
  t: number;
  written: number;
  waiting: ((r: AnimationPlayResult) => void) | null;
  /** An editor preview wants an instance although the director is in edit mode (`previewTimeline`). */
  previewing: boolean;
}

const runtimes = new WeakMap<TimelineDirector, DirectorRuntime>();
const byWorld = new WeakMap<World, Set<DirectorRuntime>>();
let nextHostId = 0x40000000; // apart from tween ids

function runtimeOf(director: TimelineDirector): DirectorRuntime {
  let rt = runtimes.get(director);
  if (!rt) {
    const world = director.node.world;
    rt = {
      director,
      world,
      ns: null,
      active: false,
      epoch: 0,
      loaded: null,
      instance: 0,
      hostId: nextHostId++,
      duration: 0,
      valueOffset: 0,
      weightOffset: 0,
      blocks: [],
      tables: null,
      overrides: null,
      wrap: "hold",
      playing: false,
      wantPlay: false,
      t: 0,
      written: 0,
      waiting: null,
      previewing: false,
    };
    runtimes.set(director, rt);
    let set = byWorld.get(world);
    if (!set) byWorld.set(world, (set = new Set()));
    set.add(rt);
  }
  return rt;
}

function settle(rt: DirectorRuntime, reason: AnimationPlayEndReason): void {
  const w = rt.waiting;
  rt.waiting = null;
  w?.({ reason });
}

function release(rt: DirectorRuntime): void {
  if (rt.loaded && rt.ns) for (const h of rt.loaded.handles) rt.ns.release(h);
  rt.loaded = null;
}

function destroyInstance(rt: DirectorRuntime): void {
  if (rt.instance && rt.ns) {
    rt.ns.core.timelineControl(rt.instance, OP_KILL);
    rt.ns.forgetTimeline(rt.instance);
  }
  rt.instance = 0;
  rt.blocks = [];
  rt.tables = null;
  rt.playing = false;
}

/** Whether the director is inside a scene being edited (ADR 0026). */
function editing(rt: DirectorRuntime): boolean {
  return rt.director.node.isValid && rt.world.inEditMode(rt.director.node.entity);
}

async function activate(rt: DirectorRuntime): Promise<void> {
  const epoch = ++rt.epoch;
  rt.active = true;
  if (!rt.previewing && editing(rt)) return; // inert until a preview asks (see the file header)
  let ns: AnimationWorldCore | null = null;
  try {
    ns = await startAnimationCore(rt.world);
  } catch (err) {
    console.error("[myco] animation: the core failed to load; the timeline doesn't play:", err);
  }
  if (!ns || epoch !== rt.epoch || !rt.active) return;
  rt.ns = ns;
  const path = normalizeAssetPath(rt.director.timeline);
  if (rt.loaded?.path !== path || stale(rt.loaded)) {
    release(rt);
    if (!path) return;
    const out: LoadOut = { binds: [], handles: [], files: new Map() };
    const root = await loadClip(ns, path, 0, out, []);
    if (epoch !== rt.epoch || !rt.active || !ns.open) {
      for (const h of out.handles) ns.release(h);
      return;
    }
    if (!root) {
      for (const h of out.handles) ns.release(h);
      settle(rt, "stopped");
      return;
    }
    rt.loaded = { path, root, binds: out.binds, handles: out.handles, files: out.files };
  }
  createInstance(rt, ns);
}

function createInstance(rt: DirectorRuntime, ns: AnimationWorldCore): void {
  const loaded = rt.loaded!;
  const d = rt.director;
  rt.wrap = d.wrapMode === "loop" || d.wrapMode === "none" ? d.wrapMode : "hold";
  const play = (d.playOnStart && !editing(rt)) || rt.wantPlay;
  const start = Number.isFinite(d.playhead) && d.playhead > 0 ? d.playhead : 0;
  const h = ns.createTimeline({ hostId: rt.hostId, clip: loaded.root.handle, timeMode: TIME_SCALED, wrap: rt.wrap === "loop" ? WRAP_LOOP : WRAP_HOLD, flags: play ? FLAG_PLAY : 0, speed: 1, start });
  if (h === 0) {
    warnOnce(`create:${loaded.path}`, `[myco] ${d.node.name}: the core refused to play the timeline "${loaded.path}" (status ${ns.core.lastStatus()}).`);
    settle(rt, "stopped");
    return;
  }
  for (const b of loaded.binds) ns.core.timelineBind(h, b.owner, b.stringId, b.asset);
  const info = ns.core.timelineInfo(h);
  rt.instance = h;
  rt.duration = info?.duration ?? 0;
  rt.valueOffset = info?.valueOffset ?? 0;
  rt.weightOffset = info?.weightOffset ?? 0;
  rt.blocks = ns.core.timelineBlocks(h).map((b) => ({ index: b.index, kind: b.kind, offset: b.offset, track: b.track, entries: null }));
  rt.tables = null;
  rt.playing = play;
  rt.wantPlay = false;
  rt.t = Math.min(start, rt.duration);
  rt.written = d.playhead;
}

function deactivate(rt: DirectorRuntime): void {
  rt.active = false;
  rt.epoch++;
  destroyInstance(rt);
  rt.wantPlay = false;
  settle(rt, "stopped");
}

/** @internal What a TimelineDirector's lifecycle does: activation loads and makes its instance; deactivating or destroying it ends its play with `stopped`. */
export const timelineHooks: LifecycleHooks<TimelineDirector> = {
  attach(d) {
    runtimeOf(d);
  },
  activate(d) {
    void activate(runtimeOf(d));
  },
  deactivate(d) {
    deactivate(runtimeOf(d));
  },
  detach(d) {
    const rt = runtimes.get(d);
    if (!rt) return;
    deactivate(rt);
    release(rt);
    byWorld.get(rt.world)?.delete(rt);
    runtimes.delete(d);
  },
};

// ------------------------------------------------------------------------------------------------ editor preview

/**
 * @internal An editor preview (re)loads `director` from its fields (`timeline`, `wrapMode`, `playhead`): in edit mode it
 * makes an instance that doesn't play (the preview seeks by writing `playhead`); outside edit mode it reloads as a
 * re-activation would.
 */
export function previewTimeline(director: TimelineDirector): void {
  const rt = runtimeOf(director);
  rt.previewing = true;
  if (!rt.active) return;
  destroyInstance(rt);
  void activate(rt);
}

/** @internal The preview lets `director` go: in edit mode its instance goes (inert again); outside it, it reloads from its fields. */
export function endTimelinePreview(director: TimelineDirector): void {
  const rt = runtimes.get(director);
  if (!rt?.previewing) return;
  rt.previewing = false;
  if (!rt.active) return;
  if (editing(rt)) {
    rt.epoch++;
    destroyInstance(rt);
    settle(rt, "stopped");
    return;
  }
  destroyInstance(rt);
  void activate(rt);
}

// ------------------------------------------------------------------------------------------------ the API

/** @internal `TimelineDirector.play`. */
export function playTimeline(director: TimelineDirector): Promise<AnimationPlayResult> {
  const rt = runtimeOf(director);
  settle(rt, "interrupted");
  const promise = new Promise<AnimationPlayResult>((resolve) => (rt.waiting = resolve));
  if (!rt.active) {
    warnOnce(`inactive:${director.node.name}`, `[myco] ${director.node.name}: TimelineDirector.play() on an inactive director does nothing.`);
    settle(rt, "stopped");
    return promise;
  }
  if (!rt.instance || !rt.ns) {
    rt.wantPlay = true;
    return promise;
  }
  if (!rt.playing && rt.wrap !== "loop" && rt.t >= rt.duration) rt.t = 0; // at the end: the core restarts from 0
  rt.ns.core.timelineControl(rt.instance, OP_PLAY);
  rt.playing = true;
  return promise;
}

/** @internal `TimelineDirector.pause`. */
export function pauseTimeline(director: TimelineDirector): void {
  const rt = runtimeOf(director);
  rt.wantPlay = false;
  if (!rt.instance || !rt.ns) return;
  rt.ns.core.timelineControl(rt.instance, OP_PAUSE);
  rt.playing = false;
}

/** @internal `TimelineDirector.stop`. */
export function stopTimeline(director: TimelineDirector): void {
  const rt = runtimeOf(director);
  rt.wantPlay = false;
  if (rt.instance && rt.ns) {
    rt.ns.core.timelineControl(rt.instance, OP_STOP);
    rt.playing = false;
  }
  rt.t = 0;
  rt.written = 0;
  director.playhead = 0;
  settle(rt, "stopped");
}

// ------------------------------------------------------------------------------------------------ the stages

/** @internal `animation.Timeline`: script seeks, then each playing director's playhead advances as the core's will. */
export function runTimeline(frame: AnimationFrame): void {
  if (frame.fixed) return;
  const set = byWorld.get(frame.world);
  if (!set) return;
  for (const rt of set) {
    if (!rt.instance || !rt.ns) continue;
    const d = rt.director;
    if (d.playhead !== rt.written) {
      const to = Math.min(Math.max(Number.isFinite(d.playhead) ? d.playhead : 0, 0), rt.duration);
      rt.ns.core.timelineControl(rt.instance, OP_SEEK, to);
      rt.t = to;
    }
    if (rt.playing) {
      let t = rt.t + frame.dt;
      if (rt.wrap === "loop") t = rt.duration > 0 ? t % rt.duration : 0;
      else t = Math.min(t, rt.duration);
      rt.t = t;
    }
    d.playhead = rt.t;
    rt.written = rt.t;
  }
}

/** The node a track path names below the director's node, or its binding override; null when missing. */
function trackNode(rt: DirectorRuntime, path: string | null): GameObject | null {
  const d = rt.director;
  const p = path ?? "";
  const i = d.bindingTracks.indexOf(p);
  if (i >= 0) {
    const n = d.bindingNodes[i];
    if (n?.isValid) return n;
  }
  return d.node.isValid ? (p ? d.node.find(p) : d.node) : null;
}

function overridesChanged(rt: DirectorRuntime): boolean {
  const o = rt.overrides;
  const d = rt.director;
  if (!o) return true;
  if (o.tracks.length !== d.bindingTracks.length || o.nodes.length !== d.bindingNodes.length) return true;
  for (let i = 0; i < o.tracks.length; i++) if (o.tracks[i] !== d.bindingTracks[i]) return true;
  for (let i = 0; i < o.nodes.length; i++) if (o.nodes[i] !== d.bindingNodes[i] || (o.nodes[i] && !o.nodes[i]!.isValid)) return true;
  return false;
}

/** Block 0's binding tables: the director's node, split by binding overrides. */
function rootTables(world: World, rt: DirectorRuntime, data: ClipData): BindingTable[] {
  const d = rt.director;
  const name = rt.loaded!.path;
  const overrides = new Map<string, GameObject>();
  for (let i = 0; i < d.bindingTracks.length; i++) {
    const n = d.bindingNodes[i];
    if (n?.isValid) overrides.set(d.bindingTracks[i]!, n);
  }
  rt.overrides = { tracks: [...d.bindingTracks], nodes: [...d.bindingNodes] };
  const tracks = data.tracks;
  if (!overrides.size || !tracks) return [bindClip(world, d.node, name, data)];
  const own: ClipColumn[] = [];
  const groups = new Map<GameObject, ClipColumn[]>();
  for (const col of data.columns) {
    const n = overrides.get(tracks.tracks[col.track]?.nodePath ?? "");
    if (!n) own.push(col);
    else {
      let g = groups.get(n);
      if (!g) groups.set(n, (g = []));
      g.push(col);
    }
  }
  const tables = [bindClip(world, d.node, name, { ...data, columns: own })];
  for (const [node, columns] of groups) {
    const rebased: ClipTracks = { ...tracks, tracks: tracks.tracks.map((t): ClipTrack => (overrides.get(t.nodePath ?? "") === node ? { ...t, nodePath: null } : t)) };
    tables.push(bindClip(world, node, name, { tracks: rebased, columns, json: (id) => data.json(id) }));
  }
  return tables;
}

/** A subclip block's entries: each written column of its first entry's clip, bound through a tween target. */
function subEntries(frame: AnimationFrame, rt: DirectorRuntime, block: Block): SubEntry[] {
  const refs = rt.loaded!.root.subclips.get(block.track);
  const first = refs?.[0];
  const bind = first ? rt.loaded!.binds.find((b) => b.owner === rt.loaded!.root.handle && b.stringId === first.stringId) : undefined;
  if (!bind) return [];
  const data = clipData(frame.core.core, bind.asset);
  const entries: SubEntry[] = [];
  for (const col of data.columns) {
    const track = data.tracks?.tracks[col.track];
    if (!track) continue;
    const node = trackNode(rt, track.nodePath);
    const miss = (why: string) => warnOnce(`sub:${rt.loaded!.path}:${col.track}:${why}`, `[myco] ${rt.director.node.name}: a subclip track of "${rt.loaded!.path}" drives ${track.nodePath ?? ""} ${track.component ?? ""}.${track.field ?? ""}, which ${why}; left unbound.`);
    if (!node) {
      miss("isn't there");
      continue;
    }
    if (col.kind === ACTIVATION) {
      entries.push({ offset: col.offset, width: 1, binding: null, activation: node, base: null });
      continue;
    }
    if (col.u32) {
      miss("is a stepped value (subclip blocks write numbers, vectors, rotations and colours)");
      continue;
    }
    let target: TweenTarget | null = null;
    if (track.component === "engine.Transform") target = node.transform;
    else if (track.component) {
      const type = getComponentClass(track.component);
      target = type ? (node.getComponent(type as never) as Component | null) : null;
    }
    if (!target || !track.field) {
      miss("has no such component");
      continue;
    }
    const binding = resolveTweenTarget(target, track.field, 0);
    if (typeof binding === "string") miss(binding);
    else if (binding.width !== col.width) miss(`takes ${binding.width} numbers, not ${col.width}`);
    else entries.push({ offset: col.offset, width: col.width, binding, activation: null, base: null });
  }
  return entries;
}

function writeSub(entry: SubEntry, f32: Float32Array, u32: Uint32Array, at: number, w: number): void {
  if (entry.activation) {
    const on = u32[at] !== 0;
    if (entry.activation.isValid && entry.activation.active !== on) entry.activation.setActive(on);
    return;
  }
  const b = entry.binding!;
  const v = Array.from(f32.subarray(at, at + entry.width));
  if (w >= 1) {
    entry.base = null;
    b.write(v);
    return;
  }
  entry.base ??= b.read() ?? v;
  const base = entry.base;
  if (b.quat) {
    const q = Quaternion.nlerp({ x: base[0]!, y: base[1]!, z: base[2]!, w: base[3]! }, { x: v[0]!, y: v[1]!, z: v[2]!, w: v[3]! }, w);
    b.write([q.x, q.y, q.z, q.w]);
  } else b.write(v.map((x, i) => base[i]! + (x - base[i]!) * w));
}

type Pending = { readonly kind: "audio"; readonly asset: string; readonly params: unknown; readonly weight: number; readonly node: GameObject } | { readonly kind: "control"; readonly control: AnimationControl };

const STRIDES = new Map<number, number>([EVENT, NOTIFY_STATE, ACTIVATION_EDGE, CONTROL, AUDIO, MARKER, SUBCLIP_STATE].map((l) => [l.opcode, l.stride]));

/** The timeline records of this frame for the World's directors. */
function decodeRecords(frame: AnimationFrame, byInstance: Map<number, DirectorRuntime>): Pending[] {
  const core = frame.core.core;
  const { at: start, bytes } = core.timelineRecords();
  const out: Pending[] = [];
  if (!bytes) return out;
  const view = core.views().data;
  const nodeOf = (rt: DirectorRuntime, data: ClipData, track: number): GameObject => trackNode(rt, data.tracks?.tracks[track]?.nodePath ?? null) ?? rt.director.node;
  for (let at = start; at < start + bytes; ) {
    const opcode = recordOpcode(view, at);
    const stride = STRIDES.get(opcode);
    if (stride === undefined) break; // not this build's layout
    const instance = view.getUint32(at + 4, true);
    const rt = byInstance.get(instance);
    if (rt && !editing(rt)) {
      if (opcode === AUDIO.opcode) {
        const r = getRecord(view, at, AUDIO);
        const data = clipData(core, r.clip);
        out.push({ kind: "audio", asset: data.tracks?.string(r.asset) ?? "", params: data.json(r.params).value, weight: r.weight, node: nodeOf(rt, data, r.track) });
      } else if (opcode === CONTROL.opcode) {
        const r = getRecord(view, at, CONTROL);
        const action = CONTROL_ACTIONS[r.control];
        if (action) {
          const data = clipData(core, r.clip);
          out.push({
            kind: "control",
            control: { animator: null, director: rt.director, node: rt.director.node, action, target: data.tracks?.string(r.target) ?? null, payload: data.json(r.payload).value, clip: rt.loaded?.path ?? "", time: r.time, duration: r.duration, weight: r.weight },
          });
        }
      } else if (opcode === EVENT.opcode || opcode === NOTIFY_STATE.opcode) {
        warnOnce(`events:${rt.loaded?.path}`, `[myco] ${rt.director.node.name}: the timeline "${rt.loaded?.path ?? ""}" has event keys, which timelines don't deliver yet; skipped.`);
      }
    }
    at += stride;
  }
  return out;
}

/** @internal The apply stage's timeline part: values, records, then state changes (play promises, wrap `none`). */
export function applyTimelines(frame: AnimationFrame): void {
  if (frame.fixed) return;
  const set = byWorld.get(frame.world);
  if (!set?.size) return;
  const core = frame.core.core;
  const byInstance = new Map<number, DirectorRuntime>();
  for (const rt of set) if (rt.instance && rt.ns === frame.core) byInstance.set(rt.instance, rt);
  if (!byInstance.size) return;
  const active = new Set(core.timelineActive());
  for (const rt of byInstance.values()) {
    if (!active.has(rt.instance) || !rt.loaded) continue;
    const root = rt.blocks.find((b) => b.kind === BLOCK_ROOT);
    if (root) {
      const data = clipData(core, rt.loaded.root.handle);
      if (!rt.tables || overridesChanged(rt) || !rt.tables.every((t) => bindingsValid(frame.world, t))) rt.tables = rootTables(frame.world, rt, data);
      const out = core.timelineOutputs(); // binding may read the core: views after
      if (out.weights[rt.weightOffset + root.index]! > 0) {
        const at = rt.valueOffset + root.offset;
        for (const table of rt.tables) for (const e of table.entries) e.write(out.f32, out.u32, at + e.offset);
      }
    }
    for (const b of rt.blocks) {
      if (b.kind !== BLOCK_SUBCLIP) continue;
      if (!b.entries || b.entries.some((e) => (e.binding && !e.binding.alive()) || (e.activation && !e.activation.isValid))) b.entries = subEntries(frame, rt, b);
      const out = core.timelineOutputs();
      const w = out.weights[rt.weightOffset + b.index]!;
      if (!(w > 0)) {
        for (const e of b.entries) e.base = null;
        continue;
      }
      const at = rt.valueOffset + b.offset;
      for (const e of b.entries) writeSub(e, out.f32, out.u32, at + e.offset, Math.min(1, w));
    }
  }
  const pending = decodeRecords(frame, byInstance);
  const n = core.timelineChangeCount();
  const changes: { rt: DirectorRuntime; kind: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = core.timelineChange(i);
    const rt = byInstance.get(c.instance);
    if (rt && c.hostId === rt.hostId) changes.push({ rt, kind: c.kind });
  }
  for (const p of pending) {
    if (p.kind === "audio") playAudioKey(p.asset, p.params, p.weight, p.node);
    else dispatchControl(p.control);
  }
  for (const { rt, kind } of changes) {
    if (kind !== CHANGE_FINISHED || !rt.instance || !rt.ns) continue;
    rt.playing = false;
    if (rt.wrap === "none") {
      rt.ns.core.timelineControl(rt.instance, OP_STOP);
      rt.t = 0;
    } else rt.t = rt.duration;
    rt.director.playhead = rt.t;
    rt.written = rt.t;
    settle(rt, "finished");
  }
}
