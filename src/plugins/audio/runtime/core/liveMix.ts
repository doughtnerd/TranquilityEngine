// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Ma1): the core backend's live-edit path (api-and-models
// §6.1–§6.2, §6.6; architecture §3.2, §4.7). `mixer.apply(op)` sends every checked op here (`CoreBackend.mixOpTarget`, ADR 0175).
//
// - **Classes** (`opClass`, Mo1, against the mixer's running settings):
//   - `direct`: authored volume (a `BUS_RAMP` on the `authored` lane, asap over `DRAG_RAMP_MS`) and mute (asap over the
//     lane writer's toggle length, ≥ `BUS_MIN_RAMP_MS`); `maxVoices` (main's steal limit); a filter or send parameter
//     and an effect appended (one `BUS_SLOT` for the bus's slot, the diff of `BUS_CONFIG`); an added bus (the slot
//     table's next slot, one `BUS_SLOT` appended, `fresh`, then its lanes); a meter or a loudness target (`LOUD_CONFIG`,
//     replace-all, asap); a ducking rule (`BUS_DUCK` through presence, with the mask); a snapshot (the active one's lane
//     retargets over `SNAPSHOT_EDIT_MS`); bus automation (the event runtime binds again: `BUS_AUTOMATE`).
//   - `smoothed`: a compressor parameter, the same `BUS_SLOT`; the core blends over `COMPRESSOR_SMOOTH_MS` (R7).
//   - `config`: a rename (the slot is kept and the old name aliased: nothing on the wire), a bus's `bed` or
//     `bedPriority` (the bed plan again), `loudnessResetOnPlay` (the loudness hub).
//   - `dip` (structural: move, remove, effect reorder or removal, an effect inserted before the end): Ma2's stamped
//     sequence (`structuralDip.ts`): the model changes at once, the wire is one dip sequence from F0 = now + lookahead.
//     A direct `BUS_SLOT` for a slot whose structural change is pending is carried by, or stamped behind, that sequence
//     (`StructuralDip.directSlot`).
// - **The Mixer checks first** (ADR 0175, `Mixer.apply`): a refused op, one that changes nothing, and one past the core's
//   bus capability rules (a fifth effect, a second compressor: kept, applies at the next Play; `busCapability.ts`) never
//   reach `sendOp`; the Mixer tells `notSent`, which counts the refused and the kept ones.
// - **Same batch.** Everything an op sends is staged in the command writer during `apply`, so it goes out with the
//   frame's BATCH (or sooner with `flushNow`). Runtime state (script volume, fades, mutes, solo, the snapshot in force,
//   monitor controls) is never touched.
// - **The preview path** (a fader drag, R22): `mixer.apply` then `flushNow()`, which posts the staged batch at once, at
//   most once per `FADER_COALESCE_MS`; a call inside the window posts when it ends.
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import type { Mixer, MixOpTarget } from "../../../../engine/audio/mixer";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { CORE_LIVE_CAPS, type LiveCaps, type SentClass } from "../../../../engine/audio/busCapability";
import { FADER_COALESCE_MS } from "../wire.generated";
import type { SendGate } from "./session";
import { loudnessHub, type LoudnessHubConfig } from "../mix/loudnessHub";
import type { StructuralDip } from "./structuralDip";
import type { DeferredAdds } from "./deferredAdds";
import type { BusIndex } from "./busIndex";
import type { CommandWriter } from "./commandWriter";
import type { CoreAutomation } from "./coreAutomation";

// ADR 0179: the slot and loudness writes live here (they left the backend seam: only `CoreBackend` writes them).
/** One `BUS_SLOT` (§4.2, R7): one slot's configuration, so a parameter edit no longer resends the tree. */
export interface BusSlotWrite {
  slot: number;
  /** Parent slot; `BUS_ROOT` (0xFFFF) for a root. */
  parent: number;
  /** In wire form; at most 4 are kept. */
  effects: { type: number; p: number[] }[];
  /** Applies at quantum granularity under the gate (a dip's middle record). */
  structural?: boolean;
  /** The slot starts zeroed with unity lanes (a re-add after recycling). */
  fresh?: boolean;
  sequenceId?: number;
  /** Heard time it applies (omitted: asap). */
  at?: number;
}

/** `LOUD_CONFIG` (§4.2) as main asks for it: the true-peak gate and the metered buses (master is implicit). */
export interface LoudnessConfigWrite {
  tpGateDbfs: number;
  meters: readonly string[];
}

/** What the live path needs of the loudness hub (`mix/loudnessHub.ts`). */
export type LiveLoudness = { configure(cfg: LoudnessHubConfig): void; readonly tpGateDbfs: number };

/** What the live path needs of the core backend (closures read it lazily, so they can be handed over before it is built). */
export interface LiveMixHost {
  readonly dip: StructuralDip;
  readonly deferred: DeferredAdds;
  /** The mixer whose model the ops edit (`Mixer._applyLive`). */
  mixer(): Mixer;
  /** The bus index and its slot table (`busIndex.ts`). */
  buses(): BusIndex;
  writer(): Pick<CommandWriter, "busSlot" | "loudConfig" | "flush" | "pending" | "busRampFrames" | "sampleRate">;
  automation(): Pick<CoreAutomation, "renameBus">;
  /** The backend's mixer-change work, now: the bed plan check, presence's rules (`BUS_DUCK`) and the lanes (`BUS_RAMP`). */
  syncMix(): void;
  /** ADR 0291: the core session, asked whether a batch may be posted now (`maySend`). */
  readonly session: Pick<SendGate, "maySend">;
  /** `ClockMap.nextFirstFrame()`: the frame a posted batch's asap records apply at. */
  firstFrame(): number;
  /** Ma2: `ClockMap.framesNow()`, the frame a command sent now reaches the core at (the dip's recycling and queue); default `firstFrame`. */
  framesNow?(): number;
  /** Ma2: runs `fn` at the end of the current task, where same-task structural ops coalesce (default `queueMicrotask`). */
  defer?(fn: () => void): void;
  /** A heard time as a stamp (`ClockMap.stampFor(frameOfTime(t))`); undefined: asap. */
  stampAt?(t: number): number | undefined;
  /** Default: the page's hub. */
  loudness?: LiveLoudness;
  /** Milliseconds for `flushNow`'s coalescing (the backend's: `performance.now`). */
  nowMs(): number;
  /** Runs `fn` after `ms` (the backend's: `setTimeout`). */
  setTimer(fn: () => void, ms: number): void;
}

export class LiveMix implements MixOpTarget {
  /** Live edits refused or left for the next Play (`Audio.debug().mix.liveRefused`). */
  refused = 0;
  readonly liveCaps: LiveCaps = CORE_LIVE_CAPS;
  private lastPostMs = Number.NEGATIVE_INFINITY;
  private timerSet = false;

  constructor(protected readonly host: LiveMixHost) {
    // Ma3: finishing a deferred add reads the backend through the same lazy closures.
    host.deferred.bind({ mixer: () => host.mixer(), buses: () => host.buses(), syncMix: () => host.syncMix() });
    // Ma2: the dip reads the backend through this host's lazy closures.
    host.dip.bind({
      mixer: () => host.mixer(),
      buses: () => this.dipBuses(),
      writer: () => host.writer(),
      session: host.session,
      firstFrame: () => host.firstFrame(),
      ...(host.framesNow ? { framesNow: () => host.framesNow!() } : {}),
      ...(host.defer ? { defer: (fn: () => void) => host.defer!(fn) } : {}),
    });
  }

  private recycling: { of: BusIndex; as: BusIndex } | null = null;

  /**
   * The bus index as the dip sees it: every tombstone recycle (the per-frame update, a structural op, a live add) that
   * frees a slot goes on to finish the deferred adds the table gave it (Ma3, R10; `structuralDip.ts` is not edited).
   */
  private dipBuses(): BusIndex {
    const real = this.host.buses();
    if (this.recycling?.of === real) return this.recycling.as;
    const as = new Proxy(real, {
      get: (target, prop) => {
        if (prop === "recycle") {
          return (frame: number) => {
            const freed = target.recycle(frame);
            if (freed.length > 0) this.host.deferred.retry(freed);
            return freed;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    this.recycling = { of: real, as };
    return as;
  }

  /** `Mixer.apply` refused the op or kept it for the next Play: counted. */
  notSent(): void {
    this.refused++;
  }

  /** One checked op of class `cls` on the running mix (§6.2; `Mixer.apply` sends it); see the header for what each class sends. */
  sendOp(op: MixOp, cls: SentClass): ApplyResult {
    const host = this.host;
    const mixer = host.mixer();
    const before = mixer.audioSettings;
    const buses = host.buses();
    if (cls === "dip") {
      const r = host.dip.apply(op);
      if (!r.ok) {
        this.refused++;
        return r;
      }
      if (r.class === "none") return r;
      buses.liveSettings(before);
      host.syncMix();
      return r;
    }
    switch (op.op) {
      case "addBus": {
        const name = op.name.trim();
        // A parent still waiting for its slot is a parent (FU3): the child queues behind it and applies after it.
        const parent = before.buses.some((b) => b.name === op.parent) || host.deferred.waits(op.parent) ? op.parent : before.buses[0]!.name;
        host.dip.recycle(); // R9: a tombstone past its tail frees its slot first
        const slot = buses.addBus(name, parent);
        // R10: no free slot (a removed bus is still fading out): the edit is kept, queued, and applies at the recycle.
        if (typeof slot !== "number") return host.deferred.defer(op);
        mixer._applyLive(op, slot);
        buses.writeSlot(name, true);
        buses.writeLimits();
        break;
      }
      case "addEffect":
        mixer._applyLive(op);
        this.slotEdited(op.bus);
        break;
      case "setEffect":
        mixer._applyLive(op);
        this.slotEdited(op.bus);
        break;
      case "renameBus": {
        const to = op.to.trim();
        buses.renameBus(op.from, to);
        mixer._applyLive(op);
        host.automation().renameBus(op.from, to);
        this.loudnessChanged(false);
        break;
      }
      case "setBus":
        mixer._applyLive(op);
        if (op.key === "maxVoices") buses.writeLimits();
        else if (op.key === "meter") this.loudnessChanged(true);
        break;
      case "setTarget":
        mixer._applyLive(op);
        this.loudnessChanged(true);
        break;
      case "setOption":
        mixer._applyLive(op);
        this.loudnessChanged(false);
        break;
      case "setAutomation":
        // ADR 0248: the event runtime binds bus automation again (`BUS_AUTOMATE`) from above the seam (`onMixOpSent`).
        mixer._applyLive(op);
        break;
      default:
        // Snapshots and ducking rules: the mixer's model; presence and the lane writer send them in `syncMix`.
        mixer._applyLive(op);
        break;
    }
    buses.liveSettings(before);
    host.syncMix();
    return { ok: true, class: cls };
  }

  /** §6.6: post the staged batch now (the fader's preview path), at most once per `FADER_COALESCE_MS`. */
  flushNow(): void {
    const host = this.host;
    if (!host.session.maySend) return;
    const now = host.nowMs();
    const wait = this.lastPostMs + FADER_COALESCE_MS - now;
    if (wait > 0) {
      // Inside the window: the edits wait for its end (or go with the frame's BATCH first).
      if (this.timerSet) return;
      this.timerSet = true;
      const fire = () => {
        this.timerSet = false;
        this.flushNow();
      };
      host.setTimer(fire, wait);
      return;
    }
    const writer = host.writer();
    if (writer.pending === 0) return;
    writer.flush(host.firstFrame());
    this.lastPostMs = now;
  }

  /** §4.2 `BUS_SLOT`: one slot's configuration as given (Ma2 sends its structural records through it). */
  writeSlot(w: BusSlotWrite): void {
    const at = w.at === undefined ? undefined : this.host.stampAt?.(w.at);
    this.host.writer().busSlot(w, at);
  }

  /** §4.2 `LOUD_CONFIG`, replace-all, asap: the true-peak gate and the metered buses (by name; an unknown one is left out). */
  writeLoudnessConfig(c: LoudnessConfigWrite): void {
    const buses = this.host.buses();
    const slots: number[] = [];
    for (const name of c.meters) {
      const s = buses.slotOf(name);
      if (s >= 0 && !slots.includes(s)) slots.push(s);
    }
    this.host.writer().loudConfig(c.tpGateDbfs, slots);
  }

  /**
   * A direct `BUS_SLOT` for `bus` (an effect edit): asap, unless a structural change of its slot is pending, which then
   * carries it (open in this task) or has it ride its sequence (stamped at its `BUS_SLOT` frame), so the direct record
   * can never apply the structural change before its dip is at 0.
   */
  private slotEdited(bus: string): void {
    const buses = this.host.buses();
    const stamp = this.host.dip.directSlot(buses.slotOf(bus));
    if (stamp !== null) buses.writeSlot(bus, false, stamp);
  }

  /**
   * The metered set, the targets or the reset option changed: the hub follows the mixer's settings (meters that stay keep
   * their state) and, with `send`, `LOUD_CONFIG` goes out with the gate of the target in force.
   */
  private loudnessChanged(send: boolean): void {
    const hub = this.host.loudness ?? loudnessHub;
    const settings: AudioSettings = this.host.mixer().audioSettings;
    const buses = this.host.buses();
    const root = settings.buses[0]!.name;
    hub.configure({
      available: true,
      root,
      buses: settings.buses.map((b) => ({ name: b.name, parent: b.parent ?? null, slot: buses.slotOf(b.name), metered: b.meter === "loudness" })),
      targets: settings.loudnessTargets,
      resetOnPlay: settings.loudnessResetOnPlay,
    });
    if (!send) return;
    const meters = settings.buses.filter((b) => b.name !== root && b.meter === "loudness").map((b) => b.name);
    this.writeLoudnessConfig({ tpGateDbfs: hub.tpGateDbfs, meters });
  }
}
