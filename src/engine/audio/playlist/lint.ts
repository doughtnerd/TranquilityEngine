/**
 * Playlist lint (ADR 0329): non-fatal warnings the Studio shows beside a playlist. The parse (`format.ts`) already
 * repaired what the runtime can't play; these are files that play, but not the way their author likely meant:
 *
 * - `noTempoSource`: a Switch change or a stinger waits for a beat or bar, but the playing entry has no tempo (no sequence
 *   tempo, no sync sample with a tempo), so it acts at once;
 * - `tempoClash`: a sync clip's sample has a tempo other than its sequence's (v1 plays samples at their own tempo);
 * - `overlappingSyncLoops`: sync clips on two tracks overlap in time, so the higher track drives and the other follows;
 * - `allWeightsZero`: a random Queue whose every entry has weight 0 never plays anything;
 * - `unboundLoop`: a loop active "while a parameter…" with no parameter binding never turns active;
 * - `unboundParameter`: a Switch or a Blend axis that names no parameter;
 * - `unknownLabel`: a Switch map label that isn't one of its local parameter's labels;
 * - `trackKindMismatch`: a sample clip on a playlist track or a playlist clip on an audio track;
 * - `danglingEffectTarget`: automation of an effect (or a parameter) its owner's chain doesn't have (a clip's, a
 *   track's, or a playlist's own instance-level automation against the playlist's `effects`);
 * - `quantizeIgnored` (ADR 0336): a quantised lane or entry voice curve keyed on time, or a lane of an effect parameter
 *   the voice doesn't carry (only low-pass and high-pass cutoff and a gain effect's gain are; it follows its parameter);
 * - `quantizeNoTempo` (ADR 0336): a quantised lane or entry voice curve in a playlist with no tempo (it moves at once);
 * - `regionIgnored` (ADR 0336): a region on an entry of a 2D Blend (regions are 1D; 2D shapes by weight curves);
 * - `tailWithoutExit` (ADR 0336): a sequence loop with `tail` but no Exit marker after its end (it has nothing to ring).
 *
 * Embedded playlists are linted too, with their place in `where`. What the Studio knows about samples and linked
 * playlists comes in through `LintContext`; without it the rules that need it stay quiet rather than guess.
 *
 * Pure; no plugin, no DOM.
 */
import { effectParamSpec } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import { isLabelled } from "../parameters";
import type { Automation, ChangeHow, Entry, PlaylistBody, Track } from "./types";

export type PlaylistLintCode =
  | "noTempoSource" | "tempoClash" | "overlappingSyncLoops" | "allWeightsZero" | "unboundLoop" | "unboundParameter" | "unknownLabel"
  | "trackKindMismatch" | "danglingEffectTarget" | "quantizeIgnored" | "quantizeNoTempo" | "regionIgnored" | "tailWithoutExit";

export interface PlaylistLint {
  code: PlaylistLintCode;
  /** The place in the playlist, as the parse's problem lines name it (`switch.rules[0]`). */
  where: string;
  message: string;
}

/** What the Studio knows beyond the playlist file. Every member is optional; an unknown answer is `undefined`. */
export interface LintContext {
  /** A sample's tempo (an audio file or a `*.sample.json`): `{ bpm }`, null when it has none, undefined when unknown. */
  sampleTempo?(path: string): { bpm: number } | null | undefined;
  /** A linked playlist, parsed; null or undefined when it can't be read. */
  playlist?(path: string): PlaylistBody | null | undefined;
}

type Tri = "yes" | "no" | "unknown";

/** Every lint of `body`, in file order. */
export function lintPlaylist(body: PlaylistBody, ctx: LintContext = {}): PlaylistLint[] {
  const out: PlaylistLint[] = [];
  const add = (code: PlaylistLintCode, where: string, message: string) => out.push({ code, where, message });
  const join = (where: string, key: string) => (where ? `${where}.${key}` : key);

  // --- tempo sources ---
  const tempoOfSample = (path: string): Tri => {
    const t = ctx.sampleTempo?.(path);
    return t === undefined ? "unknown" : t ? "yes" : "no";
  };
  const tempoOfEntry = (e: Entry, seen: Set<string>): Tri => {
    if (e.kind === "sample") return tempoOfSample(e.sample);
    if (e.kind === "embedded") return tempoOfBody(e.embedded, seen);
    if (e.kind === "line") return "unknown"; // its file is chosen when it plays (ADR 0340 §5)
    if (seen.has(e.playlist)) return "unknown";
    const linked = ctx.playlist?.(e.playlist);
    return linked ? tempoOfBody(linked, new Set([...seen, e.playlist])) : "unknown";
  };
  const all = (xs: Tri[]): Tri => (xs.length && xs.every((x) => x === "yes") ? "yes" : xs.some((x) => x === "no") ? "no" : xs.length ? "unknown" : "no");
  const any = (xs: Tri[]): Tri => (xs.some((x) => x === "yes") ? "yes" : xs.every((x) => x === "no") ? "no" : "unknown");
  const tempoOfBody = (b: PlaylistBody, seen: Set<string>): Tri => {
    if (b.type === "sequence") {
      if (b.sequence?.tempo) return "yes";
      const syncs = (b.sequence?.tracks ?? []).flatMap((t) => t.clips).filter((c) => c.sync && c.sample !== undefined);
      return syncs.length ? any(syncs.map((c) => tempoOfSample(c.sample!))) : "no";
    }
    if (b.type === "clip") return b.entries[0] ? tempoOfEntry(b.entries[0], seen) : "no";
    const entries = b.entries.map((e) => tempoOfEntry(e, seen));
    return b.type === "layer" ? any(entries) : all(entries);
  };
  const entryName = (e: Entry, i: number): string => (e.kind === "linked" ? e.playlist : e.kind === "sample" ? e.sample : `entry ${i + 1}`);

  // --- effect targets ---
  const automation = (list: readonly Automation[], chain: readonly Effect[], where: string, owner?: PlaylistBody) => {
    list.forEach((a, i) => {
      if (a.quantize !== undefined) {
        const fx = a.target.startsWith("fx:") ? chain.find((e) => e.id === a.target.split(":")[1]) : undefined;
        const param = a.target.split(":")[2];
        const onVoice = !a.target.startsWith("fx:") || (fx?.type === "gain" && param === "gain") || ((fx?.type === "lowpass" || fx?.type === "highpass") && param === "cutoff");
        if (typeof a.input === "string") add("quantizeIgnored", `${where}[${i}].quantize`, `Lane "${a.id}" is keyed on ${a.input}; quantize applies to lanes keyed on a parameter.`);
        else if (!onVoice) add("quantizeIgnored", `${where}[${i}].quantize`, `Lane "${a.id}" of ${a.target} can't be quantised (volume, enabled, pitch, pan, low-pass and high-pass cutoff and gain lanes can); it follows its parameter.`);
        else if (owner && tempoOfBody(owner, new Set()) === "no") add("quantizeNoTempo", `${where}[${i}].quantize`, `Lane "${a.id}" waits for the next beat, but this playlist has no tempo, so it moves at once.`);
      }
      if (!a.target.startsWith("fx:")) return;
      const [, id, param] = a.target.split(":");
      const fx = chain.find((e) => e.id === id);
      if (!fx) add("danglingEffectTarget", `${where}[${i}]`, `Automation of effect "${id}", which isn't in this chain; it does nothing.`);
      else if (param !== "on" && !effectParamSpec(fx.type, param)) add("danglingEffectTarget", `${where}[${i}]`, `Automation of "${param}", which effect "${id}" doesn't have; it does nothing.`);
    });
  };

  const visit = (b: PlaylistBody, where: string) => {
    const w = (k: string) => join(where, k);
    automation(b.automation, b.effects, w("automation"), b);

    if (b.type === "queue" && b.queue?.pick === "random" && b.entries.length > 0 && b.entries.every((e) => e.weight === 0)) {
      add("allWeightsZero", w("entries"), "Every entry has weight 0, so this Queue never plays anything.");
    }

    if (b.switch) {
      const s = b.switch;
      if (s.parameter === "") add("unboundParameter", w("switch.parameter"), "This Switch names no parameter, so it always plays its first entry.");
      const local = b.parameters.find((p) => p.name === s.parameter);
      if (local && isLabelled(local)) {
        for (const label of Object.keys(s.map)) {
          if (!local.labels.includes(label)) add("unknownLabel", w(`switch.map.${label}`), `"${label}" isn't one of ${local.name}'s labels (${local.labels.join(", ")}).`);
        }
      }
      if (b.type === "switch") {
        const mapped = Object.values(s.map).filter((v): v is number => v !== null);
        const indices = mapped.length ? [...new Set(mapped)] : b.entries.map((_, i) => i);
        const timed = (c: ChangeHow, at: string, what: string) => {
          if (c.when !== "beat" && c.when !== "bar") return;
          for (const i of indices) {
            const e = b.entries[i];
            if (e && tempoOfEntry(e, new Set()) === "no") {
              add("noTempoSource", at, `${what} waits for the next ${c.when}, but "${entryName(e, i)}" has no tempo, so it changes at once there.`);
            }
          }
        };
        timed(s.onChange, w("switch.onChange"), "The change");
        s.rules.forEach((r, i) => timed(r, w(`switch.rules[${i}]`), `Rule ${i + 1}`));
      }
    }

    b.stingers.forEach((s, i) => {
      if ((s.at === "beat" || s.at === "bar") && tempoOfBody(b, new Set()) === "no") {
        add("noTempoSource", w(`stingers[${i}]`), `Stinger "${s.trigger}" waits for the next ${s.at}, but this playlist has no tempo, so it plays at once.`);
      }
    });

    if (b.blend) {
      b.blend.axes.forEach((a, i) => {
        if ("parameter" in a && a.parameter === "") add("unboundParameter", w(`blend.axes[${i}]`), "This Blend axis names no parameter, so it stays at its lowest value.");
      });
      if (b.blend.axes.length === 2) {
        b.entries.forEach((e, i) => {
          if (e.region) add("regionIgnored", w(`entries[${i}].region`), `Entry ${i + 1} has a region, but regions shape 1D blends only; in 2D use its weight curve.`);
        });
      }
    }

    if (b.sequence) {
      const seq = b.sequence;
      seq.loops.forEach((l, i) => {
        if (l.active === "parameter" && !l.binding) add("unboundLoop", w(`sequence.loops[${i}]`), `Loop "${l.id}" is active while a parameter holds, but names none, so it never turns active.`);
        if (l.tail && !seq.markers.some((m) => m.type === "exit" && m.at > l.end + 1e-9)) add("tailWithoutExit", w(`sequence.loops[${i}].tail`), `Loop "${l.id}" rings a tail, but no Exit marker follows its end to say where the tail ends; it has none.`);
      });
      const syncs: { track: Track; ti: number; at: number; end: number; id: string }[] = [];
      seq.tracks.forEach((t, ti) => {
        const tw = w(`sequence.tracks[${ti}]`);
        automation(t.automation, t.effects, `${tw}.automation`, b);
        t.clips.forEach((c, ci) => {
          const cw = `${tw}.clips[${ci}]`;
          if (t.kind === "audio" && c.sample === undefined) add("trackKindMismatch", cw, `Clip "${c.id}" plays a playlist on audio track "${t.name}".`);
          if (t.kind === "playlist" && c.sample !== undefined) add("trackKindMismatch", cw, `Clip "${c.id}" plays a sample on playlist track "${t.name}".`);
          for (const [id, o] of Object.entries(c.loops)) {
            if (o.active === "parameter" && !o.binding) add("unboundLoop", `${cw}.loops.${id}`, `Clip "${c.id}" makes loop "${id}" active while a parameter holds, but names none, so it never turns active.`);
          }
          automation(c.automation, c.effects, `${cw}.automation`, b);
          if (c.sync && c.sample !== undefined) {
            if (seq.tempo) {
              const tempo = ctx.sampleTempo?.(c.sample);
              if (tempo && Math.abs(tempo.bpm - seq.tempo.bpm) > 1e-6) {
                add("tempoClash", cw, `Sync clip "${c.id}" plays a sample at ${tempo.bpm} BPM in a ${seq.tempo.bpm} BPM sequence; it isn't stretched.`);
              }
            }
            if (t.enabled && c.enabled) syncs.push({ track: t, ti, at: c.at, end: c.at + c.length, id: c.id });
          }
          if (typeof c.playlist === "object" && c.playlist) visit(c.playlist, `${cw}.playlist`);
        });
      });
      for (let i = 0; i < syncs.length; i++) {
        for (let j = i + 1; j < syncs.length; j++) {
          const a = syncs[i], b2 = syncs[j];
          if (a.ti !== b2.ti && a.at < b2.end && b2.at < a.end) {
            const [hi, lo] = a.ti < b2.ti ? [a, b2] : [b2, a];
            add("overlappingSyncLoops", w(`sequence.tracks[${lo.ti}]`), `Sync clips "${hi.id}" (${hi.track.name}) and "${lo.id}" (${lo.track.name}) overlap; "${hi.track.name}" drives the playhead and "${lo.track.name}" follows.`);
          }
        }
      }
    }

    b.entries.forEach((e, i) => {
      for (const [target, c] of Object.entries(e.curves)) {
        if (!c || c.quantize === undefined) continue;
        const at = w(`entries[${i}].curves.${target}.quantize`);
        if (typeof c.input === "string") add("quantizeIgnored", at, `Entry ${i + 1}'s ${target} curve is keyed on ${c.input}; quantize applies to curves keyed on a parameter.`);
        else if (tempoOfBody(b, new Set()) === "no") add("quantizeNoTempo", at, `Entry ${i + 1}'s ${target} curve waits for the next beat, but this playlist has no tempo, so it moves at once.`);
      }
    });
    b.entries.forEach((e, i) => e.kind === "embedded" && visit(e.embedded, w(`entries[${i}].embedded`)));
    b.stingers.forEach((s, i) => s.playlist.kind === "embedded" && visit(s.playlist.embedded, w(`stingers[${i}].playlist.embedded`)));
    if (b.switch) {
      const t = b.switch.onChange.transition;
      if (t?.kind === "embedded") visit(t.embedded, w("switch.onChange.transition.embedded"));
      b.switch.rules.forEach((r, i) => r.transition?.kind === "embedded" && visit(r.transition.embedded, w(`switch.rules[${i}].transition.embedded`)));
    }
  };

  visit(body, "");
  return out;
}
