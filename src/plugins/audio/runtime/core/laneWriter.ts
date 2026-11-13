// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Mx2): the core backend's per-lane bus gain writer. K0 moved
// the bus writes, selection's effective-gain inputs and the MASTER writes here from `coreBackend.ts`; Wa2 (W2, H1) made
// them interim `BUS_RAMP`s; Mx2 (W3) replaced that with the lane writer (api-and-models §3.1, §4.2; architecture §4.5):
//
// - **One record per lane that moved.** The mixer keeps one `Ramp` per main-written lane (`mixer.ts`, `Mixer._lanes`), each
//   stamped with a `seq` on every write. `sync` (the mixer's change notification) compares each bus's lanes with what it
//   last sent and emits a `BUS_RAMP` for exactly the lanes whose ramp, mute or solo gate moved; a frame where a running
//   fade merely advances sends nothing (the core runs the ramp itself).
// - **Laws (§4.5).** `runtime` (script volume × script mute), `snapshot` (gain and low-pass) and `dip`: a ramp with a
//   length (`fadeTo`, `snapshot(name, s)`, a dip) is **stamped** at the heard-clock time it starts, converted to a frame
//   through the lookahead (*F*_now + L, the batch's first frame; later by the ramp's start ahead of now), for its exact
//   length (floor `BUS_MIN_RAMP_MS`). A set (`volume =`, a 0-second fade or snapshot) and a toggle (mute, solo, monitor)
//   go asap over today's ramp length (`ClockMap.rampFrames()`, ≥ `BUS_MIN_RAMP_MS`). `authored` goes asap: a set or
//   toggle over `rampFrames`, a drag (a ramp with a length, `DRAG_RAMP_MS` once Ma1 drives it) over its own length.
//   `monitor` (monitor mute × the solo gate over the tree) goes asap over `rampFrames`.
// - **MASTER** goes through `BUS_RAMP` on `LANE_RUNTIME` of `BUS_MASTER_OUT` (B1a: MASTER's ramp is the output's runtime
//   lane), target volume × not (muted or hidden-tab muted). The `MASTER` record keeps its layout for the replay (§4.2).
// - **Replay** (`replayLanes`, §4.2, R12): after RESET and BUS_CONFIG every lane of every bus is resent (BUS_CONFIG does not
//   reset a re-added slot's lanes): `runtime` and `snapshot` as their remaining ramp (a step to the value now, then an
//   asap ramp to the target over what is left), `authored`, `monitor` and a drag at their value (the target), a dip at
//   its end state.
// - **Selection** (`busGain`): each bus's own lane product (authored × runtime × snapshot × monitor × dip × duck) times
//   its ancestors', times the automated gains (`refreshBusGain`).
import { BUS_MIN_RAMP_MS, Lane, rampAt, type Mixer, type Ramp, type ResolvedBus } from "../../../../engine/audio/mixer";
import {
  ASAP,
  BUS_LP_OFF_HZ,
  BUS_MASTER_OUT,
  BUS_RAMP_MASK_GAIN,
  BUS_RAMP_MASK_LP_HZ,
  FadeLaw,
  LANE_AUTHORED,
  LANE_DIP,
  LANE_MONITOR,
  LANE_RUNTIME,
  LANE_SNAPSHOT,
  packRampShape,
  writeBusRamp,
} from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { ClockMap } from "./clock";
import type { BusLaneRamp, MixLane } from "../backend";
import type { ReplayBuilder } from "./replay";

/** The core's bus count (`MAX_BUS` in `coreBackend.ts`). */
const MAX_BUS = 32;

const LANE_OF: Record<MixLane, number> = { authored: LANE_AUTHORED, runtime: LANE_RUNTIME, snapshot: LANE_SNAPSHOT, monitor: LANE_MONITOR, dip: LANE_DIP };
const LINEAR = packRampShape(FadeLaw.Linear, 0, 0);

/** What the lane writer needs of the core backend. */
export interface LaneWriterHost {
  readonly writer: Pick<CommandWriter, "busRampFrames">;
  readonly clockMap: Pick<ClockMap, "rampFrames" | "framesNow" | "lookaheadFrames" | "frameOfTime" | "stampFor" | "sampleRate"> & Partial<Pick<ClockMap, "timeOffset">>;
  /** The mixer whose lanes are written (its `Ramp` records, evaluated on the heard clock). */
  readonly mixer: Pick<Mixer, "_lanes" | "busNames" | "time" | "audioSettings" | "laneGain">;
  /** Bus name → index, as last configured (`busIndex.ts`). */
  readonly busIndexByName: ReadonlyMap<string, number>;
  /** Selection's bus factor, by bus index (`Selection.busGain`). */
  readonly busGain: Float32Array;
  /** ADR 0162 (A5, S3): re-fold the sharing chain's snapshot low-pass after the cutoffs changed. */
  refreshSharedLowpass(): void;
  /** Dp1 (§4.2's replay order): `BUS_DUCK` and `BUS_PRESENCE`, after `BUS_CONFIG` and before the lanes (`presence.ts`). */
  replayDucking?(out: ReplayBuilder): void;
}

export class LaneWriter {
  /** M2 F3: selection's bus factor inputs, by bus index: effective gain without automation, parent, automated gain, chain product. */
  readonly selBase = new Float64Array(MAX_BUS).fill(1);
  readonly selParent = new Int16Array(MAX_BUS).fill(-1);
  readonly selAuto = new Float64Array(MAX_BUS).fill(1);
  private readonly selChain = new Float64Array(MAX_BUS).fill(1);
  selCount = 0;
  /** Each bus's snapshot cutoff now (`BUS_LP_OFF_HZ`: none), for the sharing chain's fold. */
  readonly snapLp = new Float32Array(MAX_BUS).fill(BUS_LP_OFF_HZ);

  // What was last sent, per core slot (Ma2: keyed by slot, not by name): the bus state it was for (its `authored` ramp
  // object, which a live rename keeps and a new bus on a recycled slot doesn't), each lane ramp's `seq`, the mutes, the
  // monitor gain.
  private readonly sentFor: (Readonly<Ramp> | null)[] = new Array<Readonly<Ramp> | null>(MAX_BUS).fill(null);
  /** Per slot, set while a `sync` or replay visits it (a name listed twice, or a stale state on a reused slot, is skipped). */
  private readonly visited = new Uint8Array(MAX_BUS);
  /** The parent's name of each bus, from the settings object it was read from. */
  private parentOf = new Map<string, string | undefined>();
  private parentsFrom: unknown = null;
  private readonly seqAuthored = new Float64Array(MAX_BUS);
  private readonly seqRuntime = new Float64Array(MAX_BUS);
  private readonly seqSnapshot = new Float64Array(MAX_BUS);
  private readonly seqLowpass = new Float64Array(MAX_BUS);
  private readonly seqDip = new Float64Array(MAX_BUS);
  private readonly mutedAuthored = new Uint8Array(MAX_BUS);
  private readonly mutedRuntime = new Uint8Array(MAX_BUS);
  private readonly monitorSent = new Float32Array(MAX_BUS);
  /** The solo and monitor switches per bus (bit 0 script solo, 1 monitor mute, 2 monitor solo) the monitor gains were computed from. */
  private readonly switches = new Uint8Array(MAX_BUS);
  /** The monitor lane's gain now, per bus (recomputed only when a switch moves). */
  private readonly monitorNow = new Float32Array(MAX_BUS).fill(1);
  private readonly own = new Float64Array(MAX_BUS);
  /** The start frame of each bus's last stamped `BUS_RAMP` (NaN: none yet). */
  private readonly lastStamp = new Float64Array(MAX_BUS).fill(Number.NaN);
  /** Every lane of every bus is resent at the next `sync` (a new tree, or a core whose lanes are unknown). */
  private full = true;

  constructor(private readonly host: LaneWriterHost) {}

  /** The bus tree was configured again (BUS_CONFIG): the next `sync` resends every lane of every bus. */
  forget(): void {
    this.full = true;
  }

  /** `Audio.debug()`'s bus row: the start frame of bus `b`'s last stamped `BUS_RAMP`, undefined before one. */
  lastRampStartFrame(b: number): number | undefined {
    const f = b >= 0 && b < MAX_BUS ? this.lastStamp[b]! : Number.NaN;
    return Number.isNaN(f) ? undefined : f;
  }

  /**
   * The mixer changed (its change notification, a configure): one `BUS_RAMP` per lane that moved since the last call
   * (every lane after `forget`), then selection's bus factor and the snapshot low-pass fold.
   */
  sync(): void {
    const mixer = this.host.mixer;
    const now = mixer.time;
    const full = this.full;
    this.full = false;
    const live = this.liveBuses();
    // The monitor lane: recomputed over the tree only when a solo or monitor switch moved (or on a full send).
    let switched = full;
    for (const name of live) {
      const l = mixer._lanes(name)!;
      const b = l.slot;
      const bits = (l.runtimeSolo ? 1 : 0) | (l.monitorMute ? 2 : 0) | (l.monitorSolo ? 4 : 0);
      if (bits !== this.switches[b] || this.sentFor[b] !== l.authored) switched = true;
      this.switches[b] = bits;
    }
    if (switched) for (const name of live) this.monitorNow[mixer._lanes(name)!.slot] = mixer.laneGain(name, Lane.monitor);

    this.readParents();
    // A slot no live bus holds (a tombstone, a free slot) is silent for selection.
    this.own.fill(0);
    this.selParent.fill(-1);
    let n = 0;
    for (const name of live) {
      const l = mixer._lanes(name)!;
      const b = l.slot;
      if (b + 1 > n) n = b + 1;
      const fresh = full || this.sentFor[b] !== l.authored;
      this.sentFor[b] = l.authored;
      // authored: asap (a set or toggle over rampFrames, a drag over its own length).
      if (fresh || l.authored.seq !== this.seqAuthored[b] || (l.authoredMute ? 1 : 0) !== this.mutedAuthored[b]) {
        const wasMuted = this.mutedAuthored[b] === 1;
        if (fresh || !(l.authoredMute && wasMuted)) this.writeGainLane(b, LANE_AUTHORED, l.authored, l.authoredMute, !wasMuted && l.authored.seq !== this.seqAuthored[b], false, now);
        this.seqAuthored[b] = l.authored.seq;
        this.mutedAuthored[b] = l.authoredMute ? 1 : 0;
      }
      // runtime: a fade stamped for its exact length; a set or a mute toggle asap.
      if (fresh || l.runtime.seq !== this.seqRuntime[b] || (l.runtimeMute ? 1 : 0) !== this.mutedRuntime[b]) {
        // While muted a new ramp changes nothing heard; an unmute resends what is left of it.
        const wasMuted = this.mutedRuntime[b] === 1;
        if (fresh || !(l.runtimeMute && wasMuted)) this.writeGainLane(b, LANE_RUNTIME, l.runtime, l.runtimeMute, !wasMuted && l.runtime.seq !== this.seqRuntime[b], true, now);
        this.seqRuntime[b] = l.runtime.seq;
        this.mutedRuntime[b] = l.runtimeMute ? 1 : 0;
      }
      // snapshot: its gain and low-pass, stamped together when they moved together.
      const gainMoved = fresh || l.snapshot.seq !== this.seqSnapshot[b];
      const lpMoved = fresh || l.snapshotLowpass.seq !== this.seqLowpass[b];
      if (gainMoved || lpMoved) this.writeSnapshot(b, l.snapshot, l.snapshotLowpass, gainMoved, lpMoved, l.snapshot.seq !== this.seqSnapshot[b], l.snapshotLowpass.seq !== this.seqLowpass[b], now);
      this.seqSnapshot[b] = l.snapshot.seq;
      this.seqLowpass[b] = l.snapshotLowpass.seq;
      // monitor: asap.
      const monitor = this.monitorNow[b]!;
      if (fresh || monitor !== this.monitorSent[b]) {
        this.host.writer.busRampFrames(b, LANE_MONITOR, BUS_RAMP_MASK_GAIN, monitor, BUS_LP_OFF_HZ, this.host.clockMap.rampFrames());
        this.monitorSent[b] = monitor;
      }
      // dip: stamped like a fade.
      if (fresh || l.dip.seq !== this.seqDip[b]) {
        this.writeGainLane(b, LANE_DIP, l.dip, false, l.dip.seq !== this.seqDip[b], true, now);
        this.seqDip[b] = l.dip.seq;
      }
      // Selection's audibility: the bus's own lane product now (A3.1; automation multiplies in `refreshBusGain`).
      const g =
        (l.authoredMute ? 0 : rampAt(l.authored, now)) *
        (l.runtimeMute ? 0 : rampAt(l.runtime, now)) *
        rampAt(l.snapshot, now) *
        monitor *
        rampAt(l.dip, now) *
        l.duck;
      this.own[b] = Number.isFinite(g) && g > 0 ? g : 0;
      const p = this.parentOf.get(name);
      this.selParent[b] = p === undefined ? -1 : (this.host.busIndexByName.get(p) ?? -1);
      this.snapLp[b] = rampAt(l.snapshotLowpass, now);
    }
    // A slot that went silent since the last configure (a tombstone) keeps being written, as 0.
    if (!full) n = Math.max(n, this.selCount);
    // The effective gain down the tree: each bus's own product times its ancestors'.
    for (let b = 0; b < n; b++) {
      let g = this.own[b]!;
      for (let p = this.selParent[b]!, depth = 0; p >= 0 && p < n && depth < 64; p = this.selParent[p]!, depth++) g *= this.own[p]!;
      this.selBase[b] = g;
    }
    this.selCount = n;
    this.refreshBusGain();
    this.host.refreshSharedLowpass();
  }

  /**
   * The mixer's buses that hold their slot now, each slot once (Ma2): a name the bus index maps to its state's slot. The
   * mixer keeps a removed bus's state until the next configure: a tombstone's lanes are the dip's (held at 0, nothing
   * more is sent), and a stale state whose slot a new bus took is skipped.
   */
  private liveBuses(): string[] {
    const mixer = this.host.mixer;
    const map = this.host.busIndexByName;
    const out: string[] = [];
    this.visited.fill(0);
    for (const name of mixer.busNames) {
      const l = mixer._lanes(name);
      if (!l) continue;
      const b = l.slot;
      if (b < 0 || b >= MAX_BUS || this.visited[b] || map.get(name) !== b) continue;
      this.visited[b] = 1;
      out.push(name);
    }
    return out;
  }

  /** Each bus's parent by name, read again when the settings object changed (a removed bus has none: a silent root). */
  private readParents(): void {
    const settings = this.host.mixer.audioSettings;
    if (settings === this.parentsFrom) return;
    this.parentsFrom = settings;
    this.parentOf = new Map(settings.buses.map((x) => [x.name, x.parent]));
  }

  /**
   * The backend's `applyMix` (the `AudioBackend` contract): the lanes are read from the mixer, not from `buses`, so this is
   * `sync`.
   */
  applyMix(_buses?: readonly ResolvedBus[]): void {
    this.sync();
  }

  /**
   * M2 F3: selection's bus factor: the lane product down the tree times each bus's automated gain (selection's no-gap
   * estimate, `CoreAutomation.publishSelection`) and its ancestors', root first. Run where either input changes.
   */
  refreshBusGain(): void {
    const busGain = this.host.busGain;
    const chain = this.selChain;
    for (let b = 0; b < this.selCount; b++) {
      // Up the tree (Ma2: a re-parent can put a parent at a higher slot than its child).
      let c = this.selAuto[b]!;
      for (let p = this.selParent[b]!, depth = 0; p >= 0 && p < this.selCount && depth < 64; p = this.selParent[p]!, depth++) c *= this.selAuto[p]!;
      chain[b] = c;
      const g = this.selBase[b]! * c;
      busGain[b] = Number.isFinite(g) && g > 0 ? g : 0;
    }
  }

  /**
   * MASTER: the output gain, `BUS_RAMP` on `LANE_RUNTIME` of `BUS_MASTER_OUT` (B1a), target `volume` (0 when `muted`:
   * `Audio.muted` or the hidden-tab mute), asap over `rampFrames` (the volume and mute setters, the hidden-tab mute).
   */
  master(volume: number, muted: boolean, rampFrames: number): void {
    this.host.writer.busRampFrames(BUS_MASTER_OUT, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, muted ? 0 : volume, BUS_LP_OFF_HZ, rampFrames);
  }

  /**
   * §4.2: one `BUS_RAMP` on a main-written lane as asked (`AudioBackend.rampLane`): `bus` null is the output gain;
   * `seconds` 0 is a literal step; `at` (heard seconds) stamps it at its frame, asap when omitted or past.
   */
  rampLane(r: BusLaneRamp): void {
    const b = r.bus === null ? BUS_MASTER_OUT : this.host.busIndexByName.get(r.bus);
    const lane = LANE_OF[r.lane];
    if (b === undefined || lane === undefined) return;
    const mask = (r.gain !== undefined ? BUS_RAMP_MASK_GAIN : 0) | (r.lpHz !== undefined ? BUS_RAMP_MASK_LP_HZ : 0);
    if (mask === 0) return;
    const cm = this.host.clockMap;
    const frames = Number.isFinite(r.seconds) && r.seconds > 0 ? Math.round(r.seconds * cm.sampleRate) : 0;
    const at = r.at === undefined ? undefined : cm.stampFor(cm.frameOfTime(r.at));
    this.host.writer.busRampFrames(b, lane, mask, r.gain ?? 1, r.lpHz ?? BUS_LP_OFF_HZ, frames, (r.sequenceId ?? 0) & 0x1fff, at);
    if (at !== undefined && b < MAX_BUS) this.lastStamp[b] = at;
  }

  /**
   * The hard rebuild's lanes (§4.2, after RESET, BUS_CONFIG and the bed plan; before MASTER), every record asap: per bus,
   * every main-written lane, `runtime` and `snapshot` as their remaining ramp, `authored` and `monitor` at their value, a
   * dip at its end state. What it sends becomes what the core is known to hold.
   */
  replayLanes(out: ReplayBuilder): void {
    // Dp1: the ducking rules and the presence mask come first (§4.2: BUS_CONFIG, BUS_DUCK, BUS_PRESENCE, then lanes).
    this.host.replayDucking?.(out);
    const mixer = this.host.mixer;
    const now = mixer.time;
    const rate = this.host.clockMap.sampleRate;
    const step = (b: number, lane: number, mask: number, gain: number, lpHz: number, frames: number) =>
      out.record(32, (view, off) => writeBusRamp(view, off, { voiceId: b, frameOffset: ASAP, lane, mask, gain, lpHz, frames, shape: LINEAR }));
    const remaining = (r: Readonly<Ramp>) => (r.seconds > 0 && r.from !== r.to ? Math.round((r.start + r.seconds - now) * rate) : 0);
    // Ma2: the live buses by slot, then each removed bus still holding its slot (a tombstone): only its dip lane, at its
    // end state (0), since a silent root carries nothing else.
    const live = this.liveBuses();
    const removed: string[] = [];
    for (const name of mixer.busNames) {
      const l = mixer._lanes(name);
      if (!l || l.slot < 0 || l.slot >= MAX_BUS || this.visited[l.slot] || this.host.busIndexByName.has(name)) continue;
      this.visited[l.slot] = 1;
      removed.push(name);
    }
    const bySlot = (x: string, y: string) => mixer._lanes(x)!.slot - mixer._lanes(y)!.slot;
    for (const name of removed) {
      const l = mixer._lanes(name)!;
      step(l.slot, LANE_DIP, BUS_RAMP_MASK_GAIN, l.dip.to, BUS_LP_OFF_HZ, 0);
    }
    for (const name of live.sort(bySlot)) {
      const l = mixer._lanes(name)!;
      const b = l.slot;
      step(b, LANE_AUTHORED, BUS_RAMP_MASK_GAIN, l.authoredMute ? 0 : l.authored.to, BUS_LP_OFF_HZ, 0);
      // runtime: the value now, then what is left of a running fade.
      const runLeft = l.runtimeMute ? 0 : remaining(l.runtime);
      step(b, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, l.runtimeMute ? 0 : runLeft > 0 ? rampAt(l.runtime, now) : l.runtime.to, BUS_LP_OFF_HZ, 0);
      if (runLeft > 0) step(b, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, l.runtime.to, BUS_LP_OFF_HZ, runLeft);
      // snapshot: gain and low-pass, likewise.
      const snapLeft = remaining(l.snapshot);
      const lpLeft = remaining(l.snapshotLowpass);
      step(b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, snapLeft > 0 ? rampAt(l.snapshot, now) : l.snapshot.to, lpLeft > 0 ? rampAt(l.snapshotLowpass, now) : l.snapshotLowpass.to, 0);
      if (snapLeft > 0 && snapLeft === lpLeft) step(b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, l.snapshot.to, l.snapshotLowpass.to, snapLeft);
      else {
        if (snapLeft > 0) step(b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN, l.snapshot.to, BUS_LP_OFF_HZ, snapLeft);
        if (lpLeft > 0) step(b, LANE_SNAPSHOT, BUS_RAMP_MASK_LP_HZ, 1, l.snapshotLowpass.to, lpLeft);
      }
      const monitor = mixer.laneGain(name, Lane.monitor);
      step(b, LANE_MONITOR, BUS_RAMP_MASK_GAIN, monitor, BUS_LP_OFF_HZ, 0);
      step(b, LANE_DIP, BUS_RAMP_MASK_GAIN, l.dip.to, BUS_LP_OFF_HZ, 0);
      this.sentFor[b] = l.authored;
      this.seqAuthored[b] = l.authored.seq;
      this.mutedAuthored[b] = l.authoredMute ? 1 : 0;
      this.seqRuntime[b] = l.runtime.seq;
      this.mutedRuntime[b] = l.runtimeMute ? 1 : 0;
      this.seqSnapshot[b] = l.snapshot.seq;
      this.seqLowpass[b] = l.snapshotLowpass.seq;
      this.monitorSent[b] = monitor;
      this.seqDip[b] = l.dip.seq;
    }
  }

  // --- Writing one lane ---

  /** `BUS_MIN_RAMP_MS` in frames: the floor of every ramp main asks for. */
  private minFrames(): number {
    return Math.round((BUS_MIN_RAMP_MS * this.host.clockMap.sampleRate) / 1000);
  }

  /**
   * The frame a ramp starting at heard time `start` is stamped at: *F*_now + L (the batch's first frame), or `start`'s
   * frame when that is later; undefined (asap) while the clock map has no estimate.
   */
  private stampOf(start: number): number | undefined {
    const cm = this.host.clockMap;
    const now = cm.framesNow();
    if (!(now > 0)) return undefined;
    return Math.max(Math.round(now + cm.lookaheadFrames()), cm.frameOfTime(start));
  }

  /**
   * Dp1 (Mx2's timing note): the heard time (`Audio.time` seconds) a ramp stamped now starts at: *F*_now + L as heard
   * seconds, NaN while the clock map has no estimate. The mixer starts a fade's or snapshot's `Ramp` record here
   * (`Mixer.setClock`'s `stamp`), so its getters read the value being heard, and `stampOf` gives the same frame back.
   */
  stampTime(): number {
    const cm = this.host.clockMap;
    const now = cm.framesNow();
    if (!(now > 0)) return Number.NaN;
    return Math.round(now + cm.lookaheadFrames()) / cm.sampleRate + (cm.timeOffset ?? 0);
  }

  /**
   * A gain lane from its ramp `r` (× 0 when `muted`). `isNew`: `r` was written since the last send, so a length is its
   * whole length (stamped when `stampable`); otherwise a running ramp is resent as what is left of it, asap.
   */
  private writeGainLane(b: number, lane: number, r: Readonly<Ramp>, muted: boolean, isNew: boolean, stampable: boolean, now: number): void {
    if (muted) this.emit(b, lane, BUS_RAMP_MASK_GAIN, 0, BUS_LP_OFF_HZ, null, false, false, now);
    else this.emit(b, lane, BUS_RAMP_MASK_GAIN, r.to, BUS_LP_OFF_HZ, r, isNew, stampable, now);
  }

  /** The snapshot lane: gain and low-pass in one record when both moved with one ramp, else each on its own. */
  private writeSnapshot(b: number, g: Readonly<Ramp>, lp: Readonly<Ramp>, gainMoved: boolean, lpMoved: boolean, gainNew: boolean, lpNew: boolean, now: number): void {
    if (gainMoved && lpMoved && g.start === lp.start && g.seconds === lp.seconds && gainNew === lpNew) {
      this.emit(b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN | BUS_RAMP_MASK_LP_HZ, g.to, lp.to, g, gainNew, true, now);
      return;
    }
    if (gainMoved) this.emit(b, LANE_SNAPSHOT, BUS_RAMP_MASK_GAIN, g.to, BUS_LP_OFF_HZ, g, gainNew, true, now);
    if (lpMoved) this.emit(b, LANE_SNAPSHOT, BUS_RAMP_MASK_LP_HZ, 1, lp.to, lp, lpNew, true, now);
  }

  /** One `BUS_RAMP` to `gain`/`lpHz`, its timing from `r` (null: a toggle). */
  private emit(b: number, lane: number, mask: number, gain: number, lpHz: number, r: Readonly<Ramp> | null, isNew: boolean, stampable: boolean, now: number): void {
    const writer = this.host.writer;
    const cm = this.host.clockMap;
    if (r && r.seconds > 0) {
      if (isNew) {
        const frames = Math.max(Math.round(r.seconds * cm.sampleRate), this.minFrames());
        const at = stampable ? this.stampOf(r.start) : undefined;
        writer.busRampFrames(b, lane, mask, gain, lpHz, frames, 0, at);
        if (at !== undefined) this.lastStamp[b] = at;
        return;
      }
      const left = r.start + r.seconds - now;
      if (left > 0) {
        writer.busRampFrames(b, lane, mask, gain, lpHz, Math.max(Math.round(left * cm.sampleRate), cm.rampFrames()));
        return;
      }
    }
    writer.busRampFrames(b, lane, mask, gain, lpHz, cm.rampFrames());
  }
}
