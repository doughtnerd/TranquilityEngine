// Changing a playlist's type (the prototype's type segment and `modeInit`, PL:1040–1061; ADR 0343 "one kind keeps
// change type a field edit"). The format keeps another type's block when the type changes, so switching back restores
// its settings; a block that isn't there yet starts from the prototype's defaults:
//
// - Queue: Random, avoid the last 1.
// - Switch: its parameter if it is labelled, else the first labelled parameter; labels map to entries in turn.
// - Blend: a 1D blend over the first numeric parameter (else voice time), entries spread over 10–90 % of the range.
// - Clip: plays samples only. Embedded Clips unwrap to their samples; any other entry refuses the change (nothing is
//   dropped silently).
// - From a Clip: each sample is wrapped in an embedded Clip.
// - Sequence: the entries become one playlist track each (a clip at 0); back out of a Sequence with no entries, its
//   clips become entries again (sample clips as embedded Clips, playlist clips as they were), once each in time order.
// Pure.
import { defaultBlend, defaultEntryUse, defaultQueue, defaultSequence, defaultSwitch, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { Clip, Entry, PlaylistBody, PlaylistType, SampleEntry, Track } from "../../../engine/audio/playlist/types";
import { isLabelled } from "../../../engine/audio/parameters";
import { accept, refuse, type EditResult } from "../../../plugins/audio/editor/editResult";
import { axisRange, spreadPositions } from "./blendPlacement";
import { defaultMap, sampleEntry, type EditContext } from "./playlistEdits";
import { entryName } from "./playlistPaths";

/** The samples a Clip would play after a change of type, or why it can't. */
function clipEntries(b: PlaylistBody): EditResult<SampleEntry[]> {
  const out: SampleEntry[] = [];
  let others = 0;
  for (const e of b.entries) {
    if (e.kind === "sample") out.push(e);
    else if (e.kind === "embedded" && e.embedded.type === "clip" && e.embedded.entries[0]?.kind === "sample") {
      const s = e.embedded.entries[0];
      out.push({ ...s, volume: e.volume, pitch: e.pitch });
    } else others++;
  }
  if (others) return refuse(`a Clip plays one sample, and ${others === 1 ? "one entry isn't a sample" : `${others} entries aren't samples`}; remove ${others === 1 ? "it" : "them"} first`);
  return accept(out);
}

/** Entries of a body that was a Clip, for another type: each sample in an embedded Clip with its use settings on the wrapper. */
function wrapSamples(b: PlaylistBody, type: PlaylistType): Entry[] {
  const target = { ...b, type };
  return b.entries.map((e) => {
    // ADR 0354 §5: a line plays only in a Clip, so it moves into an embedded Clip of its own (use settings on the wrapper).
    if (e.kind === "line") {
      const { kind: _k, line, ...use } = e;
      return { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [{ kind: "line", line, ...defaultEntryUse() }] }, ...use } as Entry;
    }
    // ADR 0360: a generator too (minimal until G4).
    if (e.kind === "generator") {
      const { kind: _k, generator, ...use } = e;
      return { kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [{ kind: "generator", generator, ...defaultEntryUse() }] }, ...use } as Entry;
    }
    if (e.kind !== "sample") return e;
    const { kind: _k, sample, trim, loop, ...use } = e;
    const w = sampleEntry(target, sample);
    if (w.kind !== "embedded") return e;
    return { ...w, ...use, embedded: { ...w.embedded, entries: [{ kind: "sample", sample, trim, loop, ...defaultEntryUse() }] } } as Entry;
  });
}

/** Tracks for a body becoming a Sequence: one playlist track per entry, its clip at 0 (length 0: the entry's natural length). */
function tracksFrom(entries: readonly Entry[]): Track[] {
  return entries.map((e, i): Track => {
    const clip: Clip = {
      id: `c${i + 1}`, at: 0, length: 0, offset: 0, gain: e.volume, pitch: e.pitch, pan: 0, reverse: false, sync: false, enabled: true,
      loops: {}, hiddenMarkers: [], effects: [], automation: [],
      ...(e.kind === "linked" ? { playlist: e.playlist }
        : e.kind === "embedded" ? { playlist: structuredClone(e.embedded) }
        // ADR 0354 §5: a line becomes a playlist clip holding a Clip with that line.
        : e.kind === "line" ? { playlist: { ...emptyPlaylistBody("clip"), entries: [{ kind: "line" as const, line: structuredClone(e.line), ...defaultEntryUse() }] } }
        // ADR 0360: a generator becomes a generator clip on an audio track.
        : e.kind === "generator" ? { generator: structuredClone(e.generator) }
        : { sample: e.sample }),
    };
    return {
      id: `t${i + 1}`, name: entryName(e, i), kind: e.kind === "sample" || e.kind === "generator" ? "audio" : "playlist", color: (i % 8) + 1, volume: 0, pan: 0, output: null,
      mute: false, solo: false, enabled: true, effects: [], automation: [], clips: [clip],
    };
  });
}

/** Entries from a Sequence's clips (time order, then track order), each source once. */
function entriesFrom(b: PlaylistBody): Entry[] {
  const clips = (b.sequence?.tracks ?? []).flatMap((t, ti) => t.clips.map((c) => ({ c, ti }))).sort((a, z) => a.c.at - z.c.at || a.ti - z.ti);
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const { c } of clips) {
    const key = c.sample !== undefined ? `s:${c.sample}` : typeof c.playlist === "string" ? `p:${c.playlist}` : `e:${JSON.stringify(c.playlist)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.sample !== undefined) {
      const inner: SampleEntry = { kind: "sample", sample: c.sample, trim: null, loop: "inherit", ...defaultEntryUse() };
      out.push({ kind: "embedded", ...defaultEntryUse(), atZeroWeight: "stop", embedded: { ...emptyPlaylistBody("clip"), entries: [inner] } });
    } else if (typeof c.playlist === "string") out.push({ kind: "linked", playlist: c.playlist, ...defaultEntryUse() });
    else if (c.playlist) out.push({ kind: "embedded", embedded: structuredClone(c.playlist), ...defaultEntryUse() });
  }
  return out;
}

/** `b` as a playlist of `type` (see the header for what each change does). */
export function convertType(b: PlaylistBody, type: PlaylistType, ctx: EditContext): EditResult<PlaylistBody> {
  if (b.type === type) return accept(b);
  let entries: Entry[] = b.entries;
  if (b.type === "sequence" && entries.length === 0) entries = entriesFrom(b);
  if (type === "clip") {
    const s = clipEntries({ ...b, entries });
    if ("refused" in s) return s;
    return accept({ ...b, type, entries: s.next });
  }
  if (b.type === "clip") entries = wrapSamples({ ...b, entries }, type);
  const next: PlaylistBody = { ...b, type, entries };
  switch (type) {
    case "queue":
      next.queue = b.queue ?? defaultQueue();
      break;
    case "switch": {
      const labelled = ctx.parameters.filter(isLabelled);
      const keep = b.switch && labelled.find((p) => p.name === b.switch!.parameter);
      if (keep) next.switch = { ...b.switch!, map: Object.fromEntries(Object.entries(b.switch!.map).map(([l, i]) => [l, i !== null && i < entries.length ? i : null])) };
      else {
        const def = labelled[0];
        next.switch = { ...(b.switch ?? defaultSwitch()), parameter: def?.name ?? "", map: def ? defaultMap(def.labels, entries.length) : {}, labelGain: {} };
      }
      break;
    }
    case "blend": {
      let blend = b.blend;
      if (!blend) {
        const numeric = ctx.parameters.find((p) => !isLabelled(p));
        blend = { ...defaultBlend(), axes: [numeric ? { parameter: numeric.name } : { voiceTime: 2 }] };
      }
      next.blend = blend;
      const rx = axisRange(blend.axes[0], ctx.parameters);
      const ry = blend.axes[1] ? axisRange(blend.axes[1], ctx.parameters) : undefined;
      if (entries.some((e) => e.x === undefined || (ry && e.y === undefined))) {
        const spots = spreadPositions(entries.length, rx, ry);
        next.entries = entries.map((e, i) => ({ ...e, x: spots[i]!.x, ...(ry ? { y: spots[i]!.y } : {}) }));
      }
      break;
    }
    case "sequence":
      if (!b.sequence || b.sequence.tracks.length === 0) next.sequence = { ...(b.sequence ?? defaultSequence()), tracks: tracksFrom(entries) };
      break;
    case "layer":
      break;
  }
  return accept(next);
}

/** The type control's options, with why one can't be picked now. */
export function typeOptions(b: PlaylistBody): { value: PlaylistType; label: string; title?: string; disabled?: boolean }[] {
  const toClip = b.type === "clip" ? null : clipEntries(b.type === "sequence" && b.entries.length === 0 ? { ...b, entries: entriesFrom(b) } : b);
  return [
    { value: "clip", label: "Clip", ...(toClip && "refused" in toClip ? { disabled: true, title: `Can't be a Clip: ${toClip.refused}` } : { title: "Plays one sample" }) },
    { value: "queue", label: "Queue", title: "Picks one entry per trigger: random, shuffle or round robin" },
    { value: "switch", label: "Switch", title: "A labelled game parameter picks the entry" },
    { value: "blend", label: "Blend", title: "Crossfades entries over one or two parameters, or voice time" },
    { value: "layer", label: "Layer", title: "Plays every entry at once" },
    { value: "sequence", label: "Sequence", title: "A timeline of tracks and clips (edited from M5)" },
  ];
}
