/**
 * Main-side loudness statistics (ADR 0171 amended by 0172; API section 3.2, ARCH section 4.4).
 *
 * A TypeScript port of spike S1's main half (`spikes/audio-mix/loudness/src/loud.rs`: `Feed`, `Gating`; formulas as
 * libebur128 and EBU Tech 3341/3342). Sub-block energies go in (the audio core's K-weighted L + R mean square per
 * round(0.1 x rate) frames); momentary, short-term, gated integrated, loudness range and the maxima come out. One
 * instance per metered bus. The runtime hub (Ld4) and the capture Worker (Pf6) share this module, so it imports
 * nothing: no DOM, no plugin runtime, no engine.
 *
 * Definitions (all relative to the sub-block sequence since the last discontinuity, see below):
 * - momentary: mean of the last 4 sub-blocks (400 ms), `-Infinity` until 4 have arrived;
 * - short-term: mean of the last 30 (3 s), `-Infinity` until 30;
 * - integrated: 400 ms blocks (one per sub-block, 75 % overlap), absolute gate -70 LUFS, relative gate -10 LU
 *   below the mean of the blocks that passed it; `-Infinity` until a block passes;
 * - LRA: 3 s blocks at a 1 s hop (the first after 3 s), absolute gate -70 LUFS, relative gate -20 LU, 10th to
 *   95th percentile of the blocks' loudness (rank `round((n - 1) p)`, as libebur128); `-Infinity` until two
 *   blocks pass both gates.
 *
 * Exact gating (G7d). Integrated and LRA are the exact list-based gating of S1's `Gating` and the `ebur128` crate
 * (Ld6's cross-check, 1e-3 LU at every point), not the 0.1 LU bins the design first prescribed (api-and-models
 * §3.2, ARCH §4.4: "two 1,000-bin histograms, 24 kB, within 0.11 LU"): a bin admitted every block of the bin that
 * held a relative gate, which moved LRA's 10th percentile by LUs on short programmes. Each gate's blocks are kept
 * in a {@link GatedBlocks}: the energies of the blocks that passed the absolute gate, in preallocated storage,
 * chained per 0.1 LU bin, with per-bin counts and energy sums. Binning is monotonic (`floor` of rounded, monotonic
 * arithmetic), so every block in a bin above the relative gate's bin passes, every block in a bin below fails,
 * and only the gate's own bin is compared block by block (`lufs >= gate`). Integrated keeps the sum above the
 * gate's bin incrementally and walks one bin per sub-block; LRA's percentiles are a selection (quickselect)
 * inside the bin that holds the rank, once per 3 s block (1 Hz).
 *
 * Bound. The storage holds {@link EXACT_GATING_SECONDS} (one hour) of gated programme: 36,000 400 ms blocks and
 * 3,600 3 s blocks, about 560 kB per instance (`byteLength`). Past it a block still counts in its bin's count and
 * energy sum (I's sum and LRA's ranks stay exact away from the gate) but is not listed: in the gate's bin it is
 * admitted by the bin, and a percentile landing on it reads its bin's mean (the old histogram rule, within 0.1 LU,
 * only for those blocks). `reset("integrated")` and `reset("all")` empty the storage.
 *
 * Discontinuities. A 400 ms or 3 s block never straddles lost, shed or rebuilt audio: after a lost span
 * ({@link LoudnessStats.take} / {@link LoudnessStats.takeBlock} seeing a sequence jump), an {@link
 * LoudnessStats.epoch} (rebuild), or a resume from {@link LoudnessStats.pause}, the sliding window and the block
 * counters restart (momentary reads `-Infinity` for 0.4 s, short-term for 3 s) while the gated blocks, the maxima
 * and the flags stay, and `incomplete` is set. `incomplete` and `tainted` stay set until `reset("all")` or
 * `reset("integrated")`.
 *
 * Zero allocation: every buffer is created in the constructor; no method allocates (no arrays, closures, views or
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
/** Gating bins: 0.1 LU wide from the absolute gate (the last bin takes everything above -70 + 100 LU). */
export const HIST_BINS = 1000;
export const ABSOLUTE_GATE_LUFS = -70;
export const INTEGRATED_RELATIVE_GATE_LU = -10;
export const LRA_RELATIVE_GATE_LU = -20;
/** Gated programme the exact storage holds by default: an hour (36,000 integrated blocks, 3,600 LRA blocks). */
export const EXACT_GATING_SECONDS = 3600;

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

/** The 0.1 LU bin of a loudness, clamped to the bins. Monotonic in `l` (rounded `+`, `*` and `floor` are). */
function binOf(l: number): number {
  return Math.min(Math.max(Math.floor((l - ABSOLUTE_GATE_LUFS) * 10), 0), HIST_BINS - 1);
}

/**
 * The `k`-th smallest (0-based) of `a[0 .. n)`, in place (Wirth's selection: Hoare partitions around `a[k]`, linear
 * on average, and linear on equal values, which a steady tone gives).
 */
function selectKth(a: Float64Array, n: number, k: number): number {
  let l = 0;
  let r = n - 1;
  while (l < r) {
    const x = a[k];
    let i = l;
    let j = r;
    do {
      while (a[i] < x) i++;
      while (x < a[j]) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    } while (i <= j);
    if (j < k) l = i;
    if (k < i) r = j;
  }
  return a[k];
}

/**
 * The blocks that passed one gate's absolute gate (see the file comment): listed energies chained per bin, per-bin
 * counts and energy sums of every block, and the unlisted (past-capacity) part per bin. Fixed memory. Not exported:
 * `LoudnessStats` owns two.
 */
class GatedBlocks {
  /** Listed blocks' mean-square energies, in arrival order. */
  readonly energy: Float64Array;
  /** Per listed block, the previous listed block of its bin (-1 ends the chain). */
  readonly next: Int32Array;
  /** Per bin, the newest listed block (-1: none). */
  readonly head = new Int32Array(HIST_BINS);
  /** Per bin, every block's count and energy sum. */
  readonly cnt = new Uint32Array(HIST_BINS);
  readonly esum = new Float64Array(HIST_BINS);
  /** Per bin, the unlisted blocks' count and energy sum (past capacity). */
  readonly overCnt = new Uint32Array(HIST_BINS);
  readonly overSum = new Float64Array(HIST_BINS);
  /** LRA's selection buffer (one bin's loudness values); empty for integrated. */
  readonly scratch: Float64Array;
  listed = 0;
  /** Blocks above the absolute gate and their energy, summed in arrival order (the relative gate's mean). */
  total = 0;
  totalEnergy = 0;
  /** The relative gate's bin, and the count and energy of every block in the bins above it (kept incrementally). */
  gateBin = -1;
  upCount = 0;
  upEnergy = 0;
  /** The gate's own bin after {@link gate}: its blocks at or above the gate. */
  passCount = 0;
  passEnergy = 0;

  constructor(readonly capacity: number, scratchLength: number) {
    this.energy = new Float64Array(capacity);
    this.next = new Int32Array(capacity);
    this.scratch = new Float64Array(scratchLength);
    this.head.fill(-1);
  }

  clear(): void {
    this.head.fill(-1);
    this.cnt.fill(0);
    this.esum.fill(0);
    this.overCnt.fill(0);
    this.overSum.fill(0);
    this.listed = 0;
    this.total = 0;
    this.totalEnergy = 0;
    this.gateBin = -1;
    this.upCount = 0;
    this.upEnergy = 0;
    this.passCount = 0;
    this.passEnergy = 0;
  }

  get byteLength(): number {
    return (
      this.energy.byteLength + this.next.byteLength + this.head.byteLength + this.cnt.byteLength + this.esum.byteLength +
      this.overCnt.byteLength + this.overSum.byteLength + this.scratch.byteLength
    );
  }

  /** Adds one block's mean-square energy; returns false (and keeps nothing) when it is under the absolute gate. */
  add(e: number): boolean {
    const l = energyToLufs(e);
    if (!(l >= ABSOLUTE_GATE_LUFS)) return false;
    const b = binOf(l);
    this.cnt[b]++;
    this.esum[b] += e;
    this.total++;
    this.totalEnergy += e;
    if (this.listed < this.capacity) {
      const i = this.listed++;
      this.energy[i] = e;
      this.next[i] = this.head[b];
      this.head[b] = i;
    } else {
      this.overCnt[b]++;
      this.overSum[b] += e;
    }
    if (this.gateBin >= 0 && b > this.gateBin) {
      this.upCount++;
      this.upEnergy += e;
    }
    return true;
  }

  /**
   * Places the relative gate `relLu` below the mean of the blocks (needs `total > 0`): the totals above its bin
   * (rebuilt only when the bin changes, it moves slowly) and the exact pass count and energy of its own bin. Returns
   * the gate in LUFS.
   */
  gate(relLu: number): number {
    const t = energyToLufs(this.totalEnergy / this.total) + relLu;
    const g = binOf(t);
    if (g !== this.gateBin) {
      let c = 0;
      let s = 0;
      for (let i = g + 1; i < HIST_BINS; i++) {
        c += this.cnt[i];
        s += this.esum[i];
      }
      this.gateBin = g;
      this.upCount = c;
      this.upEnergy = s;
    }
    let c = 0;
    let s = 0;
    for (let i = this.head[g]; i >= 0; i = this.next[i]) {
      const e = this.energy[i];
      if (energyToLufs(e) >= t) {
        c++;
        s += e;
      }
    }
    // unlisted blocks in the gate's bin: admitted by the bin (the histogram rule, past capacity only)
    this.passCount = c + this.overCnt[g];
    this.passEnergy = s + this.overSum[g];
    return t;
  }

  /** Integrated loudness (or `-Infinity` when no block has passed): the mean energy of the blocks at or above the relative gate. */
  integrated(): number {
    if (this.total === 0) return Number.NEGATIVE_INFINITY;
    this.gate(INTEGRATED_RELATIVE_GATE_LU);
    const c = this.upCount + this.passCount;
    return c > 0 ? energyToLufs((this.upEnergy + this.passEnergy) / c) : Number.NEGATIVE_INFINITY;
  }

  /** Loudness range in LU, or `-Infinity` until two blocks pass both gates (the crate returns 0 there). */
  lra(): number {
    if (this.total === 0) return Number.NEGATIVE_INFINITY;
    const t = this.gate(LRA_RELATIVE_GATE_LU);
    const n = this.upCount + this.passCount;
    if (n < 2) return Number.NEGATIVE_INFINITY;
    return this.pick(t, Math.floor((n - 1) * 0.95 + 0.5)) - this.pick(t, Math.floor((n - 1) * 0.1 + 0.5));
  }

  /** The loudness of the passing block at 0-based ascending rank `r` (after {@link gate} placed gate `t`). */
  private pick(t: number, r: number): number {
    const g = this.gateBin;
    if (r < this.passCount) return this.pickInBin(g, t, r);
    r -= this.passCount;
    for (let b = g + 1; b < HIST_BINS; b++) {
      if (r < this.cnt[b]) return this.pickInBin(b, Number.NEGATIVE_INFINITY, r);
      r -= this.cnt[b];
    }
    return Number.NEGATIVE_INFINITY; // unreachable: r < the passing count
  }

  /** Rank `r` among bin `b`'s blocks at or above `t`: the listed ones exactly, the unlisted ones as the bin's unlisted mean. */
  private pickInBin(b: number, t: number, r: number): number {
    const a = this.scratch;
    let m = 0;
    for (let i = this.head[b]; i >= 0; i = this.next[i]) {
      const l = energyToLufs(this.energy[i]);
      if (l >= t) a[m++] = l;
    }
    const oc = this.overCnt[b];
    if (oc === 0) return selectKth(a, m, r);
    const om = energyToLufs(this.overSum[b] / oc);
    let below = 0;
    for (let i = 0; i < m; i++) if (a[i] < om) below++;
    if (r < below) return selectKth(a, m, r);
    if (r < below + oc) return om;
    return selectKth(a, m, r - oc);
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
  private readonly blocksI: GatedBlocks;
  private readonly blocksL: GatedBlocks;

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

  /**
   * `exactSeconds`: gated programme the exact storage holds (default an hour; see the file comment for what happens
   * past it). Integrated keeps `10 x exactSeconds` blocks, LRA `exactSeconds`.
   */
  constructor(exactSeconds: number = EXACT_GATING_SECONDS) {
    const lraBlocks = Math.max(1, Math.ceil(exactSeconds));
    this.blocksI = new GatedBlocks(lraBlocks * 10, 0);
    this.blocksL = new GatedBlocks(lraBlocks, lraBlocks);
  }

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
    return this.win.byteLength + this.blocksI.byteLength + this.blocksL.byteLength;
  }

  /** Every typed array the instance owns, for a test that pins identity and length across a long feed. Allocates the returned array. */
  buffers(): ArrayBufferView[] {
    const out: ArrayBufferView[] = [this.win];
    for (const g of [this.blocksI, this.blocksL]) out.push(g.energy, g.next, g.head, g.cnt, g.esum, g.overCnt, g.overSum, g.scratch);
    return out;
  }

  /** 400 ms blocks held in the exact storage (at most `10 x exactSeconds`); for a test of the bound. */
  get listedIntegratedBlocks(): number {
    return this.blocksI.listed;
  }
  /** 3 s blocks held in the exact storage (at most `exactSeconds`). */
  get listedLraBlocks(): number {
    return this.blocksL.listed;
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
    // Gating blocks: one 400 ms block per sub-block; one 3 s block per 10 once 30 have arrived. A block under the
    // absolute gate changes neither set, so neither reading.
    if (this.sinceGap >= MOMENTARY_SUBS) {
      if (this.blocksI.add(blockM)) this.iLufs = this.blocksI.integrated();
    }
    if (this.sinceGap >= SHORT_TERM_SUBS && (this.sinceGap - SHORT_TERM_SUBS) % LRA_HOP_SUBS === 0) {
      if (this.blocksL.add(blockS)) this.lraLu = this.blocksL.lra();
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

  /** The window and the block counters restart; gated blocks, maxima and flags stay. */
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
   * `"integrated"`: the gated blocks, I, LRA, elapsed and both flags (M, S and the window continue).
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
      this.blocksI.clear();
      this.blocksL.clear();
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

/**
 * How a meter is fed, shared by the live hub (`loudnessHub.ts`) and the profiler's model (`loudnessTrackModel.ts`) so a
 * reopened capture reads the live meter's values bit for bit: the pause bookkeeping (a script's pause, the ladder's)
 * and the first-take rule. Allocates nothing.
 */
export class LoudnessFeedControl {
  scriptPaused = false;
  ladderPaused = false;
  /** A ladder span happened since the last resume, so the resume marks `incomplete`. */
  ladderTouched = false;
  /** A take has reached this meter: the core's first take of a new meter carries `reset` and is no gap. */
  fed = false;

  constructor(readonly stats: LoudnessStats) {}

  /** Brings the stats' pause state in line with the script's and the ladder's. A ladder span marks `incomplete` on resume; a script's own does not. */
  syncPause(): void {
    const want = this.scriptPaused || this.ladderPaused;
    if (want && !this.stats.paused) this.stats.pause();
    else if (!want && this.stats.paused) {
      this.stats.resume(this.ladderTouched);
      this.ladderTouched = false;
    }
  }

  /** A script's (or the panel's) pause or resume. */
  setScriptPaused(on: boolean): void {
    this.scriptPaused = on;
    this.syncPause();
  }

  /** The ladder's loudness step (`loudShed !== 0`) changed: it pauses every meter but the final output's (master keeps metering, ARCH §4.8). */
  setLadder(on: boolean, isOutput: boolean): void {
    if (isOutput) return;
    this.ladderPaused = on;
    if (on) this.ladderTouched = true;
    this.syncPause();
  }

  /**
   * Before a take's sub-blocks: a core-side reset (a rebuild's fresh sequence) restarts the feed like an EPOCH
   * (gated blocks and maxima stay), except on the meter's first take, whose sequence starts at 0 as a fresh feed
   * expects. Returns whether it restarted the feed (a gap).
   */
  beginTake(reset: boolean): boolean {
    const restart = reset && this.fed;
    if (restart) this.stats.epoch();
    this.fed = true;
    return restart;
  }
}
