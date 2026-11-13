// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Ma1): the core backend's live-edit path (api-and-models
// §6.1–§6.2, §6.6; architecture §3.2, §4.7). `CoreBackend.applyOp` routes every op here; `mixer.apply(op)` reaches it.
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
//   - `dip` (structural: move, remove, effect reorder or removal, an effect inserted before the end) answers
//     `restartRequired` until Ma2's dip (W6): the edit is saved and applies at the next Play, so nothing can click.
//   - `none`: a refused op (`ok: false`, counted) or one that changes nothing (`ok: true`: a commit re-applying what a
//     preview already set).
// - **Same batch.** Everything an op sends is staged in the command writer during `apply`, so it goes out with the
//   frame's BATCH (or sooner with `flushNow`). Runtime state (script volume, fades, mutes, solo, the snapshot in force,
//   monitor controls) is never touched.
// - **The preview path** (a fader drag, R22): `mixer.apply` then `flushNow()`, which posts the staged batch at once, at
//   most once per `FADER_COALESCE_MS`; a call inside the window posts when it ends.
import { opClass, opRefusal, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import type { Mixer } from "../../../../engine/audio/mixer";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { BUS_SLOT_MAX_EFFECTS, FADER_COALESCE_MS } from "../wire.generated";
import { hasAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { loudnessHub, type LoudnessHubConfig } from "../mix/loudnessHub";
import type { StructuralDip } from "./structuralDip";
import type { DeferredAdds } from "./deferredAdds";
import type { BusSlotWrite, LoudnessConfigWrite } from "../backend";
import type { BusIndex } from "./busIndex";
import type { CommandWriter } from "./commandWriter";
import type { CoreAutomation } from "./coreAutomation";

/** The answer of a structural op until Ma2's dip (the Mixer panel shows "Applies at the next Play: ..."). */
export const RESTART_REQUIRED = "moving, removing or reordering buses and effects applies at the next Play";

/** The answer of a fifth effect on a bus (`BUS_SLOT` carries at most `BUS_SLOT_MAX_EFFECTS`; architecture §4.7). */
export const FIFTH_EFFECT = `a bus takes at most ${BUS_SLOT_MAX_EFFECTS} effects while playing; this one applies at the next Play`;

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
  writer(): Pick<CommandWriter, "busSlot" | "loudConfig" | "flush" | "pending">;
  automation(): Pick<CoreAutomation, "renameBus">;
  /** The backend's mixer-change work, now: the bed plan check, presence's rules (`BUS_DUCK`) and the lanes (`BUS_RAMP`). */
  syncMix(): void;
  /** Whether a batch may be posted now (running, not recovering, not disposed). */
  sending(): boolean;
  /** `ClockMap.nextFirstFrame()`: the frame a posted batch's asap records apply at. */
  firstFrame(): number;
  /** A heard time as a stamp (`ClockMap.stampFor(frameOfTime(t))`); undefined: asap. */
  stampAt?(t: number): number | undefined;
  /** The event runtime binds bus automation again from the mixer's settings (`BUS_AUTOMATE`); default: its refresh. */
  automationChanged?(): void;
  /** Default: the page's hub. */
  loudness?: LiveLoudness;
  /** Milliseconds for `flushNow`'s coalescing (default `performance.now`). */
  nowMs?(): number;
  /** Runs `fn` after `ms` (default `setTimeout`). */
  setTimer?(fn: () => void, ms: number): void;
}

/**
 * The event runtime's refresh (it re-reads `audio.automation` and binds every bus again through the active backend's
 * sink). `getGlobal` is its public entry that does only that for an unknown name; nothing is made when no backend is up.
 */
function refreshEventAutomation(): void {
  if (hasAudioBackend()) events().getGlobal("");
}

export class LiveMix {
  /** Live edits refused or left for the next Play (`Audio.debug().mix.liveRefused`). */
  refused = 0;
  /** Batches `flushNow` posted (tests and the gate's figures). */
  posts = 0;
  private lastPostMs = Number.NEGATIVE_INFINITY;
  private timerSet = false;

  constructor(protected readonly host: LiveMixHost) {}

  /** One op on the running mix (§6.2); see the header for what each class sends. */
  apply(op: MixOp): ApplyResult {
    const host = this.host;
    const mixer = host.mixer();
    const before = mixer.audioSettings;
    if (opRefusal(before, op) !== null) {
      this.refused++;
      return { ok: false, class: "none" };
    }
    const cls = opClass(op, before);
    if (cls === "none") return { ok: true, class: "none" };
    if (cls === "dip") return this.later(cls, RESTART_REQUIRED);
    const buses = host.buses();
    switch (op.op) {
      case "addBus": {
        const name = op.name.trim();
        const parent = before.buses.some((b) => b.name === op.parent) ? op.parent : before.buses[0]!.name;
        const slot = buses.addBus(name, parent);
        if (typeof slot !== "number") return this.later(cls, slot.deferred); // Ma3 queues it (W8)
        mixer._applyLive(op, slot);
        buses.writeSlot(name, true);
        buses.writeLimits();
        break;
      }
      case "addEffect":
        if (before.buses.find((b) => b.name === op.bus)!.effects.length >= BUS_SLOT_MAX_EFFECTS) return this.later(cls, FIFTH_EFFECT);
        mixer._applyLive(op);
        buses.writeSlot(op.bus);
        break;
      case "setEffect":
        mixer._applyLive(op);
        buses.writeSlot(op.bus);
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
        mixer._applyLive(op);
        (host.automationChanged ?? refreshEventAutomation)();
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
    if (!host.sending()) return;
    const now = host.nowMs ? host.nowMs() : performance.now();
    const wait = this.lastPostMs + FADER_COALESCE_MS - now;
    if (wait > 0) {
      // Inside the window: the edits wait for its end (or go with the frame's BATCH first).
      if (this.timerSet) return;
      this.timerSet = true;
      const fire = () => {
        this.timerSet = false;
        this.flushNow();
      };
      if (host.setTimer) host.setTimer(fire, wait);
      else setTimeout(fire, wait);
      return;
    }
    const writer = host.writer();
    if (writer.pending === 0) return;
    writer.flush(host.firstFrame());
    this.lastPostMs = now;
    this.posts++;
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

  /** An op left for later: counted, the edit stays saved, the message says when it applies. */
  private later(cls: ApplyResult["class"], message: string): ApplyResult {
    this.refused++;
    return { ok: false, class: cls, restartRequired: message };
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
