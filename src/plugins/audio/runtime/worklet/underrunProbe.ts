// The worklet shell's underrun probe (architecture §4.7; F-37): counts the quanta that arrive later than the device's
// burst pattern explains. `CoreDriver` feeds it once per `process()` call and reports its counts in STATUS.
import { QUANTUM_FRAMES } from "../wire.generated";

const PROBE_BUCKETS = 8;
const PROBE_BUCKET_MS = 125;
const PROBE_WARM_MS = 1_000;
const PROBE_JUMP_MS = 500;
const PROBE_THRESHOLD_S = 0.024;
/**
 * F-37: the sawtooth the 24 ms threshold already covers (Chromium's 10 ms desktop device period, plus the 1 ms clock and
 * a millisecond of arrival jitter). A device that calls `process()` in longer bursts (an Android phone or emulator
 * without a low-latency path: 40–80 ms) raises the threshold by its sawtooth beyond this.
 */
const PROBE_SAWTOOTH_COVERED_S = 0.012;

/**
 * @internal The underrun probe (architecture §4.7), per `process()` call, in frames behind the wall clock.
 * Re-anchors on a clock jump or a gap over 500 ms (suspension), warms up for 1 s, and counts an underrun when
 * the lag passes the 1 s window's minimum by 24 ms, plus the device's sawtooth beyond 12 ms (F-37).
 *
 * The device asks for a period's frames at once, so `process()` runs in bursts and the lag is a sawtooth whose
 * height is the period (10 ms on desktop Chromium, 40–80 ms on some Android devices). Each 125 ms bucket also keeps
 * the lag's spread (max − min, which doesn't depend on the anchor), and the median spread of the last second's complete
 * buckets is the sawtooth: a stall lifts the spread of one or two buckets, not the median. Without the allowance, a
 * period over 24 ms counted an underrun every second, for good, and drove the adaptive cap to its floor and the
 * shedding ladder on.
 */
export class UnderrunProbe {
  underruns = 0;
  underrunFrames = 0;
  private anchored = false;
  private t0 = 0;
  private f0 = 0;
  private warmUntil = 0;
  private lastDate = 0;
  private readonly buckets = new Float64Array(PROBE_BUCKETS);
  /** Which 125 ms slot each bucket holds, so a stale bucket resets before it's reused. */
  private readonly bucketSlot = new Float64Array(PROBE_BUCKETS);
  /** F-37: each bucket's lag spread (min and max of the lag) and its slot, kept across anchors; a scratch for the median. */
  private readonly spreadMin = new Float64Array(PROBE_BUCKETS);
  private readonly spreadMax = new Float64Array(PROBE_BUCKETS);
  private readonly spreadSlot = new Float64Array(PROBE_BUCKETS).fill(-1);
  private readonly spreads = new Float64Array(PROBE_BUCKETS);

  constructor(readonly sampleRate: number) {}

  /** (Re)anchors at this call: on start, resume, becoming visible and rebuild. */
  anchor(currentFrame: number, dateNow: number): void {
    this.anchored = true;
    this.t0 = dateNow;
    this.f0 = currentFrame;
    this.warmUntil = dateNow + PROBE_WARM_MS;
    this.lastDate = dateNow;
    this.buckets.fill(Infinity);
    this.bucketSlot.fill(-1);
    // The lag's reference moves: the current slot's spread starts again; the complete buckets keep theirs.
    const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
    if (this.spreadSlot[slot % PROBE_BUCKETS] === slot) this.spreadSlot[slot % PROBE_BUCKETS] = -1;
  }

  /** F-37: the device's sawtooth in frames: the median lag spread of the last second's complete buckets (0 before one). */
  sawtoothFrames(dateNow: number): number {
    const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
    const spreads = this.spreads;
    let n = 0;
    for (let i = 0; i < PROBE_BUCKETS; i++) {
      const s = this.spreadSlot[i]!;
      const complete = s >= 0 && s < slot && s >= slot - PROBE_BUCKETS;
      spreads[i] = complete ? this.spreadMax[i]! - this.spreadMin[i]! : Infinity;
      if (complete) n++;
    }
    if (n === 0) return 0;
    spreads.sort(); // in place, no allocation; the incomplete ones sort last
    return spreads[(n - 1) >> 1]!;
  }

  /** One `process()` call: `currentFrame` is the first frame of the quantum about to render. */
  step(currentFrame: number, dateNow: number): void {
    if (!this.anchored || dateNow < this.lastDate || dateNow - this.lastDate > PROBE_JUMP_MS) {
      this.anchor(currentFrame, dateNow);
      return;
    }
    this.lastDate = dateNow;
    const d = ((dateNow - this.t0) * this.sampleRate) / 1000 - (currentFrame + QUANTUM_FRAMES - this.f0);
    const slot = Math.floor(dateNow / PROBE_BUCKET_MS);
    const b = slot % PROBE_BUCKETS;
    if (this.bucketSlot[b] !== slot) {
      this.bucketSlot[b] = slot;
      this.buckets[b] = Infinity;
    }
    if (d < this.buckets[b]!) this.buckets[b] = d;
    if (this.spreadSlot[b] !== slot) {
      this.spreadSlot[b] = slot;
      this.spreadMin[b] = d;
      this.spreadMax[b] = d;
    } else if (d < this.spreadMin[b]!) this.spreadMin[b] = d;
    else if (d > this.spreadMax[b]!) this.spreadMax[b] = d;
    if (dateNow < this.warmUntil) return;
    let dMin = Infinity;
    for (let i = 0; i < PROBE_BUCKETS; i++) if (this.buckets[i]! < dMin) dMin = this.buckets[i]!;
    const lag = d - dMin;
    const threshold = PROBE_THRESHOLD_S * this.sampleRate;
    if (lag <= threshold) return;
    // Past the desktop threshold (on a long-period device, at every burst): allow the sawtooth beyond what it covers.
    const allowance = Math.max(0, this.sawtoothFrames(dateNow) - PROBE_SAWTOOTH_COVERED_S * this.sampleRate);
    if (lag > threshold + allowance) {
      this.underruns = (this.underruns + 1) >>> 0;
      this.underrunFrames = (this.underrunFrames + Math.round(lag)) >>> 0;
      this.anchor(currentFrame, dateNow);
    }
  }
}
