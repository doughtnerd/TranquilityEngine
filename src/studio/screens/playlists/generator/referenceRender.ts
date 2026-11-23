// The Generator editor's waveform preview (ADR 0360 §9): a JS reference render of a generator's first seconds, run in
// a worker (`preview.worker.ts`) so editing never waits for it. It resolves the patch with the engine's pure
// `resolveGenerator` (the stored values, `vary` off, the generator's seed or 0 for the noise) and renders it with
// reference versions of the kinds' signal paths: the oscillator's five waves and ADSR, the synth's two oscillators,
// state-variable filter with its envelope, LFO and amp envelope, sfxr's synthesis for the blip (DrPetter's sfxr, MIT;
// jsfxr), and silence. It is a preview, not the core's kernels (those render the sound itself, and G5's offline render
// takes the preview's place when it lands): close enough to see the shape, the envelope and the pitch movement.
//
// What it gives: mono samples at 44.1 kHz for the first `maxSeconds` (2 s) or to the end, where the voice keys off,
// and the amplitude envelope to overlay; `previewBase` and `peaksFromBase` turn the samples into the kit's waveform peaks. Pure.
import { generatorIsEndless, generatorSpec } from "../../../../engine/audio/generators/catalogue";
import { mulberry32, type Draw } from "../../../../engine/audio/generators/random";
import { resolveGenerator } from "../../../../engine/audio/generators/resolve";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import { buildMips, type PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";

/** The preview's sample rate (sfxr's own, so a blip's counters need no conversion). */
export const PREVIEW_RATE = 44100;
/** How much a preview shows at most, seconds. */
export const PREVIEW_SECONDS = 2;

export interface GeneratorPreview {
  readonly rate: number;
  /** Mono, −1..1. */
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

const dbToGain = (db: number) => (db <= -60 ? 0 : 10 ** (db / 20));
const TAU = Math.PI * 2;

/** The stored parameters as a trigger plays them (`vary` off), by name. */
function resolvedParams(body: GeneratorBody): { p: Record<string, number>; seed: number } {
  const r = resolveGenerator({ ...body, vary: 0, seed: body.seed ?? 0 }, () => 0.5);
  const spec = generatorSpec(body.kind);
  return { p: Object.fromEntries(spec.params.map((q, i) => [q.name, r.values[i]!])), seed: r.seed };
}

// --- shared pieces ---------------------------------------------------------------------------------------------------

/** An ADSR in seconds: its level at time `t` with key-off at `off` (null: held). */
function adsr(a: number, d: number, s: number, r: number, off: number | null): (t: number) => number {
  const held = (t: number) => (t < a ? (a > 0 ? t / a : 1) : t < a + d ? 1 - (1 - s) * ((t - a) / Math.max(d, 1e-9)) : s);
  return (t) => {
    if (off === null || t < off) return held(t);
    const from = held(off);
    return r > 0 ? Math.max(0, from * (1 - (t - off) / r)) : 0;
  };
}

/** Noise of a colour (0 white, 1 pink, 2 brown) from a seeded draw. */
function noiseSource(colour: number, draw: Draw): () => number {
  if (colour === 1) {
    // Paul Kellet's economy pink filter.
    let b0 = 0, b1 = 0, b2 = 0;
    return () => {
      const w = draw() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      return (b0 + b1 + b2 + w * 0.1848) * 0.25;
    };
  }
  if (colour === 2) {
    let last = 0;
    return () => {
      last = (last + 0.02 * (draw() * 2 - 1)) / 1.02;
      return last * 3.5;
    };
  }
  return () => draw() * 2 - 1;
}

/** One oscillator wave (0 sine, 1 square, 2 saw, 3 triangle) at phase 0..1 with a pulse width 0..1. */
function wave(kind: number, phase: number, width: number): number {
  switch (kind) {
    case 1: return phase < width ? 1 : -1;
    case 2: return 2 * phase - 1;
    case 3: return 1 - 4 * Math.abs(phase - 0.5);
    default: return Math.sin(phase * TAU);
  }
}

/** Sample points of an envelope function for the overlay. */
function envelopePoints(seconds: number, at: (t: number) => number, n = 200): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (seconds * i) / n;
    out.push([t, Math.max(0, Math.min(1, at(t)))]);
  }
  return out;
}

// --- kinds -----------------------------------------------------------------------------------------------------------

function renderOscillator(p: Record<string, number>, seed: number, maxSeconds: number): GeneratorPreview {
  const off = p.length! > 0 ? p.length! : null;
  const r = p.release! / 1000;
  const seconds = Math.min(maxSeconds, off === null ? maxSeconds : off + r);
  const env = adsr(p.attack! / 1000, p.decay! / 1000, p.sustain! / 100, r, off);
  const n = Math.round(seconds * PREVIEW_RATE);
  const out = new Float32Array(n);
  const gain = dbToGain(p.level!);
  const noise = noiseSource(p.noiseColour!, mulberry32(seed));
  // The catalogue's waves: sine, square, saw, triangle, noise.
  const kind = [0, 1, 2, 3, 4][p.waveform!] ?? 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / PREVIEW_RATE;
    const s = kind === 4 ? noise() : wave(kind, phase, p.pulseWidth! / 100);
    phase = (phase + p.frequency! / PREVIEW_RATE) % 1;
    out[i] = s * env(t) * gain;
  }
  return { rate: PREVIEW_RATE, samples: out, seconds, keyOff: off, endless: off === null, envelope: envelopePoints(seconds, env) };
}

function renderSynth(p: Record<string, number>, seed: number, maxSeconds: number): GeneratorPreview {
  const off = p.length! > 0 ? p.length! : null;
  const r = p.release! / 1000;
  const seconds = Math.min(maxSeconds, off === null ? maxSeconds : off + r);
  const amp = adsr(p.attack! / 1000, p.decay! / 1000, p.sustain! / 100, r, off);
  const fenv = adsr(p.filterAttack! / 1000, p.filterDecay! / 1000, p.filterSustain! / 100, p.filterRelease! / 1000, off);
  const n = Math.round(seconds * PREVIEW_RATE);
  const out = new Float32Array(n);
  const gain = dbToGain(p.level!);
  const draw = mulberry32(seed);
  const noise1 = noiseSource(0, draw), noise2 = noiseSource(0, draw);
  const f2Ratio = 2 ** ((p.osc2Semitones! + p.detune! / 100) / 12);
  const mix = p.oscMix! / 100;
  const depth = p.lfoDepth! / 100;
  const target = p.lfoTarget!; // 0 pitch, 1 cutoff, 2 amp, 3 pulse width
  let ph1 = 0, ph2 = 0, lfoPh = 0, sh = 0;
  let ic1 = 0, ic2 = 0; // the TPT state-variable filter's state
  for (let i = 0; i < n; i++) {
    const t = i / PREVIEW_RATE;
    const lfoPrev = lfoPh;
    lfoPh = (lfoPh + p.lfoRate! / PREVIEW_RATE) % 1;
    if (lfoPh < lfoPrev) sh = draw() * 2 - 1;
    const lfo = p.lfoWave === 4 ? sh : p.lfoWave === 0 ? Math.sin(lfoPh * TAU) : wave([0, 3, 1, 2][p.lfoWave!] ?? 0, lfoPh, 0.5);
    const lfoSt = target === 0 ? lfo * depth * 2 : 0;
    const width = Math.min(0.99, Math.max(0.01, p.pulseWidth! / 100 + (target === 3 ? lfo * depth * 0.49 : 0)));
    const f1 = p.frequency! * 2 ** (lfoSt / 12);
    const o1 = p.osc1Wave === 4 ? noise1() : wave(p.osc1Wave!, ph1, width);
    const o2 = p.osc2Wave === 4 ? noise2() : wave(p.osc2Wave!, ph2, width);
    ph1 = (ph1 + f1 / PREVIEW_RATE) % 1;
    ph2 = (ph2 + (f1 * f2Ratio) / PREVIEW_RATE) % 1;
    const x = o1 * (1 - mix) + o2 * mix;
    const cutSt = p.filterEnvAmount! * fenv(t) + (target === 1 ? lfo * depth * 48 : 0);
    const fc = Math.min(PREVIEW_RATE * 0.45, Math.max(20, p.cutoff! * 2 ** (cutSt / 12)));
    const g = Math.tan((Math.PI * fc) / PREVIEW_RATE);
    const k = 2 - 1.98 * p.resonance!;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    const y = p.filterType === 1 ? x - k * v1 - v2 : p.filterType === 2 ? v1 : v2;
    const a = amp(t) * (target === 2 ? 1 - depth * (0.5 - 0.5 * lfo) : 1);
    out[i] = Math.max(-1, Math.min(1, y * a * gain));
  }
  return { rate: PREVIEW_RATE, samples: out, seconds, keyOff: off, endless: off === null, envelope: envelopePoints(seconds, amp) };
}

/** sfxr's synthesis (jsfxr's `SoundEffect`), in its own 44.1 kHz counters, with `level` in dB for its volume. */
function renderBlip(p: Record<string, number>, seed: number, maxSeconds: number): GeneratorPreview {
  const draw = mulberry32(seed);
  const envLength = [p.attack! ** 2 * 100000, p.sustain! ** 2 * 100000, p.decay! ** 2 * 100000];
  const total = (envLength[0]! + envLength[1]! + envLength[2]!) / PREVIEW_RATE;
  const seconds = Math.min(maxSeconds, Math.max(total, 1 / PREVIEW_RATE));
  const n = Math.max(1, Math.round(seconds * PREVIEW_RATE));
  const out = new Float32Array(n);
  const gain = dbToGain(p.level!);
  const waveType = p.waveform!; // 0 square, 1 saw, 2 sine, 3 noise, 4 triangle

  let fperiod = 0, fmaxperiod = 0, fslide = 0, fdslide = 0, period = 0, squareDuty = 0, squareSlide = 0, arpMod = 0, arpTime = 0, arpLimit = 0;
  const resetPitch = () => {
    fperiod = 100 / (p.baseFrequency! ** 2 + 0.001);
    period = Math.trunc(fperiod);
    fmaxperiod = 100 / (p.frequencyLimit! ** 2 + 0.001);
    fslide = 1 - p.slide! ** 3 * 0.01;
    fdslide = -(p.deltaSlide! ** 3) * 0.000001;
    squareDuty = 0.5 - p.duty! * 0.5;
    squareSlide = -p.dutySweep! * 0.00005;
    arpMod = p.arpeggioAmount! >= 0 ? 1 - p.arpeggioAmount! ** 2 * 0.9 : 1 + p.arpeggioAmount! ** 2 * 10;
    arpTime = 0;
    arpLimit = p.arpeggioSpeed === 1 ? 0 : Math.trunc((1 - p.arpeggioSpeed!) ** 2 * 20000 + 32);
  };
  resetPitch();
  let fltp = 0, fltdp = 0, fltphp = 0;
  let fltw = p.lowpassCutoff! ** 3 * 0.1;
  const fltwD = 1 + p.lowpassSweep! * 0.0001;
  const fltdmp = Math.min(0.8, (5 / (1 + p.lowpassResonance! ** 2 * 20)) * (0.01 + fltw));
  let flthp = p.highpassCutoff! ** 2 * 0.1;
  const flthpD = 1 + p.highpassSweep! * 0.0003;
  let vibPhase = 0;
  const vibSpeed = p.vibratoSpeed! ** 2 * 0.01, vibAmp = p.vibratoDepth! * 0.5;
  let envVol = 0, envStage = 0, envTime = 0;
  let fphase = p.phaserOffset! ** 2 * 1020 * Math.sign(p.phaserOffset!);
  const fdphase = p.phaserSweep! ** 2 * Math.sign(p.phaserSweep!);
  let iphase = Math.abs(Math.trunc(fphase)), ipp = 0;
  const phaser = new Float32Array(1024);
  const noise = new Float32Array(32).map(() => draw() * 2 - 1);
  let repTime = 0;
  const repLimit = p.repeatSpeed === 0 ? 0 : Math.trunc((1 - p.repeatSpeed!) ** 2 * 20000 + 32);
  let phase = 0;
  const envAt: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    if (repLimit !== 0 && ++repTime >= repLimit) {
      repTime = 0;
      resetPitch();
    }
    arpTime++;
    if (arpLimit !== 0 && arpTime >= arpLimit) {
      arpLimit = 0;
      fperiod *= arpMod;
    }
    fslide += fdslide;
    fperiod *= fslide;
    if (fperiod > fmaxperiod) {
      fperiod = fmaxperiod;
      if (p.frequencyLimit! > 0) break; // sfxr ends the sound when the pitch falls to its cutoff
    }
    let rfperiod = fperiod;
    if (vibAmp > 0) {
      vibPhase += vibSpeed;
      rfperiod = fperiod * (1 + Math.sin(vibPhase) * vibAmp);
    }
    period = Math.max(8, Math.trunc(rfperiod));
    squareDuty = Math.min(0.5, Math.max(0, squareDuty + squareSlide));
    envTime++;
    if (envTime > envLength[envStage]!) {
      envTime = 0;
      envStage++;
      if (envStage === 3) break;
    }
    const len = envLength[envStage]! || 1;
    envVol = envStage === 0 ? envTime / len : envStage === 1 ? 1 + (1 - envTime / len) * 2 * p.punch! : 1 - envTime / len;
    if (i % 64 === 0) envAt.push([i / PREVIEW_RATE, envVol / (1 + 2 * p.punch!)]);
    fphase += fdphase;
    iphase = Math.min(1023, Math.abs(Math.trunc(fphase)));
    if (flthpD !== 0) flthp = Math.min(0.1, Math.max(0.00001, flthp * flthpD));
    let ssample = 0;
    for (let si = 0; si < 8; si++) {
      phase++;
      if (phase >= period) {
        phase %= period;
        if (waveType === 3) for (let k = 0; k < 32; k++) noise[k] = draw() * 2 - 1;
      }
      const fp = phase / period;
      let sample = waveType === 0 ? (fp < squareDuty ? 0.5 : -0.5) : waveType === 1 ? 1 - fp * 2 : waveType === 2 ? Math.sin(fp * TAU) : waveType === 3 ? noise[Math.trunc((phase * 32) / period)]! : 1 - 4 * Math.abs(fp - 0.5);
      const pp = fltp;
      fltw = Math.min(0.1, Math.max(0, fltw * fltwD));
      if (p.lowpassCutoff !== 1) {
        fltdp += (sample - fltp) * fltw;
        fltdp -= fltdp * fltdmp;
      } else {
        fltp = sample;
        fltdp = 0;
      }
      fltp += fltdp;
      fltphp += fltp - pp;
      fltphp -= fltphp * flthp;
      sample = fltphp;
      phaser[ipp & 1023] = sample;
      sample += phaser[(ipp - iphase + 1024) & 1023]!;
      ipp = (ipp + 1) & 1023;
      ssample += sample * envVol;
    }
    out[i] = Math.max(-1, Math.min(1, (ssample / 8) * 2 * gain));
  }
  envAt.push([seconds, envStage >= 3 ? 0 : envVol / (1 + 2 * p.punch!)]);
  return { rate: PREVIEW_RATE, samples: out, seconds, keyOff: null, endless: false, envelope: envAt };
}

function renderSilence(p: Record<string, number>, maxSeconds: number): GeneratorPreview {
  const seconds = Math.min(maxSeconds, Math.max(p.length!, 1 / PREVIEW_RATE));
  return { rate: PREVIEW_RATE, samples: new Float32Array(Math.max(1, Math.round(seconds * PREVIEW_RATE))), seconds, keyOff: null, endless: false, envelope: [[0, 0], [seconds, 0]] };
}

/** The preview of `body`: its first `maxSeconds` (2 s), or to its end. */
export function renderGeneratorPreview(body: GeneratorBody, maxSeconds = PREVIEW_SECONDS): GeneratorPreview {
  const { p, seed } = resolvedParams(body);
  switch (body.kind) {
    case "oscillator": return renderOscillator(p, seed, maxSeconds);
    case "synth": return renderSynth(p, seed, maxSeconds);
    case "blip": return renderBlip(p, seed, maxSeconds);
    case "silence": return renderSilence(p, maxSeconds);
  }
}

/** True when `body` sounds until released (the preview then shows only its start). */
export const previewIsEndless = (body: GeneratorBody): boolean => generatorIsEndless(body.kind, body.params);

/** Frames a peak bin covers. */
export const PREVIEW_BIN_FRAMES = 32;

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
    data[b * 2] = Math.round(lo * 32767);
    data[b * 2 + 1] = Math.round(hi * 32767);
  }
  return { binFrames, bins, data };
}

/** The kit waveform's peaks from a base level (`previewBase`). */
export function peaksFromBase(base: { binFrames: number; bins: number; data: Int16Array }, frames: number, rate = PREVIEW_RATE): PeakMips {
  return { rate, channels: 1, frames, levels: buildMips({ ...base, channels: 1 }) };
}
