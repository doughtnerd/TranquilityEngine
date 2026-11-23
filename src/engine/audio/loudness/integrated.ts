/**
 * Offline loudness of a whole clip (ADR 0342 "normalize"): ITU-R BS.1770-4 / EBU R 128 gated integrated loudness and
 * sample peak, measured from decoded PCM. The Studio's Normalize computes `gainDb = target − measured` from these.
 *
 * - K-weighting: the two biquads of BS.1770 (a high shelf then a high-pass), with coefficients derived for the clip's
 *   sample rate the way libebur128 does, so 44.1 kHz and 96 kHz files measure like 48 kHz ones.
 * - Blocks of 400 ms with 75 % overlap (a 100 ms hop); a block's loudness is `−0.691 + 10·log10(Σ wᵢ·msᵢ)`.
 * - Gates: absolute −70 LUFS, then relative −10 LU below the mean energy of the blocks that passed the absolute gate.
 * - Channel weights: 1 for L, R and C; 1.41 for the surrounds; the LFE (the fourth of six channels) is left out.
 * - A clip shorter than one block (a 0.2 s one-shot) is measured as a single block over its whole length, so short
 *   effects still get a value (libebur128 would say −∞); the absolute gate still applies.
 * - Peak is the sample peak in dBFS (not true peak), as the prototype's Normalize uses.
 *
 * Pure; no plugin, no DOM.
 */

/** Interleaved PCM: int16 (scaled by 1/32768) or float in −1..1. */
export interface PcmClip {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

export interface LoudnessMeasure {
  /** Gated integrated loudness, LUFS; −Infinity when nothing passes the absolute gate (silence). */
  readonly integrated: number;
  /** Sample peak, dBFS; −Infinity for digital silence. */
  readonly peak: number;
}

export const ABSOLUTE_GATE_LUFS = -70;
export const RELATIVE_GATE_LU = -10;
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;

/** One biquad's coefficients, a0 normalised to 1. */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/** BS.1770's K-weighting filter for `rate`: stage 1 the high shelf ("pre-filter"), stage 2 the RLB high-pass. */
export function kWeighting(rate: number): readonly [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

/** The BS.1770 weight of channel `index` of `channels` (0 leaves it out). */
export function channelWeight(index: number, channels: number): number {
  if (channels >= 6) {
    if (index === 3) return 0; // LFE of L R C LFE Ls Rs
    if (index === 4 || index === 5) return 1.41;
  } else if (channels === 5 && (index === 3 || index === 4)) return 1.41; // L R C Ls Rs
  return 1;
}

const toDb = (energy: number): number => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);

/**
 * The clip's integrated loudness and sample peak. Runs in one pass over the PCM plus one over the per-hop energies,
 * O(frames · channels); an hour of stereo at 48 kHz is ~350 M multiply-adds.
 */
export function measureLoudness(clip: PcmClip): LoudnessMeasure {
  const { pcm, channels, rate } = clip;
  if (channels <= 0 || rate <= 0) return { integrated: -Infinity, peak: -Infinity };
  const frames = Math.floor(pcm.length / channels);
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  const [s, h] = kWeighting(rate);
  const hop = Math.max(1, Math.round(HOP_SECONDS * rate));
  const hops = Math.ceil(frames / hop);
  // Per hop: the weighted sum over channels of the K-weighted squares.
  const hopEnergy = new Float64Array(hops);
  let peak = 0;
  for (let c = 0; c < channels; c++) {
    const w = channelWeight(c, channels);
    // Biquad state, direct form II transposed, per stage.
    let z1a = 0, z2a = 0, z1b = 0, z2b = 0;
    for (let f = 0; f < frames; f++) {
      const x = pcm[f * channels + c] * scale;
      const ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      if (w === 0) continue;
      const y1 = s.b0 * x + z1a;
      z1a = s.b1 * x - s.a1 * y1 + z2a;
      z2a = s.b2 * x - s.a2 * y1;
      const y2 = h.b0 * y1 + z1b;
      z1b = h.b1 * y1 - h.a1 * y2 + z2b;
      z2b = h.b2 * y1 - h.a2 * y2;
      hopEnergy[(f / hop) | 0] += w * y2 * y2;
    }
  }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

  const blockHops = Math.round(BLOCK_SECONDS / HOP_SECONDS);
  const energies: number[] = [];
  if (frames < blockHops * hop) {
    // Shorter than one block: the whole clip is the block.
    let sum = 0;
    for (let i = 0; i < hops; i++) sum += hopEnergy[i];
    if (frames > 0) energies.push(sum / frames);
  } else {
    // Only whole blocks: block k covers hops k .. k+3 and must end within the clip.
    const fullHops = Math.floor(frames / hop);
    for (let k = 0; k + blockHops <= fullHops; k++) {
      let sum = 0;
      for (let i = k; i < k + blockHops; i++) sum += hopEnergy[i];
      energies.push(sum / (blockHops * hop));
    }
  }
  return { integrated: gatedLoudness(energies), peak: peakDb };
}

/** BS.1770 gating over block mean-square energies (already channel-weighted): absolute, then relative. */
export function gatedLoudness(energies: readonly number[]): number {
  const absolute = energies.filter((e) => toDb(e) >= ABSOLUTE_GATE_LUFS);
  if (absolute.length === 0) return -Infinity;
  const mean = absolute.reduce((a, e) => a + e, 0) / absolute.length;
  const gate = toDb(mean) + RELATIVE_GATE_LU;
  const relative = absolute.filter((e) => toDb(e) >= gate);
  if (relative.length === 0) return -Infinity;
  return toDb(relative.reduce((a, e) => a + e, 0) / relative.length);
}
