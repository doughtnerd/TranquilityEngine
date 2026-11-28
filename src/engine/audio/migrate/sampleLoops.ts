/**
 * Where the migration puts a looping clip's loop (ADR 0342, 0343): in the audio file's sidecar (`<file>.meta.json`,
 * `sample.loops`), the way the samples were fixed by hand. The old events looped in the voice; a playlist clip plays its
 * sample's loops, so each `SampleLoopRequest` from `audioEvent1.ts` becomes one loop there.
 *
 * - A sample's **base loops** are its sidecar's `sample.loops` when it has a `sample` block (authored: never changed),
 *   else the legacy `loopStart`/`loopEnd`, else the loops in the file itself (a WAV's `smpl`, `fileLoops`). The old
 *   runtime looped those for a clip with no loop region; the new one reads only the `sample` block, so placing a loop
 *   writes them there.
 * - A request without a region takes the sample's first base loop, else the whole clip.
 * - An equal loop (same start, end, activation and exit) is reused. A legacy or file loop with the same span takes the
 *   request's activation and exit the first time one is asked for. With no loops at all, the loop is added (`id` `l1`,
 *   `l2`…, `file: null`) and the sample's kind becomes `loop`.
 * - Anything else (the sidecar holds a different loop, two events want different loops on one file, a sidecar that
 *   isn't valid JSON) makes a **derived sample** beside the file, `<name>.loop<n>.sample.json` (`myco.sample@1`,
 *   lineage `duplicate` in `follow` mode, ADR 0342), whose block is the sample's with that one loop; the clip names it.
 *   An equal derived sample made earlier in the run is reused.
 *
 * A changed sidecar keeps every other field as it was; only its `sample` block is written (`sampleEditsToJson`).
 *
 * Pure: it takes the project's JSON texts and returns files to write. Internal: tooling, not the engine's public API.
 */
import { isRecord, type JsonRecord } from "../lenientRead";
import { defaultSampleEdits, derivedSampleToJson, parseSampleEdits, sampleEditsFromSidecar, sampleEditsToJson } from "../sample/format";
import { SAMPLE_FORMAT, SAMPLE_SUFFIX, type DerivedSampleAsset, type SampleEdits, type SampleLoop } from "../sample/types";
import type { SampleLoopRequest } from "./audioEvent1";
import { normalizeAssetPath } from "../../scene/assetPath";

/** Seconds closer than this are the same loop point. */
const EPS = 1e-6;

const sidecarOf = (path: string): string => `${path}.meta.json`;
const fmt = (s: number): string => `${Math.round(s * 1000) / 1000}`;

/** One loop as the parse makes it (so its defaults are the sidecar's: crossfade, direction, count). */
function newLoop(id: string, start: number, end: number, r: SampleLoopRequest): SampleLoop {
  return parseSampleEdits({ loops: [{ id, start, end, active: r.active, exit: r.exit, exitFadeMs: r.exitFadeMs, reentry: "ignore" }] }, "loop", []).loops[0]!;
}

const sameSpan = (l: SampleLoop, start: number, end: number): boolean => Math.abs(l.start - start) <= EPS && Math.abs(l.end - end) <= EPS;
const sameBehaviour = (l: SampleLoop, r: SampleLoopRequest): boolean =>
  l.active === r.active && l.exit === r.exit && l.exitFadeMs === r.exitFadeMs && l.reentry === "ignore" && l.binding === undefined;

const describe = (l: SampleLoop): string =>
  `${fmt(l.start)}–${fmt(l.end)} s, ${l.active === "held" ? `held until release (exit ${l.exit}${l.exit === "crossfade" ? ` ${l.exitFadeMs} ms` : ""})` : "endless"}`;

interface SampleState {
  /** The sidecar's JSON object; null when there is none. */
  raw: JsonRecord | null;
  /** The sidecar exists but can't be edited (not a JSON object). */
  broken: boolean;
  edits: SampleEdits;
  /** Loop ids from the sidecar's own `sample` block: never changed. */
  authored: Set<string>;
  /** Loop ids a migrated clip relies on. */
  claimed: Set<string>;
  dirty: boolean;
  /** Derived samples made for this file in this run. */
  derived: { path: string; loop: SampleLoop }[];
}

export interface SampleLoopFiles {
  /** Files to write, path → text: changed or new sidecars and new derived samples. */
  writes: Map<string, string>;
  /** Sidecars written that didn't exist. */
  newSidecars: string[];
  /** Existing sidecars whose `sample` block was written. */
  changedSidecars: string[];
  /** Derived samples created. */
  derived: string[];
  /** One line per file, naming what it holds and for which events. */
  notes: string[];
}

/** Places the migration's sample loops (see the module comment). Call `place` per request, then `result`. */
export class SampleLoopPlanner {
  private readonly samples = new Map<string, SampleState>();
  private readonly taken = new Set<string>();
  private readonly users = new Map<string, Set<string>>();

  /**
   * `files`: the project's JSON texts by project path (the sidecars among them). `fileLoops`: the loops an audio file
   * carries itself (a WAV's `smpl`), when the caller can read them.
   */
  constructor(private readonly files: ReadonlyMap<string, string>, private readonly fileLoops: (path: string) => readonly SampleLoop[] | undefined = () => undefined) {}

  private state(path: string): SampleState {
    let st = this.samples.get(path);
    if (st) return st;
    const text = this.files.get(sidecarOf(path));
    let raw: JsonRecord | null = null;
    let broken = false;
    if (text !== undefined) {
      try {
        const v: unknown = JSON.parse(text);
        if (isRecord(v)) raw = v;
        else broken = true;
      } catch {
        broken = true;
      }
    }
    let edits: SampleEdits;
    const authored = new Set<string>();
    if (raw && raw.sample !== undefined && raw.sample !== null) {
      edits = parseSampleEdits(raw.sample, `${sidecarOf(path)}: sample`, []);
      for (const l of edits.loops) authored.add(l.id);
    } else {
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      edits = sampleEditsFromSidecar({ sample: null, loopStart: num(raw?.loopStart), loopEnd: num(raw?.loopEnd) });
      if (edits.loops.length === 0) {
        const own = this.fileLoops(path) ?? [];
        if (own.length > 0) edits = { ...defaultSampleEdits("loop"), loops: own.map((l) => ({ ...l })) };
      }
    }
    st = { raw, broken, edits, authored, claimed: new Set(), dirty: false, derived: [] };
    this.samples.set(path, st);
    return st;
  }

  private use(file: string, event: string): void {
    let s = this.users.get(file);
    if (!s) this.users.set(file, (s = new Set()));
    s.add(event);
  }

  /** The sample (or derived sample) a clip of `event` should name for `request`, or null when there is nothing to loop. */
  place(request: SampleLoopRequest, event: string): string | null {
    const path = normalizeAssetPath(request.sample);
    const st = this.state(path);
    const own = st.edits.loops.find((l) => l.end > l.start);
    const span = request.region ?? (own ? [own.start, own.end] as [number, number] : null) ?? request.whole;
    if (!span) return null;
    const [start, end] = span;
    if (!st.broken) {
      const match = st.edits.loops.find((l) => sameSpan(l, start, end));
      if (match && sameBehaviour(match, request)) {
        if (!st.authored.has(match.id)) st.dirty = true; // a legacy or file loop: the runtime needs it in the block
        st.claimed.add(match.id);
        this.use(sidecarOf(path), event);
        return request.sample;
      }
      if (match && !st.authored.has(match.id) && !st.claimed.has(match.id)) {
        Object.assign(match, { active: request.active, exit: request.exit, exitFadeMs: request.exitFadeMs, reentry: "ignore" });
        delete match.binding;
        st.claimed.add(match.id);
        st.dirty = true;
        this.use(sidecarOf(path), event);
        return request.sample;
      }
      if (!match && st.edits.loops.length === 0) {
        st.edits = { ...st.edits, loops: [newLoop("l1", start, end, request)] };
        if (st.edits.kind === "oneshot") st.edits.kind = "loop";
        st.claimed.add("l1");
        st.dirty = true;
        this.use(sidecarOf(path), event);
        return request.sample;
      }
    }
    // A derived sample carrying the loop.
    const want = newLoop("l1", start, end, request);
    const have = st.derived.find((d) => sameSpan(d.loop, start, end) && sameBehaviour(d.loop, request));
    if (have) {
      this.use(have.path, event);
      return have.path;
    }
    const dpath = this.freeDerivedPath(path);
    st.derived.push({ path: dpath, loop: want });
    this.use(dpath, event);
    return dpath;
  }

  private freeDerivedPath(audio: string): string {
    const slash = audio.lastIndexOf("/");
    const dot = audio.lastIndexOf(".");
    const stem = dot > slash ? audio.slice(0, dot) : audio;
    for (let n = 1; ; n++) {
      const p = `${stem}.loop${n}${SAMPLE_SUFFIX}`;
      if (!this.files.has(p) && !this.taken.has(p)) {
        this.taken.add(p);
        return p;
      }
    }
  }

  /** The files the placed loops need. */
  result(): SampleLoopFiles {
    const out: SampleLoopFiles = { writes: new Map(), newSidecars: [], changedSidecars: [], derived: [], notes: [] };
    const by = (file: string) => [...(this.users.get(file) ?? [])].sort().join(", ");
    for (const path of [...this.samples.keys()].sort()) {
      const st = this.samples.get(path)!;
      if (st.dirty) {
        const sidecar = sidecarOf(path);
        const raw: JsonRecord = st.raw ? { ...st.raw } : { format: "myco.import@1" };
        raw.sample = sampleEditsToJson(st.edits);
        out.writes.set(sidecar, JSON.stringify(raw, null, 2) + "\n");
        (st.raw ? out.changedSidecars : out.newSidecars).push(sidecar);
        const loops = st.edits.loops.filter((l) => st.claimed.has(l.id));
        out.notes.push(`${sidecar}: ${st.raw ? "now holds" : "written with"} the sample loop${loops.length > 1 ? "s" : ""} ${loops.map((l) => `${l.id} at ${describe(l)}`).join("; ")} for ${by(sidecar)}.`);
      }
      for (const d of st.derived) {
        const base = st.broken ? defaultSampleEdits() : st.edits;
        const sample: SampleEdits = { ...base, kind: base.kind === "oneshot" ? "loop" : base.kind, loops: [d.loop] };
        const asset: DerivedSampleAsset = { format: SAMPLE_FORMAT, source: path, range: null, lineage: { kind: "duplicate", parent: path, mode: "follow" }, sample };
        out.writes.set(d.path, JSON.stringify(derivedSampleToJson(asset), null, 2) + "\n");
        out.derived.push(d.path);
        const why = st.broken ? `${sidecarOf(path)} isn't a JSON object` : `${sidecarOf(path)} already has a different loop`;
        out.notes.push(`${d.path}: a derived sample of ${path} with the loop ${describe(d.loop)} for ${by(d.path)} (${why}).`);
      }
    }
    return out;
  }
}
