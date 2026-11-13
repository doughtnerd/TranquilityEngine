/**
 * Main-side loudness statistics (ADR 0171 amended by 0172; API section 3.2, ARCH section 4.4).
 *
 * A TypeScript port of spike S1's main half (`spikes/audio-mix/loudness/src/loud.rs`: `Feed`, `Gating`, `Hist`;
 * formulas as libebur128 and EBU Tech 3341/3342). Sub-block energies go in (the audio core's K-weighted L + R mean
 * square per round(0.1 x rate) frames); momentary, short-term, gated integrated, loudness range and the maxima
 * come out. One instance per metered bus. The runtime hub (Ld4) and the capture Worker (Pf6) share this module,
 * so it imports nothing: no DOM, no plugin runtime, no engine.
 *
 * Definitions (all relative to the sub-block sequence since the last discontinuity, see below):
 * - momentary: mean of the last 4 sub-blocks (400 ms), `-Infinity` until 4 have arrived;
 * - short-term: mean of the last 30 (3 s), `-Infinity` until 30;
 * - integrated: 400 ms blocks (one per sub-block, 75 % overlap), absolute gate -70 LUFS, relative gate -10 LU
 *   below the mean of the blocks that passed it; `-Infinity` until a block passes;
 * - LRA: 3 s blocks at a 1 s hop (the first after 3 s), absolute gate -70 LUFS, relative gate -20 LU, 10th to
 *   95th percentile of the blocks' loudness; `-Infinity` until two blocks pass both gates.
 * Integrated and LRA come from two 1,000-bin histograms (0.1 LU from -70 LUFS; per bin a count and an exact
 * energy sum), within 0.11 LU of the exact list-based gating the spike checks against.
 *
 * Discontinuities. A 400 ms or 3 s block never straddles lost, shed or rebuilt audio: after a lost span
 * ({@link LoudnessStats.take} / {@link LoudnessStats.takeBlock} seeing a sequence jump), an {@link
 * LoudnessStats.epoch} (rebuild), or a resume from {@link LoudnessStats.pause}, the sliding window and the block
 * counters restart (momentary reads `-Infinity` for 0.4 s, short-term for 3 s) while the histograms, the maxima
 * and the flags stay, and `incomplete` is set. `incomplete` and `tainted` stay set until `reset("all")` or
 * `reset("integrated")`.
 *
 * Zero allocation: every buffer is created in the constructor; no method allocates (no arrays, closures or
 * objects on any path), and the instance's shape never changes. {@link LoudnessStats.byteLength} and
 * {@link LoudnessStats.buffers} let a test pin that.
 */

/** Seconds of audio per sub-block (the core uses round(0.1 x rate) frames). */
export const SUB_BLOCK_SECONDS = 0.1;
/** Momentary window, in sub-blocks (400 ms). */
export const MOMENTARY_SUBS = 4;
/** Short-term window and LRA block, in sub-blocks (3 s). */
export const SHORT_TERM_SUBS = 30;
/** LRA hop, in sub-blocks (1 s). */
export const LRA_HOP_SUBS = 10;
/** Histogram bins: 0.1 LU wide from the absolute gate. */
export const HIST_BINS = 1000;
export const ABSOLUTE_GATE_LUFS = -70;
export const INTEGRATED_RELATIVE_GATE_LU = -10;
export const LRA_RELATIVE_GATE_LU = -20;

/** Which statistics a reset clears (the API's `LoudnessResetWhat`, structurally). */
export type LoudnessStatsResetWhat = "integrated" | "maxPeak" | "all";

/** `-0.691 + 10 log10(meanSquare)`; `-Infinity` for zero (and for anything not a positive finite number). */
export function energyToLufs(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY;
}

/** Linear amplitude to dB; `-Infinity` for zero. */
export function linearToDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY;
}

/**
 * A 1,000-bin gating histogram (the spike's `Hist`): per bin a count and the exact sum of the energies that fell
 * in it. Fixed memory, 12 B per bin. Not exported: `LoudnessStats` owns two.
 */
class GateHistogram {
  readonly cnt = new Uint32Array(HIST_BINS);
  readonly esum = new Float64Array(HIST_BINS);
  /** Blocks and energy above the absolute gate (running totals). */
  total = 0;
  totalEnergy = 0;
  /** Relative-gate bin and the counts and energy from it up (kept incrementally for the integrated reading). */
  gateBin = -1;
  gateCount = 0;
  gateEnergy = 0;

  clear(): void {
    this.cnt.fill(0);
    this.esum.fill(0);
    this.total = 0;
    this.totalEnergy = 0;
    this.gateBin = -1;
    this.gateCount = 0;
    this.gateEnergy = 0;
  }

  /** Adds one block's mean-square energy; returns its bin, or -1 when it is under the absolute gate. */
  add(e: number): number {
    const l = energyToLufs(e);
    if (!(l >= ABSOLUTE_GATE_LUFS)) return -1;
    const i = Math.min(Math.floor((l - ABSOLUTE_GATE_LUFS) * 10), HIST_BINS - 1);
    this.cnt[i]++;
    this.esum[i] += e;
    this.total++;
    this.totalEnergy += e;
    return i;
  }

  static binOf(l: number): number {
    return Math.min(Math.max(Math.floor((l - ABSOLUTE_GATE_LUFS) * 10), 0), HIST_BINS - 1);
  }

  /**
   * Integrated loudness after an `add` (or `-Infinity` when empty): the mean energy of the bins at or above the
   * relative gate. The gate bin moves slowly, so the suffix totals are updated in O(1) and rebuilt (the spike's
   * ascending fold) only when the gate bin changes.
   */
  integratedAfterAdd(bin: number, e: number): number {
    if (bin >= this.gateBin && this.gateBin >= 0) {
      this.gateCount++;
      this.gateEnergy += e;
    }
    const g = GateHistogram.binOf(energyToLufs(this.totalEnergy / this.total) + INTEGRATED_RELATIVE_GATE_LU);
    if (g !== this.gateBin) {
      let c = 0;
      let s = 0;
      for (let i = g; i < HIST_BINS; i++) {
        c += this.cnt[i];
        s += this.esum[i];
      }
      this.gateBin = g;
      this.gateCount = c;
      this.gateEnergy = s;
    }
    return this.gateCount > 0 ? energyToLufs(this.gateEnergy / this.gateCount) : Number.NEGATIVE_INFINITY;
  }

  /** Loudness range in LU, or `-Infinity` until two blocks pass both gates (the spike returns 0 there). */
  lra(): number {
    if (this.total === 0) return Number.NEGATIVE_INFINITY;
    const from = GateHistogram.binOf(energyToLufs(this.totalEnergy / this.total) + LRA_RELATIVE_GATE_LU);
    let total = 0;
    for (let i = from; i < HIST_BINS; i++) total += this.cnt[i];
    if (total < 2) return Number.NEGATIVE_INFINITY;
    return this.pick(from, total, 0.95) - this.pick(from, total, 0.1);
  }

  private pick(from: number, total: number, p: number): number {
    const target = Math.floor((total - 1) * p + 0.5); // 0-based rank
    let seen = 0;
    for (let i = from; i < HIST_BINS; i++) {
      seen += this.cnt[i];
      if (seen > target) return energyToLufs(this.esum[i] / this.cnt[i]);
    }
    return Number.NEGATIVE_INFINITY;
  }
}

/** Statistics of one metered bus. See the file comment. */
export class LoudnessStats {
  // Sliding window of the last 30 sub-block energies (chronological order is head - fill ... head - 1, mod 30).
  private readonly win = new Float64Array(SHORT_TERM_SUBS);
  private head = 0;
  private fill = 0;
  /** Sub-blocks since the window or the integrated statistics last restarted (reset, gap, resume): the I and LRA block counter. */
  private sinceGap = 0;
  private readonly histI = new GateHistogram();
  private readonly histL = new GateHistogram();

  private mLufs = Number.NEGATIVE_INFINITY;
  private sLufs = Number.NEGATIVE_INFINITY;
  private iLufs = Number.NEGATIVE_INFINITY;
  private lraLu = Number.NEGATIVE_INFINITY;
  private maxM = Number.NEGATIVE_INFINITY;
  private maxS = Number.NEGATIVE_INFINITY;
  private maxPeak = 0;
  private subs = 0;

  // Feed state (the spike's `Feed`): the sequence number after the last sub-block taken, and the lost count.
  private last = 0;
  private lostTotal = 0;
  private gaps = 0;
  private flagIncomplete = false;
  private flagTainted = false;
  private isPaused = false;

  /** Momentary loudness, LUFS: the last 400 ms; `-Infinity` until 4 sub-blocks since the last restart. */
  get momentary(): number {
    return this.mLufs;
  }
  /** Short-term loudness, LUFS: the last 3 s; `-Infinity` until 30 sub-blocks since the last restart. */
  get shortTerm(): number {
    return this.sLufs;
  }
  /** Gated integrated loudness, LUFS, since the last reset; `-Infinity` until a block passes the -70 LUFS gate. */
  get integrated(): number {
    return this.iLufs;
  }
  /** Loudness range, LU; `-Infinity` until two 3 s blocks pass the gates. */
  get lra(): number {
    return this.lraLu;
  }
  /** Highest momentary loudness since the last `reset("all")` or `reset("maxPeak")`. */
  get maxMomentary(): number {
    return this.maxM;
  }
  /** Highest short-term loudness since the last `reset("all")` or `reset("maxPeak")`. */
  get maxShortTerm(): number {
    return this.maxS;
  }
  /** Highest peak fed to {@link notePeak}, linear. */
  get maxPeakLinear(): number {
    return this.maxPeak;
  }
  /** The same in dB (`-Infinity` for none). */
  get maxTruePeak(): number {
    return linearToDb(this.maxPeak);
  }
  /** Seconds of metered audio since the last `reset("all")` or `reset("integrated")`; paused, lost and gap time excluded. */
  get elapsed(): number {
    return this.subs * SUB_BLOCK_SECONDS;
  }
  /** Sub-blocks lost to a stall (cumulative, never reset: it is a diagnostic of the link, not of the meter). */
  get lost(): number {
    return this.lostTotal;
  }
  /** Discontinuities seen (lost spans, epochs, resumes) since construction. */
  get gapCount(): number {
    return this.gaps;
  }
  /** Sub-blocks lost, a shed or paused span, or a rebuild gap since the last reset. */
  get incomplete(): boolean {
    return this.flagIncomplete;
  }
  /** A monitor control or Compare affected this meter since the last reset. */
  get tainted(): boolean {
    return this.flagTainted;
  }
  get paused(): boolean {
    return this.isPaused;
  }

  /** Bytes of preallocated storage (constant for the life of the instance). */
  get byteLength(): number {
    return this.win.byteLength + this.histI.cnt.byteLength + this.histI.esum.byteLength + this.histL.cnt.byteLength + this.histL.esum.byteLength;
  }

  /** Every typed array the instance owns, for a test that pins identity and length across a long feed. Allocates the returned array. */
  buffers(): ArrayBufferView[] {
    return [this.win, this.histI.cnt, this.histI.esum, this.histL.cnt, this.histL.esum];
  }

  /**
   * One sub-block's mean-square energy (K-weighted L + R). A negative or non-finite value counts as silence (the
   * core already keeps NaN out of the filters). While paused the energy is discarded.
   */
  push(energy: number): void {
    if (this.isPaused) return;
    const e = energy >= 0 && energy < Number.POSITIVE_INFINITY ? energy : 0;
    this.win[this.head] = e;
    this.head = this.head === SHORT_TERM_SUBS - 1 ? 0 : this.head + 1;
    if (this.fill < SHORT_TERM_SUBS) this.fill++;
    this.sinceGap++;
    this.subs++;

    let blockM = 0;
    if (this.fill >= MOMENTARY_SUBS) {
      blockM = this.windowMean(MOMENTARY_SUBS);
      this.mLufs = energyToLufs(blockM);
      if (this.mLufs > this.maxM) this.maxM = this.mLufs;
    }
    let blockS = 0;
    if (this.fill >= SHORT_TERM_SUBS) {
      blockS = this.windowMean(SHORT_TERM_SUBS);
      this.sLufs = energyToLufs(blockS);
      if (this.sLufs > this.maxS) this.maxS = this.sLufs;
    }
    // Gating blocks: one 400 ms block per sub-block; one 3 s block per 10 once 30 have arrived.
    if (this.sinceGap >= MOMENTARY_SUBS) {
      const bin = this.histI.add(blockM);
      if (bin >= 0) this.iLufs = this.histI.integratedAfterAdd(bin, blockM);
    }
    if (this.sinceGap >= SHORT_TERM_SUBS && (this.sinceGap - SHORT_TERM_SUBS) % LRA_HOP_SUBS === 0) {
      if (this.histL.add(blockS) >= 0) this.lraLu = this.histL.lra();
    }
  }

  /** Mean of the last `n` window entries, summed oldest first (the spike's `iter().sum() / n`). */
  private windowMean(n: number): number {
    let s = 0;
    let idx = this.head - n;
    if (idx < 0) idx += SHORT_TERM_SUBS;
    for (let j = 0; j < n; j++) {
      s += this.win[idx];
      idx = idx === SHORT_TERM_SUBS - 1 ? 0 : idx + 1;
    }
    return s / n;
  }

  /**
   * The spike's `Feed::take`: `seq` is the core's count of completed sub-blocks and `ring` holds sub-block `e` at
   * `ring[e % ringLen]` (u32 arithmetic, as the core's). Pushes the sub-blocks completed since the previous take,
   * oldest first; more than `ringLen` since then means the oldest were overwritten: they are counted in
   * {@link lost}, `incomplete` is set and the window restarts. Returns how many sub-blocks were pushed.
   */
  take(seq: number, ring: ArrayLike<number>, ringLen: number = ring.length): number {
    let fresh = (seq - this.last) >>> 0;
    if (fresh > ringLen) {
      this.markLost(fresh - ringLen);
      fresh = ringLen;
    }
    for (let j = 0; j < fresh; j++) {
      const e = (seq - fresh + j) >>> 0;
      this.push(ring[e % ringLen]);
    }
    this.last = seq >>> 0;
    return fresh;
  }

  /**
   * The same for a STATUS that carries the sub-blocks since the last successful take: `count` energies from
   * `energies[offset]` that are sub-blocks `firstSeq .. firstSeq + count - 1`. A `firstSeq` ahead of the
   * expected one means the core's ring overwrote the gap: those are counted as lost.
   */
  takeBlock(firstSeq: number, energies: ArrayLike<number>, offset: number, count: number): number {
    const skipped = (firstSeq - this.last) >>> 0;
    if (skipped !== 0) this.markLost(skipped);
    for (let j = 0; j < count; j++) this.push(energies[offset + j]);
    this.last = (firstSeq + count) >>> 0;
    return count;
  }

  private markLost(n: number): void {
    if (!this.isPaused) {
      this.lostTotal += n;
      this.flagIncomplete = true;
      this.restartBlocks();
    }
    this.gaps++;
  }

  /** The window and the block counters restart; histograms, maxima and flags stay. */
  private restartBlocks(): void {
    this.head = 0;
    this.fill = 0;
    this.sinceGap = 0;
    this.mLufs = Number.NEGATIVE_INFINITY;
    this.sLufs = Number.NEGATIVE_INFINITY;
  }

  /**
   * An EPOCH (a rebuild): the core's sequence restarts at 0. Keeps integrated, LRA and the maxima, reseeds the
   * feed, marks the gap (`incomplete`) and restarts the window and blocks. Sub-block energies are rate
   * independent, so a rate change needs nothing more.
   */
  epoch(): void {
    this.last = 0;
    this.flagIncomplete = true;
    this.gaps++;
    this.restartBlocks();
  }

  /** Stops metering: pushed energies are discarded, a sequence jump while paused is not a loss. */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resumes metering. The window and blocks restart, and `incomplete` is set (`markIncomplete`, default true: a
   * ladder shed span; a script's own pause may pass false).
   */
  resume(markIncomplete = true): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.gaps++;
    if (markIncomplete) this.flagIncomplete = true;
    this.restartBlocks();
  }

  /** A monitor control or Compare affected this meter. Stays set until `reset("all")` or `reset("integrated")`. */
  taint(): void {
    this.flagTainted = true;
  }

  /** Folds one STATUS's true-peak maximum (linear, already max'd with the sample peak by the core) into the maximum. */
  notePeak(linear: number): void {
    if (linear > this.maxPeak && linear < Number.POSITIVE_INFINITY) this.maxPeak = linear;
  }

  /**
   * `"integrated"`: the histograms, I, LRA, elapsed and both flags (M, S and the window continue).
   * `"maxPeak"`: the maxima (peak, momentary, short-term). `"all"`: both, and the window. The feed's sequence
   * position, {@link lost} and the pause state stay: the core keeps counting.
   */
  reset(what: LoudnessStatsResetWhat = "all"): void {
    if (what === "maxPeak" || what === "all") {
      this.maxPeak = 0;
      this.maxM = Number.NEGATIVE_INFINITY;
      this.maxS = Number.NEGATIVE_INFINITY;
    }
    if (what === "integrated" || what === "all") {
      this.histI.clear();
      this.histL.clear();
      this.iLufs = Number.NEGATIVE_INFINITY;
      this.lraLu = Number.NEGATIVE_INFINITY;
      this.subs = 0;
      this.sinceGap = 0;
      this.flagIncomplete = false;
      this.flagTainted = false;
    }
    if (what === "all") this.restartBlocks();
  }
}
