// Ld2 (ADR 0171 amended by 0172; api-and-models §3.2, §4.2; the stubs file's Ld2 row): the core backend's wiring of the
// page's loudness hub, as one core-session participant (ADR 0178, "loudness").
//
// - **Configure** (`reconfigure`, after BUS_CONFIG: a slot may mean another bus now, so the bus meters restart with an
//   empty `LOUD_CONFIG` before the full one; the hub reseeds them and keeps their histograms) and a settings edit
//   (`sync(false)`, the mixer's change notification and each Engine's audio configure): the hub follows the meters,
//   targets and `loudnessResetOnPlay` (meters that stay keep their state), and `LOUD_CONFIG` goes out with the gate of
//   the target in force when the metered set or the gate changed. A live op's own `LOUD_CONFIG` is `liveMix.ts`'s
//   (`liveApplied` notes it, so the mixer's change notification sends nothing twice).
// - **Each frame** (`frame`, E2, 9280f46): a mute in force or MASTER not 1 suspends the target check (the hub ignores an
//   unchanged value).
// - **Rebuild**: an EPOCH at the end of recovery (each feed reseeds, histograms stay); `LOUD_CONFIG` in the header after
//   BUS_DUCK and BUS_PRESENCE, before the lanes (§4.2).
// - **Ownership**: the newest backend owns the hub's mixer source and gate sink; `dispose` releases them only if it still
//   owns them (a replacement is made before the old one goes).
import type { Mixer } from "../../../../engine/audio/mixer";
import { onAudioConfigured } from "../../../../engine/core/audioConfigure";
import { ASAP, MAX_LOUDNESS_BUSES, writeLoudConfig } from "../wire.generated";
import { loudnessHub, type LoudnessBusInfo } from "../mix/loudnessHub";
import type { BusIndex } from "./busIndex";
import type { CommandWriter } from "./commandWriter";
import type { CoreLink } from "./context";
import type { ReplayBuilder } from "./replay";
import type { SessionParticipant } from "./session";

/** What the wiring needs of the core backend. */
export interface CoreLoudnessHost {
  readonly mixer: Mixer;
  readonly writer: Pick<CommandWriter, "loudConfig">;
  readonly link: Pick<CoreLink, "onStatus">;
  /** The slot table's slot of a bus name (-1 unplaced). */
  readonly buses: () => Pick<BusIndex, "slotOf">;
  /** The backend is disposed: nothing more is sent. */
  readonly disposed: () => boolean;
}

/** The wiring that last took the page's hub (its mixer source and gate sink). */
let owner: CoreLoudness | null = null;

export class CoreLoudness implements SessionParticipant {
  private readonly hub = loudnessHub;
  /** The settings and the metered set last configured with. */
  private from: unknown = null;
  private key = "";
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly host: CoreLoudnessHost) {
    // The loudness sections, after the mirror and the recorder tap (api §3.2): the backend constructs this after both.
    this.unsubscribe.push(host.link.onStatus((status) => this.hub.feed(status)));
  }

  /**
   * Takes the page's hub (after the backend's first configure): it reads for the mixer (`Bus.loudness`), a target change
   * re-sends the gate, and each Engine's audio configure (the editor's Play; a game's engine start) resets the meters when
   * `loudnessResetOnPlay` says so.
   */
  attach(): void {
    owner = this;
    this.hub.attach(this.host.mixer);
    this.hub.setGateSink((tpGateDbfs) => this.send(tpGateDbfs));
    this.unsubscribe.push(
      onAudioConfigured(() => {
        this.sync(false);
        this.hub.play();
      }),
    );
  }

  /** The session's `reconfigure`: the hub and LOUD_CONFIG follow the new slots, after BUS_CONFIG. */
  reconfigure(): void {
    this.sync(true);
  }

  /** The session's `endRecovery`: an EPOCH. */
  endRecovery(): void {
    this.hub.epoch();
  }

  /** The session's `replayHeader`: `LOUD_CONFIG` with the gate in force and the metered slots, asap. */
  replayHeader(out: ReplayBuilder): void {
    const meters = this.slots().map((slot) => ({ slot, reserved: 0 }));
    const tpGateDbfs = this.hub.tpGateDbfs;
    out.record(20 + 4 * meters.length, (view, off) => writeLoudConfig(view, off, { voiceId: 0, frameOffset: ASAP, tpGateDbfs, meters }));
  }

  /** The session's `dispose`: the listeners go, and the hub's mixer source and gate sink when this still owns them. */
  dispose(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    if (owner !== this) return;
    owner = null;
    this.host.mixer.setLoudnessSource(null);
    this.hub.setGateSink(null);
  }

  /** E2, each frame's commit: whether a mute is in force, and whether MASTER is not 1. Allocates nothing. */
  frame(muted: boolean, masterNotUnity: boolean): void {
    this.hub.setMuted(muted);
    this.hub.setMasterNotUnity(masterNotUnity);
  }

  /** Project load (`force`) or a settings edit; see the header. */
  sync(force: boolean): void {
    if (this.host.disposed()) return;
    const settings = this.host.mixer.audioSettings;
    if (!force && settings === this.from) return;
    this.from = settings;
    const root = settings.buses[0]?.name;
    if (root === undefined) return;
    this.hub.configure({ available: true, root, buses: this.buses(), targets: settings.loudnessTargets, resetOnPlay: settings.loudnessResetOnPlay });
    const gate = this.hub.tpGateDbfs;
    if (!force && this.keyOf(gate, this.slots()) === this.key) return;
    if (force && this.key !== "") this.host.writer.loudConfig(gate, []);
    this.send(gate);
  }

  /**
   * After a live op (`liveMix.ts`): it configured the hub and sent `LOUD_CONFIG` itself for a meter or target edit, and no
   * other op changes the metered slots or the gate, so the settings it leaves are what the core holds.
   */
  liveApplied(): void {
    this.from = this.host.mixer.audioSettings;
    this.key = this.keyOf(this.hub.tpGateDbfs, this.slots());
  }

  /** Each bus as the hub needs it, from the mixer's settings and the slot table. */
  private buses(): LoudnessBusInfo[] {
    const buses = this.host.buses();
    return this.host.mixer.audioSettings.buses.map((b) => ({ name: b.name, parent: b.parent ?? null, slot: buses.slotOf(b.name), metered: b.meter === "loudness" }));
  }

  /** The metered buses' slots (master implicit; an unplaced or repeated one left out), at most the core's 8. */
  private slots(): number[] {
    const slots: number[] = [];
    for (const b of this.buses()) {
      if (b.parent === null || !b.metered || b.slot < 0 || slots.includes(b.slot)) continue;
      if (slots.length < MAX_LOUDNESS_BUSES) slots.push(b.slot);
    }
    return slots;
  }

  private keyOf(tpGateDbfs: number, slots: readonly number[]): string {
    return `${tpGateDbfs}|${slots.join(",")}`;
  }

  /** `LOUD_CONFIG` (replace-all, asap) with `tpGateDbfs` and the metered slots, in the next batch. */
  private send(tpGateDbfs: number): void {
    if (this.host.disposed()) return;
    const slots = this.slots();
    this.key = this.keyOf(tpGateDbfs, slots);
    this.host.writer.loudConfig(tpGateDbfs, slots);
  }
}
