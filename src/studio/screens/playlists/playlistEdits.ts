// The Playlist panel's edits of one playlist body (ADR 0343; the prototype's edits, PL:1055–1400). Each returns
// `{ next } | { refused }` (ADR 0307, 0313); the screen lifts it to the file with `editAt` and applies it as one labelled
// undo step. Entries are addressed by index; removing or moving one keeps a Switch's label map pointing at the same
// entries. Values are clamped to the ranges the prototype's fields allow. Pure.
import { defaultEntryUse, emptyPlaylistBody, PLAYLIST_LIMITS } from "../../../engine/audio/playlist/format";
import { renamePlaylistParameter } from "../../../engine/audio/playlist/references";
import type {
  Adsr, BlendAxis, BlendSettings, ChangeHow, ChangeRule, Entry, EntryUse, PlaybackRules, PlaylistBody, PlaylistSpatial, QueueSettings, SampleEntry, SwitchSettings,
} from "../../../engine/audio/playlist/types";
import { isLabelled, type ParameterDef } from "../../../engine/audio/parameters";
import type { Effect } from "../../../engine/audio/effects/types";
import { accept, refuse, type EditResult } from "../../../editor/sdk/editResult";
import { axisRange, place1D, place2D } from "./blendPlacement";

/** What the edits need to know beyond the body: the parameters it can use (global and local). */
export interface EditContext {
  readonly parameters: readonly ParameterDef[];
  /**
   * "+ New parameter…" in a parameter select (UI pass J4.1/J5.1): make a global parameter (`kind`: only that kind) and
   * resolve with it, null when cancelled. Absent: the selects don't offer it. Edits never call it.
   */
  readonly newParameter?: (kind?: "numeric" | "labelled") => Promise<ParameterDef | null>;
}

/** `ctx` with parameter `def` added (just made by "+ New parameter…", before the screen's signals have it). */
export const withParameter = (ctx: EditContext, def: ParameterDef): EditContext => ({ ...ctx, parameters: [...ctx.parameters.filter((p) => p.name !== def.name), def] });

const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const round = (v: number, step: number): number => Math.round(v / step) * step;

/** The per-use ranges (the prototype's fields): volume −48..+12 dB, pitch ±24 st, weight 0..100 (whole numbers). */
export const USE_LIMITS = { volume: [-48, 12], pitch: [-24, 24], weight: [0, 100] } as const;

// --- entries ---------------------------------------------------------------------------------------------------------

/** A Switch map after entry `from` moved to `to` (null `to`: removed; its labels then play nothing). */
function remapSwitch(s: SwitchSettings | null, remap: (i: number) => number | null): SwitchSettings | null {
  if (!s) return s;
  const map: Record<string, number | null> = {};
  for (const [label, i] of Object.entries(s.map)) map[label] = i === null ? null : remap(i);
  return { ...s, map };
}

/** The new index of entry `i` after the entry at `from` moved to `to`. */
const moved = (i: number, from: number, to: number): number => (i === from ? to : from < to ? (i > from && i <= to ? i - 1 : i) : i >= to && i < from ? i + 1 : i);

/** A sample as an entry of `b`: itself in a Clip, else wrapped in an embedded Clip (ADR 0343: entries are always playlists). */
export function sampleEntry(b: PlaylistBody, sample: string): Entry {
  const inner: SampleEntry = { kind: "sample", sample, trim: null, loop: "inherit", ...defaultEntryUse() };
  if (b.type === "clip") return inner;
  return { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [inner] }, ...defaultEntryUse() };
}

/** Where a Blend's new entries go (1D widest gap, 2D free spot); other types leave them as they are. */
function placeNew(b: PlaylistBody, entries: Entry[], firstNew: number, ctx: EditContext): Entry[] {
  if (b.type !== "blend" || !b.blend) return entries;
  const out = [...entries];
  const rx = axisRange(b.blend.axes[0], ctx.parameters);
  if (b.blend.axes.length === 2) {
    const ry = axisRange(b.blend.axes[1], ctx.parameters);
    for (let i = firstNew; i < out.length; i++) {
      const p = place2D(out.slice(0, i), rx, ry);
      out[i] = { ...out[i]!, x: p.x, y: p.y };
    }
    return out;
  }
  for (let i = firstNew; i < out.length; i++) {
    const p = place1D(out.slice(0, i).map((e) => e.x), rx);
    for (let k = 0; k < i; k++) out[k] = { ...out[k]!, x: p.xs[k]! };
    out[i] = { ...out[i]!, x: p.x };
  }
  return out;
}

/** Add entries at the end (a Blend places them). A Clip takes samples only: the first replaces its sample. */
export function addEntries(b: PlaylistBody, add: readonly Entry[], ctx: EditContext): EditResult<PlaylistBody> {
  if (add.length === 0) return refuse("nothing to add");
  if (b.type === "sequence") return refuse("a Sequence's clips are edited on its timeline (M5)");
  if (b.type === "clip") {
    const s = add.find((e) => e.kind === "sample") as SampleEntry | undefined;
    if (!s) return refuse("a Clip plays a sample; pick a sample");
    return setClipSample(b, s.sample);
  }
  if (b.entries.length + add.length > PLAYLIST_LIMITS.entries) return refuse(`a playlist holds at most ${PLAYLIST_LIMITS.entries} entries`);
  const wrapped = add.map((e) => (e.kind === "sample" ? { ...sampleEntry(b, e.sample), volume: e.volume, pitch: e.pitch } : e));
  return accept({ ...b, entries: placeNew(b, [...b.entries, ...wrapped], b.entries.length, ctx) });
}

/** Remove entry `i` (a Switch's labels that played it then play nothing). */
export function removeEntry(b: PlaylistBody, i: number): EditResult<PlaylistBody> {
  if (!b.entries[i]) return refuse("that entry isn't there");
  return accept({ ...b, entries: b.entries.filter((_, k) => k !== i), switch: remapSwitch(b.switch, (k) => (k === i ? null : k > i ? k - 1 : k)) });
}

/** Move entry `from` to index `to` ("Reorder entries"); a Switch's map follows its entries. */
export function moveEntry(b: PlaylistBody, from: number, to: number): EditResult<PlaylistBody> {
  if (!b.entries[from]) return refuse("that entry isn't there");
  const t = clamp(Math.round(to), 0, b.entries.length - 1);
  if (t === from) return accept(b);
  const entries = [...b.entries];
  const [e] = entries.splice(from, 1);
  entries.splice(t, 0, e!);
  return accept({ ...b, entries, switch: remapSwitch(b.switch, (k) => moved(k, from, t)) });
}

/** Duplicate entry `i` just after it (a Blend places the copy). */
export function duplicateEntry(b: PlaylistBody, i: number, ctx: EditContext): EditResult<PlaylistBody> {
  const e = b.entries[i];
  if (!e) return refuse("that entry isn't there");
  if (b.type === "clip") return refuse("a Clip plays one sample");
  if (b.entries.length >= PLAYLIST_LIMITS.entries) return refuse(`a playlist holds at most ${PLAYLIST_LIMITS.entries} entries`);
  const copy = structuredClone(e);
  const entries = [...b.entries];
  entries.splice(i + 1, 0, copy);
  let placed = entries;
  if (b.type === "blend") {
    // Place the copy as a new entry (moved to the end for placing, then back beside the original).
    const others = entries.filter((_, k) => k !== i + 1);
    const p = placeNew(b, [...others, { ...copy, x: undefined, y: undefined }], others.length, ctx);
    const last = p.pop()!;
    placed = [...p.slice(0, i + 1), last, ...p.slice(i + 1)];
  }
  return accept({ ...b, entries: placed, switch: remapSwitch(b.switch, (k) => (k > i ? k + 1 : k)) });
}

/** Change one use's settings (volume, pitch, weight, position, at zero weight, curves), clamped. */
export function setEntryUse(b: PlaylistBody, i: number, patch: Partial<EntryUse>): EditResult<PlaylistBody> {
  const e = b.entries[i];
  if (!e) return refuse("that entry isn't there");
  const next = { ...e, ...patch } as Entry;
  if (patch.volume !== undefined) next.volume = round(clamp(patch.volume, ...USE_LIMITS.volume), 0.1);
  if (patch.pitch !== undefined) next.pitch = round(clamp(patch.pitch, ...USE_LIMITS.pitch), 0.01);
  if (patch.weight !== undefined) next.weight = Math.round(clamp(patch.weight, ...USE_LIMITS.weight));
  // ADR 0350: `region` or `weightCurve` patched to undefined is cleared ("reset to automatic").
  for (const k of ["region", "weightCurve"] as const) if (k in patch && patch[k] === undefined) delete next[k];
  const entries = [...b.entries];
  entries[i] = next;
  return accept({ ...b, entries });
}

/** "Unlink": a linked entry becomes an embedded copy of the playlist it links (`linked`, its parsed body), keeping its use settings. */
export function unlinkEntry(b: PlaylistBody, i: number, linked: PlaylistBody | null): EditResult<PlaylistBody> {
  const e = b.entries[i];
  if (!e || e.kind !== "linked") return refuse("only a linked playlist can be unlinked");
  if (!linked) return refuse(`${e.playlist} can't be read`);
  const { format: _format, ...body } = linked as PlaylistBody & { format?: string };
  const { kind: _kind, playlist: _playlist, ...use } = e;
  const entries = [...b.entries];
  entries[i] = { ...use, kind: "embedded", embedded: structuredClone(body) };
  return accept({ ...b, entries });
}

/** "Make shared": an embedded entry becomes a link to `path` (the caller writes the embedded body there first). */
export function linkEntry(b: PlaylistBody, i: number, path: string): EditResult<PlaylistBody> {
  const e = b.entries[i];
  if (!e || e.kind !== "embedded") return refuse("only an embedded playlist can be made shared");
  const { kind: _kind, embedded: _embedded, ...use } = e;
  const entries = [...b.entries];
  entries[i] = { ...use, kind: "linked", playlist: path };
  return accept({ ...b, entries });
}

/** Replace entry `i` with the entries of its embedded playlist (deleting a playlist but keeping what was inside it). */
export function spliceUp(b: PlaylistBody, i: number, ctx: EditContext): EditResult<PlaylistBody> {
  const e = b.entries[i];
  if (!e || e.kind !== "embedded") return refuse("only an embedded playlist holds entries");
  const inner = e.embedded.entries.map((x) => (x.kind === "sample" ? sampleEntry(b, x.sample) : x));
  if (b.entries.length - 1 + inner.length > PLAYLIST_LIMITS.entries) return refuse(`a playlist holds at most ${PLAYLIST_LIMITS.entries} entries`);
  const removed = removeEntry(b, i);
  if ("refused" in removed) return removed;
  return inner.length ? addEntries(removed.next, inner, ctx) : removed;
}

// --- type settings ---------------------------------------------------------------------------------------------------

/** Change the Queue settings (pick, avoid last 0..5, continuous with a gap). */
export function setQueue(b: PlaylistBody, patch: Partial<QueueSettings>): EditResult<PlaylistBody> {
  if (!b.queue) return refuse("this isn't a Queue");
  const q = { ...b.queue, ...patch };
  q.avoidRepeat = Math.round(clamp(q.avoidRepeat, 0, 5));
  if (q.continuous) q.continuous = { gapMs: Math.round(clamp(q.continuous.gapMs, -10000, 60000)) };
  return accept({ ...b, queue: q });
}

/** The labelled parameters a Switch can follow. */
export const labelledParameters = (defs: readonly ParameterDef[]) => defs.filter(isLabelled);

/** Follow another labelled parameter: labels map to entries in turn (`i mod n`), as the prototype's `modeInit` does; label gains reset. */
export function setSwitchParameter(b: PlaylistBody, name: string, ctx: EditContext): EditResult<PlaylistBody> {
  if (!b.switch) return refuse("this isn't a Switch");
  const def = labelledParameters(ctx.parameters).find((p) => p.name === name);
  if (!def) return refuse(`${name} isn't a labelled parameter`);
  return accept({ ...b, switch: { ...b.switch, parameter: name, map: defaultMap(def.labels, b.entries.length), labelGain: {} } });
}

/** Labels to entries in turn, or nothing without entries. */
export const defaultMap = (labels: readonly string[], n: number): Record<string, number | null> => Object.fromEntries(labels.map((l, i) => [l, n ? i % n : null]));

/** What a label plays: an entry index, or null for nothing. */
export function setLabelEntry(b: PlaylistBody, label: string, entry: number | null): EditResult<PlaylistBody> {
  if (!b.switch) return refuse("this isn't a Switch");
  if (entry !== null && !b.entries[entry]) return refuse("that entry isn't there");
  return accept({ ...b, switch: { ...b.switch, map: { ...b.switch.map, [label]: entry } } });
}

/** A label's gain, −24..+12 dB (0 removes it). */
export function setLabelGain(b: PlaylistBody, label: string, db: number): EditResult<PlaylistBody> {
  if (!b.switch) return refuse("this isn't a Switch");
  const labelGain = { ...b.switch.labelGain };
  const v = round(clamp(db, -24, 12), 0.1);
  if (v === 0) delete labelGain[label];
  else labelGain[label] = v;
  return accept({ ...b, switch: { ...b.switch, labelGain } });
}

/** A change's length in its unit: ms when it acts now or on the next trigger, else beats (0..9999 either way). */
export function changeLength(c: ChangeHow, value: number): ChangeHow["length"] {
  const v = clamp(value, 0, 9999);
  return c.when === "now" || c.when === "nextTrigger" ? { ms: Math.round(v) } : { beats: round(v, 0.25) };
}

/** A change with `patch` applied; switching between "now" and a musical time converts the length's unit (500 ms per beat). */
function patchChange<T extends ChangeHow>(c: T, patch: Partial<ChangeHow>): T {
  const next = { ...c, ...patch };
  const timed = (w: ChangeHow["when"]) => w === "now" || w === "nextTrigger";
  if (patch.when && timed(patch.when) !== timed(c.when) && !patch.length) {
    const old = "ms" in c.length ? c.length.ms : c.length.beats * 500;
    next.length = timed(patch.when) ? { ms: Math.round(old) } : { beats: Math.max(0.25, round(old / 500, 0.25)) };
  }
  if (next.how !== "transition") { delete next.transition; delete next.transitionIn; delete next.transitionOut; }
  // ADR 0350: a field patched to undefined goes back to its default (absent), as the parse reads it.
  for (const k of Object.keys(patch) as (keyof ChangeHow)[]) if (patch[k] === undefined) delete next[k];
  return next;
}

/** The Switch's default "When it changes". */
export function setOnChange(b: PlaylistBody, patch: Partial<ChangeHow>): EditResult<PlaylistBody> {
  if (!b.switch) return refuse("this isn't a Switch");
  return accept({ ...b, switch: { ...b.switch, onChange: patchChange(b.switch.onChange, patch) } });
}

/** A new rule: from any label to the first, now, crossfade 300 ms (the prototype's default). */
export function addRule(b: PlaylistBody, labels: readonly string[]): EditResult<PlaylistBody> {
  if (!b.switch) return refuse("this isn't a Switch");
  if (b.switch.rules.length >= PLAYLIST_LIMITS.rules) return refuse(`a Switch holds at most ${PLAYLIST_LIMITS.rules} rules`);
  const rule: ChangeRule = { from: "*", to: labels[0] ?? "*", when: "now", how: "crossfade", length: { ms: 300 } };
  return accept({ ...b, switch: { ...b.switch, rules: [...b.switch.rules, rule] } });
}

export function removeRule(b: PlaylistBody, i: number): EditResult<PlaylistBody> {
  if (!b.switch?.rules[i]) return refuse("that rule isn't there");
  return accept({ ...b, switch: { ...b.switch, rules: b.switch.rules.filter((_, k) => k !== i) } });
}

export function setRule(b: PlaylistBody, i: number, patch: Partial<ChangeRule>): EditResult<PlaylistBody> {
  const r = b.switch?.rules[i];
  if (!b.switch || !r) return refuse("that rule isn't there");
  const rules = [...b.switch.rules];
  rules[i] = patchChange(r, patch);
  return accept({ ...b, switch: { ...b.switch, rules } });
}

/** Change the Blend's settings (fade, curve, follow or hold, glide 0..5000 ms). */
export function setBlend(b: PlaylistBody, patch: Partial<Omit<BlendSettings, "axes" | "envelope">>): EditResult<PlaylistBody> {
  if (!b.blend) return refuse("this isn't a Blend");
  const next = { ...b.blend, ...patch };
  if (typeof next.follow === "object") next.follow = { glideMs: Math.round(clamp(next.follow.glideMs, 0, 5000)) };
  return accept({ ...b, blend: next });
}

/** An axis for voice time (0.2..30 s) or a parameter. */
export function voiceTimeAxis(seconds: number): BlendAxis {
  return { voiceTime: round(clamp(seconds, 0.2, 30), 0.1) };
}

/**
 * Change axis `k`: entries keep their place relative to the axis (a position at 30 % of the old range sits at 30 % of
 * the new one), so changing what drives a Blend never piles every entry at one end.
 */
export function setAxis(b: PlaylistBody, k: 0 | 1, axis: BlendAxis, ctx: EditContext): EditResult<PlaylistBody> {
  if (!b.blend) return refuse("this isn't a Blend");
  if (k === 1 && b.blend.axes.length < 2) return refuse("a 1D Blend has one axis");
  if ("parameter" in axis && !ctx.parameters.some((p) => p.name === axis.parameter && !isLabelled(p))) return refuse(`${axis.parameter} isn't a numeric parameter`);
  const from = axisRange(b.blend.axes[k]!, ctx.parameters), to = axisRange(axis, ctx.parameters);
  const key = k === 0 ? "x" : "y";
  const map = (v: number | undefined) => (v === undefined ? v : round(to[0] + ((v - from[0]) / (from[1] - from[0] || 1)) * (to[1] - to[0]), 1e-6));
  const axes = [...b.blend.axes] as BlendSettings["axes"];
  axes[k] = axis;
  return accept({ ...b, blend: { ...b.blend, axes }, entries: b.entries.map((e) => ({ ...e, [key]: map(e[key]) })) });
}

/** 1D or 2D: a second axis (the first other numeric parameter, else voice time) with entries spread across it; back to 1D drops y. */
export function setDimensions(b: PlaylistBody, dims: 1 | 2, ctx: EditContext): EditResult<PlaylistBody> {
  if (!b.blend) return refuse("this isn't a Blend");
  if (b.blend.axes.length === dims) return accept(b);
  if (dims === 1) return accept({ ...b, blend: { ...b.blend, axes: [b.blend.axes[0]] }, entries: b.entries.map(({ y: _y, ...e }) => e as Entry) });
  const first = b.blend.axes[0];
  const used = "parameter" in first ? first.parameter : null;
  const other = ctx.parameters.find((p) => !isLabelled(p) && p.name !== used);
  const axis: BlendAxis = other ? { parameter: other.name } : { voiceTime: 2 };
  const ry = axisRange(axis, ctx.parameters);
  const entries = b.entries.map((e, i) => ({ ...e, y: round(ry[0] + (i % 2 === 0 ? 0.15 : 0.85) * (ry[1] - ry[0]), 1e-6) }));
  return accept({ ...b, blend: { ...b.blend, axes: [first, axis] }, entries });
}

/** The voice envelope's mode (off, morph between low and high, per zone). */
export function setEnvelopeMode(b: PlaylistBody, mode: BlendSettings["envelope"]["mode"]): EditResult<PlaylistBody> {
  if (!b.blend) return refuse("this isn't a Blend");
  return accept({ ...b, blend: { ...b.blend, envelope: { ...b.blend.envelope, mode } } });
}

/** ADSR limits (the prototype's): attack 0..2000 ms, decay 0..4000 ms, sustain 0..1, release 0..4000 ms. */
export const ADSR_LIMITS: Record<keyof Adsr, readonly [number, number]> = { attackMs: [0, 2000], decayMs: [0, 4000], sustain: [0, 1], releaseMs: [0, 4000] };

export function setAdsr(b: PlaylistBody, which: "low" | "high", patch: Partial<Adsr>): EditResult<PlaylistBody> {
  if (!b.blend) return refuse("this isn't a Blend");
  const env = { ...b.blend.envelope[which], ...patch };
  for (const k of Object.keys(ADSR_LIMITS) as (keyof Adsr)[]) env[k] = k === "sustain" ? round(clamp(env[k], ...ADSR_LIMITS[k]), 0.01) : Math.round(clamp(env[k], ...ADSR_LIMITS[k]));
  return accept({ ...b, blend: { ...b.blend, envelope: { ...b.blend.envelope, [which]: env } } });
}

// --- clip ------------------------------------------------------------------------------------------------------------

/** "Choose sample…" / "Replace sample…": a Clip plays this sample (its trim and loop reset; its use settings kept). */
export function setClipSample(b: PlaylistBody, sample: string): EditResult<PlaylistBody> {
  if (b.type !== "clip") return refuse("only a Clip plays a sample directly");
  const old = b.entries[0];
  const s: SampleEntry = { ...(old ?? defaultEntryUse()), kind: "sample", sample, trim: null, loop: old?.kind === "sample" ? old.loop : "inherit" } as SampleEntry;
  return accept({ ...b, entries: [s, ...b.entries.slice(1)] });
}

/** The Clip's trim (seconds, at least 20 ms long; null: the sample's own) and loop (inherit / off / on). */
export function setClipSampleFields(b: PlaylistBody, patch: Partial<Pick<SampleEntry, "trim" | "loop">>): EditResult<PlaylistBody> {
  const s = b.entries[0];
  if (b.type !== "clip" || !s || s.kind !== "sample") return refuse("this Clip has no sample yet");
  const next: SampleEntry = { ...s, ...patch };
  if (patch.trim) {
    const start = Math.max(0, patch.trim[0]);
    const end = Math.max(start + 0.02, patch.trim[1]);
    next.trim = [round(start, 0.001), round(end, 0.001)];
  }
  return accept({ ...b, entries: [next, ...b.entries.slice(1)] });
}

/** The playlist's own level and random variation per trigger ([low, high] dB within ±48, st within ±24). */
export function setLevels(b: PlaylistBody, patch: Partial<Pick<PlaylistBody, "volume" | "pitch" | "volumeRandom" | "pitchRandom">>): EditResult<PlaylistBody> {
  const next = { ...b, ...patch };
  next.volume = round(clamp(next.volume, -96, 24), 0.1);
  next.pitch = round(clamp(next.pitch, -48, 48), 0.01);
  const pair = (p: [number, number], lim: number): [number, number] => {
    const lo = round(clamp(p[0], -lim, lim), 0.1), hi = round(clamp(p[1], -lim, lim), 0.1);
    return lo <= hi ? [lo, hi] : [hi, lo];
  };
  next.volumeRandom = pair(next.volumeRandom, 48);
  next.pitchRandom = pair(next.pitchRandom, 24);
  return accept(next);
}

// --- playback, output, effects, spatial ------------------------------------------------------------------------------

/** The playback rules: plays, max instances 0..32, when full, cooldown 0..5 s, chance 0..1, delay 0..2 s, priority 0..255. */
export function setPlayback(b: PlaylistBody, patch: Partial<PlaybackRules>): EditResult<PlaylistBody> {
  const p = { ...b.playback, ...patch };
  p.maxInstances = Math.round(clamp(p.maxInstances, 0, 32));
  p.cooldown = round(clamp(p.cooldown, 0, 5), 0.01);
  p.chance = round(clamp(p.chance, 0, 1), 0.01);
  p.delay = round(clamp(p.delay, 0, 2), 0.001);
  p.priority = Math.round(clamp(p.priority, 0, 255));
  return accept({ ...b, playback: p });
}

/** The output bus override (null: inherited). */
export function setOutput(b: PlaylistBody, bus: string | null, buses: readonly string[]): EditResult<PlaylistBody> {
  if (bus !== null && !buses.includes(bus)) return refuse(`there's no bus named ${bus}`);
  return accept({ ...b, output: bus });
}

export const setEffects = (b: PlaylistBody, effects: Effect[]): EditResult<PlaylistBody> => accept({ ...b, effects });

/** Replace the instance automation (an effect's lanes, `effectAutomation.ts`). */
export const setAutomation = (b: PlaylistBody, automation: PlaylistBody["automation"]): EditResult<PlaylistBody> => accept({ ...b, automation });

/**
 * The spatial block: null makes the playlist flat (2D); a patch on a flat one starts from the defaults, occlusion on
 * (ADR 0162: a positioned sound is occluded unless it opts out).
 */
export function setSpatial(b: PlaylistBody, patch: Partial<PlaylistSpatial> | null): EditResult<PlaylistBody> {
  if (patch === null) return accept({ ...b, spatial: null });
  const base: PlaylistSpatial = b.spatial ?? { attenuation: null, occlusion: true, doppler: 0, spread: null };
  const next = { ...base, ...patch };
  next.doppler = round(clamp(next.doppler, 0, 5), 0.1);
  if (next.spread !== null) next.spread = Math.round(clamp(next.spread, 0, 360));
  return accept({ ...b, spatial: next });
}

/** Replace the local parameters (the panel's edits produce the list; at most the core's slots). */
export function setParameters(b: PlaylistBody, parameters: ParameterDef[]): EditResult<PlaylistBody> {
  if (parameters.length > PLAYLIST_LIMITS.parameters) return refuse(`a playlist has at most ${PLAYLIST_LIMITS.parameters} local parameters`);
  const names = parameters.map((p) => p.name);
  if (names.some((n) => n.trim() === "")) return refuse("a parameter needs a name");
  if (new Set(names).size !== names.length) return refuse("two parameters can't share a name");
  // A rename (one name changed, nothing added or removed) renames what reads it too, in this one edit (the engine's walk).
  const changed = parameters.length === b.parameters.length ? parameters.flatMap((p, i) => (p.name !== b.parameters[i]!.name ? [i] : [])) : [];
  const renamed = changed.length === 1 ? renamePlaylistParameter(b, b.parameters[changed[0]!]!.name, parameters[changed[0]!]!.name, "local") : b;
  return accept({ ...renamed, parameters });
}
