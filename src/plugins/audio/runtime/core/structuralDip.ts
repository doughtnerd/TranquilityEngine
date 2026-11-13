// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Ma2): structural live edits as one stamped dip sequence
// (api-and-models §6.5, §4.2 `BUS_SLOT` and its sequence tag; architecture §3.3, §2.3, §4.7; R8, R9, R12). `LiveMix`
// routes every `dip`-class op here (`moveBus`, `removeBus`, `removeEffect`, `moveEffect`, `addEffect` before the end).
//
// - **The model at once.** `apply` changes the mixer's settings (`Mixer._applyLive`) and the slot table (a move, or the
//   removed bus and its descendants as tombstones) immediately, so every reader, and a rebuild's replay, sees the end
//   state. Only the wire waits for the sequence.
// - **One sequence.** Ops applied in one task (one display frame: an undo's ops, a mid-tree insert's moves) coalesce into
//   one open sequence, emitted at the end of the task (`defer`, a microtask; `update` emits it too). Its records, from one
//   F0 = now + lookahead (`firstFrame`): per root a dip-down `BUS_RAMP` on the dip lane, 1 → 0 over `DIP_FRAMES` at F0;
//   per changed slot a structural `BUS_SLOT` at B, the first quantum start at or after F0 + `DIP_FRAMES`; per live root a
//   dip-up 0 → 1 over `DIP_FRAMES` at B. All carry one `sequenceId` (1..8191). A tombstone dips down and stays at 0
//   (its `BUS_SLOT` makes it a silent root; main holds its lane at 0 until it recycles).
// - **Never split.** What was staged before goes out first (`flush`), then the sequence's records alone, flushed at once
//   (about 156 B per slot and 64 B per root, far under a BATCH), so no batch boundary can fall inside it; the per-voice
//   records follow in their own post. While the backend can't send (locked) they stay staged together; while it
//   recovers the frame's commit clears them and the replay carries the end state.
// - **Queueing.** One sequence is in flight: a later one starts at or after the planned end (B + `DIP_FRAMES`) of the
//   one before (the core also shifts a later sequence to the in-flight one's shifted end, so two dips never overlap).
//   A direct `BUS_SLOT` for a slot whose structural change is still open is carried by the sequence (`directSlot` →
//   null); one whose change is stamped and not applied yet rides it, stamped at its B with its id.
// - **The per-voice dip.** A removed bus's voices move to its root: the bus's dip is their fade-out; at B (dip at 0) each
//   voice's fade drops to 0 and its `SET_PARAMS bus` lands, then it fades back in over `DIP_FRAMES` from B
//   (`BusIndex.moveVoices`). Those records carry no sequence tag: they ride the planned frames.
// - **Tombstones (R9).** A tombstone may recycle `TOMBSTONE_TAIL_FRAMES` after its sequence's end, with no voice on it
//   (`recycle`, from `apply`, a live add and `update`).
// - **Rebuild (R12).** The table and the mixer already hold the end state, so the replay sends it (BUS_CONFIG with
//   tombstones as silent roots, the dip lane at 1, 0 for a tombstone). `replayEndState` settles main's bookkeeping: an
//   open sequence's main-side changes are made, the queue is forgotten and tombstones may recycle from the new frame. A
//   frame that runs backwards (a new context) does the same.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import type { Mixer } from "../../../../engine/audio/mixer";
import { BUS_LP_OFF_HZ, BUS_RAMP_MASK_GAIN, LANE_DIP, QUANTUM_FRAMES, SHAPE_SEQUENCE_MASK } from "../wire.generated";
import type { BusIndex, SlotStamp } from "./busIndex";
import type { CommandWriter } from "./commandWriter";
import { LOOKAHEAD_MAX_SECONDS } from "./lookahead";

/** The dip's length (R8): `DIP_FRAMES` = round(0.020 × sampleRate). */
export const DIP_MS = 20;

/** `DIP_FRAMES` at `sampleRate`. */
export function dipFrames(sampleRate: number): number {
  return Math.round((DIP_MS / 1000) * sampleRate);
}

/** The answer of a structural op the dip can't serve (no backend bound, a bus the table doesn't hold). */
export const DIP_UNAVAILABLE = "this structural edit applies at the next Play";

/** The core's bus count. */
const MAX_BUS = 32;

/** A planned end this far (in seconds) past now belongs to another epoch's frames: forget it. */
const STALE_SECONDS = 2;

/** What the dip needs of the core backend (closures read it lazily; `LiveMix` binds it from its own host). */
export interface StructuralDipHost {
  mixer(): Pick<Mixer, "_applyLive" | "_setDip" | "audioSettings">;
  buses(): Pick<BusIndex, "slotOf" | "moveBus" | "removeBus" | "settle" | "recycle" | "rootOf" | "moveVoices" | "dipVoices" | "slotConfig" | "slots" | "names">;
  writer(): Pick<CommandWriter, "busRampFrames" | "busSlot" | "flush" | "pending" | "sampleRate">;
  /** Whether a batch may be posted now (running, not recovering, not disposed). */
  sending(): boolean;
  /** `ClockMap.nextFirstFrame()`: F0 = now + lookahead, the frame a batch posted now applies at. */
  firstFrame(): number;
  /** `ClockMap.framesNow()`: the frame a command sent now reaches the core at (recycling, the in-flight check); default `firstFrame` less the lookahead's ceiling. */
  framesNow?(): number;
  /** Runs `fn` at the end of the current task (default `queueMicrotask`): same-task ops coalesce. */
  defer?(fn: () => void): void;
}

/** One emitted sequence (tests and `Audio.debug()`): its id, frames and what it carried. */
export interface DipSequence {
  id: number;
  /** The dip-down's start frame. */
  f0: number;
  /** The `BUS_SLOT` records' frame (a quantum start) and the dip-up's start. */
  b: number;
  /** b + `DIP_FRAMES`: the planned end. */
  end: number;
  /** Live roots: dipped down and up. */
  roots: number[];
  /** Tombstones: dipped down, then silent roots. */
  tombstones: number[];
  /** Slots with a structural `BUS_SLOT`. */
  slots: number[];
  /** Voices moved with the per-voice dip. */
  voices: number;
}

/** The sequence being gathered in this task. */
interface OpenSequence {
  roots: Set<number>;
  tombstones: Set<number>;
  slots: Set<number>;
  /** Root slot → the ids of the voices moved to it on main, written to the core at B. */
  voices: Map<number, number[]>;
}

export class StructuralDip {
  /** Sequences emitted (tests and the debug view). */
  emitted = 0;
  /** The last sequence emitted, or null. */
  last: DipSequence | null = null;
  private host: StructuralDipHost | null = null;
  private open: OpenSequence | null = null;
  private scheduled = false;
  private nextId = 1;
  /** The planned end (B + DIP_FRAMES) of the last sequence, frames of this epoch. */
  private lastEnd = Number.NEGATIVE_INFINITY;
  /** The highest frame seen: a frame far below it is a new epoch (a new context's frames). */
  private lastFrame = Number.NEGATIVE_INFINITY;
  /** Per slot: the frame its last structural `BUS_SLOT` applies at, and that sequence's id. */
  private readonly slotAt = new Float64Array(MAX_BUS).fill(Number.NEGATIVE_INFINITY);
  private readonly slotSeq = new Uint16Array(MAX_BUS);

  /** `LiveMix` hands its host over (the backend's lazy closures). */
  bind(host: StructuralDipHost): void {
    this.host = host;
  }

  /** A sequence is open (this task) or still running on the core (later structural ops queue after it). */
  get inFlight(): boolean {
    return this.open !== null || (this.host !== null && this.now() < this.lastEnd);
  }

  /** Start (or join, or queue) the dip sequence for a structural op; the model changes at once. */
  apply(op: MixOp): ApplyResult {
    const host = this.host;
    if (!host) return unavailable();
    this.recycle();
    const mixer = host.mixer();
    const buses = host.buses();
    switch (op.op) {
      case "moveBus": {
        const s = buses.slotOf(op.bus);
        if (s < 0 || s >= MAX_BUS || buses.slotOf(op.parent) < 0) return unavailable();
        if (mixer.audioSettings.buses.find((b) => b.name === op.bus)?.parent === op.parent) return { ok: true, class: "none" };
        try {
          buses.moveBus(op.bus, op.parent);
        } catch {
          return unavailable();
        }
        mixer._applyLive(op);
        const o = this.gather();
        o.roots.add(s);
        o.slots.add(s);
        break;
      }
      case "removeBus": {
        const top = buses.slotOf(op.bus);
        if (top < 0 || top >= MAX_BUS) return unavailable();
        const root = buses.rootOf(top);
        let tombs: number[];
        try {
          tombs = buses.removeBus(op.bus);
        } catch {
          return unavailable();
        }
        mixer._applyLive(op);
        const o = this.gather();
        for (const t of tombs) {
          // The mixer keeps the removed bus's state until the next configure: its dip lane holds the end state (0) the
          // replay sends; the lane writer leaves a tombstone's lanes alone, so nothing goes out for it here.
          mixer._setDip(buses.names[t] ?? "", 0, 0);
          o.tombstones.add(t);
          o.roots.delete(t);
          o.slots.add(t);
        }
        // Their voices go to the root now on main (selection and the replay see the end state); on the core at B.
        const ids = buses.moveVoices(new Set(tombs), root);
        const list = o.voices.get(root);
        if (list) list.push(...ids);
        else o.voices.set(root, ids);
        break;
      }
      case "removeEffect":
      case "moveEffect":
      case "addEffect": {
        const s = buses.slotOf(op.bus);
        if (s < 0 || s >= MAX_BUS) return unavailable();
        if (!mixer._applyLive(op)) return { ok: true, class: "none" };
        const o = this.gather();
        o.roots.add(s);
        o.slots.add(s);
        break;
      }
      default:
        return unavailable();
    }
    this.schedule();
    return { ok: true, class: "dip" };
  }

  /**
   * How a direct edit's `BUS_SLOT` for slot `s` goes while a structural change of that slot is pending: null when the
   * open sequence carries it (send nothing: its record is built at emit from the settings then); stamped at the
   * sequence's `BUS_SLOT` frame with its id when that frame is still ahead (so it can't apply the structural change
   * early, at full gain); undefined (asap) otherwise.
   */
  directSlot(s: number): SlotStamp | null | undefined {
    if (this.open?.slots.has(s)) return null;
    if (s < 0 || s >= MAX_BUS || !this.host) return undefined;
    const at = this.slotAt[s]!;
    return at > this.now() ? { at, sequenceId: this.slotSeq[s]! } : undefined;
  }

  /**
   * R9: frees each tombstone whose sequence ended `TOMBSTONE_TAIL_FRAMES` ago with no voice on it (at `frame`, default
   * now). Returns the freed slots.
   */
  recycle(frame?: number): number[] {
    const host = this.host;
    if (!host) return [];
    const f = frame ?? this.now();
    this.epoch(f);
    const freed = host.buses().recycle(f);
    for (const s of freed) if (s < MAX_BUS) this.slotAt[s] = Number.NEGATIVE_INFINITY;
    return freed;
  }

  /** Per frame: emit a sequence still open, notice a new epoch, recycle tombstones past their tail. */
  update(framesNow: number): void {
    if (this.open) this.emit();
    this.recycle(framesNow);
  }

  /**
   * A rebuild replays the dip's end state (R12): the table and the mixer already hold it. An open sequence's main-side
   * changes are made now (its records, if any, are cleared with the frame's commit while the backend recovers); the
   * queue is forgotten and tombstones may recycle from the new core's frame.
   */
  replayEndState(): void {
    if (this.open) this.emit();
    this.newEpoch(this.host ? this.now() : 0);
  }

  // --- Internals ---

  /**
   * *F*_now: where an asap record lands. Without `framesNow`, `firstFrame` less the lookahead's ceiling: never later
   * than *F*_now, so a tombstone never recycles early and a direct edit never overtakes a pending `BUS_SLOT`.
   */
  private now(): number {
    const host = this.host!;
    return host.framesNow ? host.framesNow() : host.firstFrame() - Math.round(LOOKAHEAD_MAX_SECONDS * host.writer().sampleRate);
  }

  private gather(): OpenSequence {
    if (!this.open) this.open = { roots: new Set(), tombstones: new Set(), slots: new Set(), voices: new Map() };
    return this.open;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.emit();
    };
    const defer = this.host?.defer;
    if (defer) defer(run);
    else queueMicrotask(run);
  }

  /** A frame far below the highest seen is another epoch's: the plans made on the old one go. */
  private epoch(frame: number): void {
    const rate = this.host?.writer().sampleRate ?? 48_000;
    if (frame + STALE_SECONDS * rate < this.lastFrame) this.newEpoch(frame);
    if (frame > this.lastFrame) this.lastFrame = frame;
  }

  private newEpoch(frame: number): void {
    this.lastEnd = Number.NEGATIVE_INFINITY;
    this.lastFrame = frame;
    this.slotAt.fill(Number.NEGATIVE_INFINITY);
    this.host?.buses().slots.replan(frame);
  }

  /** Writes the open sequence (see the header) and makes its main-side changes. */
  private emit(): void {
    const o = this.open;
    const host = this.host;
    this.open = null;
    if (!o || !host) return;
    const w = host.writer();
    const buses = host.buses();
    const table = buses.slots.slots;
    const sending = host.sending();
    // What was staged before goes out on its own, so the sequence starts a batch.
    if (sending && w.pending > 0) w.flush(host.firstFrame());
    const rate = w.sampleRate;
    const d = dipFrames(rate);
    const now = Math.round(host.firstFrame());
    this.epoch(this.now());
    const queued = this.lastEnd > now && this.lastEnd - now <= STALE_SECONDS * rate;
    const f0 = queued ? Math.ceil(this.lastEnd) : now;
    const b = Math.ceil((f0 + d) / QUANTUM_FRAMES) * QUANTUM_FRAMES;
    const end = b + d;
    const id = this.nextId;
    this.nextId = (id % SHAPE_SEQUENCE_MASK) + 1;
    const roots = [...o.roots].filter((s) => table[s]?.state === "live").sort((x, y) => x - y);
    const tombstones = [...o.tombstones].filter((s) => table[s]?.state === "tombstone").sort((x, y) => x - y);
    const slots = [...o.slots].filter((s) => s < table.length).sort((x, y) => x - y);
    for (const r of roots) w.busRampFrames(r, LANE_DIP, BUS_RAMP_MASK_GAIN, 0, BUS_LP_OFF_HZ, d, id, f0);
    for (const t of tombstones) w.busRampFrames(t, LANE_DIP, BUS_RAMP_MASK_GAIN, 0, BUS_LP_OFF_HZ, d, id, f0);
    for (const s of slots) {
      w.busSlot({ ...buses.slotConfig(s), structural: true, sequenceId: id }, b);
      if (s < MAX_BUS) {
        this.slotAt[s] = b;
        this.slotSeq[s] = id;
      }
    }
    for (const r of roots) w.busRampFrames(r, LANE_DIP, BUS_RAMP_MASK_GAIN, 1, BUS_LP_OFF_HZ, d, id, b);
    if (sending) w.flush(host.firstFrame());
    // The per-voice dip, in its own post (a sequence never waits on a voice count).
    let voices = 0;
    for (const [to, ids] of o.voices) voices += buses.dipVoices(ids, to, b, d, rate);
    if (sending && voices > 0 && w.pending > 0) w.flush(host.firstFrame());
    buses.settle(tombstones, end);
    this.lastEnd = end;
    this.emitted++;
    this.last = { id, f0, b, end, roots, tombstones, slots, voices };
  }
}

function unavailable(): ApplyResult {
  return { ok: false, class: "dip", restartRequired: DIP_UNAVAILABLE };
}
