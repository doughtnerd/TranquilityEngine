// The Generator editor's waveform preview (ADR 0360 §9): the generator's first seconds rendered by G5's offline render
// (`generators/generatorRender.ts`, the core's own `audio_dsp::gen` kernels in the offline module), so the picture is
// exactly what plays. It runs in the preview worker (`preview.worker.ts`), so editing never waits for it.
//
// - **What renders**: the stored patch as a trigger plays it with `vary` off and the generator's seed (0 when it draws
//   one per trigger, so the picture holds still), at 48 kHz: a finite generator to its end (the module stops where the
//   voice ends), an endless one its first `maxSeconds` (2 s).
// - **The overlay** is the amp envelope as the core runs it: the oscillator's and synth's linear attack, exponential
//   decay and release (each at 1 % of its span at its set time, the release ending at −60 dB), keyed off at `length`;
//   the blip's sfxr attack–sustain–punch–decay, linear, in sfxr's own ticks; a silence's flat zero.
// - `previewBase` and `peaksFromBase` turn the samples into the kit's waveform peaks; `generatorSoundSeconds` is how
//   long a finite generator sounds (a sequence clip's default length).
import { generatorParamIndex, generatorSpec } from "../../../../engine/audio/generators/catalogue";
import { renderGenerator } from "../../../../engine/audio/generators/generatorRender";
import { mulberry32 } from "../../../../engine/audio/generators/random";
import type { GeneratorBody, GeneratorKind } from "../../../../engine/audio/generators/types";
import { buildMips, type PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";

/** How much a preview shows at most, seconds. */
export const PREVIEW_SECONDS = 2;
/** Frames a peak bin covers. */
export const PREVIEW_BIN_FRAMES = 32;

/** sfxr's control rate: a blip's envelope counts its ticks at it. */
const SFXR_RATE = 44_100;
/** What an exponential segment leaves of its span at its set time (`gen::env::SPAN_LEFT`). */
const SPAN_LEFT = 0.01;
/** Where a release ends (`gen::env::END_LEVEL`, −60 dB). */
const END_LEVEL = 0.001;
/** A release lasts this many times its set time to reach `END_LEVEL` (ln 0.001 / ln 0.01). */
const RELEASE_TO_END = Math.log(END_LEVEL) / Math.log(SPAN_LEFT);

export interface GeneratorPreview {
  readonly rate: number;
  /** Mono, as the voice sounds before its gain stage (the offline render). */
  readonly samples: Float32Array;
  /** Its length, seconds (the sound's own length, at most `maxSeconds`). */
  readonly seconds: number;
  /** Where the voice keys off (a finite oscillator or synth's `length`), or null. */
  readonly keyOff: number | null;
  /** It sounds until released (the preview shows its first `maxSeconds`). */
  readonly endless: boolean;
  /** The amplitude envelope, 0..1 at times in seconds, to draw over the waveform. */
  readonly envelope: readonly (readonly [number, number])[];
}

/** The patch the preview plays: `vary` off, the seed fixed. */
const previewBody = (body: GeneratorBody): GeneratorBody => ({ ...body, vary: 0, seed: body.seed ?? 0 });

/** `kind`'s parameter `name` in `values` (wire order), or its default. */
function valueIn(kind: GeneratorKind, values: readonly number[], name: string): number {
  const i = generatorParamIndex(kind, name);
  return i >= 0 ? (values[i] ?? generatorSpec(kind).params[i]!.default) : 0;
}

/** `body`'s parameter `name` as stored, or its default. */
function stored(body: GeneratorBody, name: string): number {
  const v = body.params[name];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return generatorSpec(body.kind).params.find((p) => p.name === name)?.default ?? 0;
}

/** sfxr's stage ticks for an envelope parameter (`floor(p² × 100,000)`, as the kernel counts them). */
const sfxrTicks = (p: number): number => Math.floor(Math.fround(Math.fround(p * p) * 100_000));

/** How long a finite generator sounds, seconds: to the end of its release, its sfxr envelope, or its `length`. */
export function generatorSoundSeconds(body: GeneratorBody): number {
  switch (body.kind) {
    case "silence":
      return stored(body, "length");
    case "blip":
      return (sfxrTicks(stored(body, "attack")) + sfxrTicks(stored(body, "sustain")) + sfxrTicks(stored(body, "decay"))) / SFXR_RATE;
    default:
      return stored(body, "length") + (RELEASE_TO_END * stored(body, "release")) / 1000;
  }
}

/** Points of a piecewise-linear envelope up to `seconds` (the last point at `seconds`). */
function clipPoints(points: readonly (readonly [number, number])[], seconds: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const [t, v] = points[i]!;
    if (t <= seconds) {
      out.push([t, v]);
      continue;
    }
    const [t0, v0] = points[i - 1] ?? [0, 0];
    out.push([seconds, t > t0 ? v0 + ((v - v0) * (seconds - t0)) / (t - t0) : v]);
    return out;
  }
  if (out.length === 0 || out[out.length - 1]![0] < seconds) out.push([seconds, out[out.length - 1]?.[1] ?? 0]);
  return out;
}

/** An ADSR as the core runs it (times in seconds, sustain 0..1), its value at `t` with key-off at `off` (null: held). */
function adsrAt(a: number, d: number, s: number, r: number, rate: number, off: number | null): (t: number) => number {
  const held = (t: number): number => {
    if (a * rate >= 1 && t < a) return t / a;
    const after = t - (a * rate >= 1 ? a : 0);
    return s + (d * rate >= 1 ? (1 - s) * SPAN_LEFT ** (after / d) : 0);
  };
  return (t) => {
    if (off === null || t < off) return held(t);
    if (r * rate < 1) return 0;
    const v = held(off) * SPAN_LEFT ** ((t - off) / r);
    return v < END_LEVEL ? 0 : v;
  };
}

/** The amp envelope of a render of `kind` with `values` over `seconds` (see the file note). */
function ampEnvelope(kind: GeneratorKind, values: readonly number[], seconds: number, rate: number, keyOff: number | null): [number, number][] {
  const v = (name: string) => valueIn(kind, values, name);
  if (kind === "silence") return [[0, 0], [seconds, 0]];
  if (kind === "blip") {
    const k = 1 + 2 * v("punch");
    const t0 = sfxrTicks(v("attack")) / SFXR_RATE;
    const t1 = t0 + sfxrTicks(v("sustain")) / SFXR_RATE;
    const t2 = t1 + sfxrTicks(v("decay")) / SFXR_RATE;
    return clipPoints([[0, 0], [t0, 1 / k], [t0, 1], [t1, 1 / k], [t2, 0]], seconds);
  }
  const at = adsrAt(v("attack") / 1000, v("decay") / 1000, v("sustain") / 100, v("release") / 1000, rate, keyOff);
  const n = 200;
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (seconds * i) / n;
    out.push([t, Math.max(0, Math.min(1, at(t)))]);
  }
  return out;
}

/** The preview of `body`: its first `maxSeconds` (2 s), or to its end, through the offline render. */
export async function renderGeneratorPreview(body: GeneratorBody, maxSeconds = PREVIEW_SECONDS): Promise<GeneratorPreview> {
  const r = await renderGenerator(previewBody(body), mulberry32(0), { seconds: maxSeconds });
  const samples = r.pcm.length === r.frames ? r.pcm : r.pcm.subarray(0, r.frames);
  const seconds = Math.max(r.frames, 1) / r.rate;
  const length = r.kind === "oscillator" || r.kind === "synth" ? valueIn(r.kind, r.values, "length") : 0;
  const keyOff = length > 0 && length < seconds ? length : null;
  return { rate: r.rate, samples, seconds, keyOff, endless: r.endless, envelope: ampEnvelope(r.kind, r.values, seconds, r.rate, keyOff) };
}

/** The samples' base peak level (int16 `[min, max]` pairs per `binFrames` frames). */
export function previewBase(samples: Float32Array, binFrames = PREVIEW_BIN_FRAMES): { binFrames: number; bins: number; data: Int16Array } {
  const bins = Math.max(1, Math.ceil(samples.length / binFrames));
  const data = new Int16Array(bins * 2);
  for (let b = 0; b < bins; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(samples.length, (b + 1) * binFrames);
    for (let i = b * binFrames; i < end; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    data[b * 2] = Math.round(Math.max(-1, lo) * 32767);
    data[b * 2 + 1] = Math.round(Math.min(1, hi) * 32767);
  }
  return { binFrames, bins, data };
}

/** The kit waveform's peaks from a base level (`previewBase`) of a render at `rate`. */
export function peaksFromBase(base: { binFrames: number; bins: number; data: Int16Array }, frames: number, rate: number): PeakMips {
  return { rate, channels: 1, frames, levels: buildMips({ ...base, channels: 1 }) };
}
