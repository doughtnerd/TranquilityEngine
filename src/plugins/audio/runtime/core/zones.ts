// The zone manager on main (ADR 0162; api-and-models §1.5, §3.2 "Zone registry", §4.2 ZONE_CONFIG, §4.4; architecture
// §2.2, §3.3, §3.4; C5, OD2, R4, R11, R14, R17). Per frame, in the listener's World only (R14), after Doppler and
// before occlusion:
//
// 1. **Registry.** The World's enabled `AudioReverbZone`s (the first 64; extras are inert with one warning each), each
//    with its world volume cached (`zoneWeights.ts`) and rebuilt when the node's world-matrix version or a shape field
//    changes.
// 2. **Weights and sends.** Per voice that may send (`SpatialViewFlag.SENDS`): its weight in each zone (spatial voices
//    by their position, ambisonic and flat ones by the listener's), normalised over overlaps, and its send
//    `volume × min(4, reverbSend × curve(d)) × weight × wet` (`wet` is the occlusion pass's smoothed wet factor, last
//    frame's) staged into `voiceFx` for the zone slot each zone holds. Each zone's **send energy** sums
//    (`audibility0 × send`)² over mixed voices.
// 3. **Planning** (every 4 frames). Zones with energy, a usable IR and `wet` > 0 are ranked by `priority`, then energy;
//    the top `min(zones.maxActive, slots)` are active. A free place is taken at once; to replace an active zone of the
//    same priority a challenger must have 1.5× its energy for 500 ms of game time; a higher priority replaces at once.
//    A zone left out while the places are full is **faded**: `why` says so and one warning names it.
// 4. **Slots (OD2).** An active zone takes a free core slot once its kernel is resident (the core then fades it in over
//    100 ms). An outranked or silent zone **releases** its slot (state 2: its tail rings out, the standby slot's job on
//    high and default); main frees the slot only when STATUS reads it off. When an active zone needs a slot and none is
//    free (always on low, which has no standby slot), a ringing-out slot is **evicted** (state 3, a 150 ms fade) and
//    the zone waits for it.
// 5. **Kernels.** One kernel per IR (asset or preset, R10), shared by zones using it, prepared through the
//    `ZoneIrService` (the worker sends it to the worklet). The kernel budget is one per core slot (§6); kernels not in a
//    slot stay resident in LRU order while the budget has room. Wanted first: active zones, then zones any voice is in,
//    then zones the listener is within `blendDistance + 20 m` of (proximity preload). A request unanswered after 5 s
//    fails the zone ("IR failed: timed out after 5 s"). The worker unloads a released kernel itself (C2b).
// 6. **ZONE_CONFIG** when the slot table changes, a wet level moves by 0.5 dB, or the shared reverb's return
//    (`1 − the listener's total weight in active zones`) moves by 0.01.
//
// A hard rebuild replays ZONE_CONFIG with the active slots last in the header (C10's order) and re-prepares every
// kernel; the core holds each slot "waiting for kernel" until it is back. With no zone slot laid out (`max_zone_slots`
// 0) nothing here runs, sends or reports, exactly as M2.
import type { AudioSettings } from "../../../../engine/audio/settings";
import { Assets } from "../../../../engine/scene/Assets";
import { AudioReverbZone } from "../AudioReverbZone";
import type { AudioZoneDebug, ZoneIrService } from "../backend";
import { ASAP, MAX_ZONE_SLOTS, writeZoneConfig, ZONE_KERNEL_ID_FIRST, ZONE_KERNEL_ID_LAST, ZoneEvent, ZoneSlotState, ZoneState, type ZoneConfigSlots } from "../wire.generated";
import type { CommandWriter } from "./commandWriter";
import type { StatusMirror } from "./mirror";
import type { ReplayBuilder } from "./replay";
import { SpatialViewFlag, type ListenerFrame, type SpatialVoiceView } from "./spatial";
import type { VoiceFx } from "./voiceFx";
import { makeZoneVolume, normalizeWeights, outsideDistance, sendCurveGain, ZONE_SHAPE_BOX, ZONE_SHAPE_SPHERE, zoneSend, zoneVolumeFromMatrix, zoneWeight, type ZoneVolume } from "./zoneWeights";
import { evalCurve } from "../../../../engine/core/curve";

/** @internal [API §3.2]: live zones per World before extras go inert. */
export const MAX_ZONES_PER_WORLD = 64;
/** @internal [ARCH §3.3]: the active set is re-planned every this many frames. */
export const ZONE_REPLAN_FRAMES = 4;
/** @internal [ARCH §2.2]: a challenger needs this many times the weakest active zone's energy… */
export const ZONE_SWAP_RATIO = 1.5;
/** @internal …for this long (game seconds). */
export const ZONE_SWAP_SECONDS = 0.5;
/** @internal [ARCH §5.3]: kernels are prepared while the listener is within `blendDistance` + this, world units. */
export const ZONE_PRELOAD_MARGIN = 20;
/** @internal [ARCH §5.3]: a kernel not prepared after this long fails the zone, milliseconds. */
export const ZONE_IR_TIMEOUT_MS = 5000;
/** @internal ZONE_CONFIG ramp for `wet` and `sharedReturnGain`, seconds. */
export const ZONE_RAMP_SECONDS = 0.05;
/** @internal A shared-return change smaller than this is not sent. */
const SHARED_EPSILON = 0.01;
/** @internal A wet change smaller than this ratio (0.5 dB) is not sent. */
const WET_RATIO = Math.pow(10, 0.5 / 20);
/** @internal Blocks after a command before an unseen slot is trusted to read off (STATUS staleness margin). */
const UNSEEN_BLOCKS = 4;

/** @internal The zone manager's counters for `Audio.debug()` (§1.6, C24). */
export interface ZoneCounters {
  zonesFaded: number;
  irFailures: number;
  irTruncated: number;
  irPrepares: number;
  kernelRefused: number;
}

/** @internal What the zone manager is built on (the core backend passes its own). */
export interface ZoneManagerDeps {
  readonly writer: Pick<CommandWriter, "zoneConfig">;
  /** Where sends are staged (SET_VOICE_FX). */
  readonly fx: VoiceFx;
  /** IR preparation (C2b's `zoneIr.ts`). */
  readonly irs: ZoneIrService;
  /** STATUS `zones` and `zoneEvents` (slot states, refusals). */
  readonly mirror: StatusMirror;
  /** The slots the core laid out (`max_zone_slots`, 0..4) and the longest IR in seconds. */
  readonly maxZoneSlots: number;
  readonly zoneMaxSeconds: number;
  /** The context's rate (kernels are prepared at it). Default 48,000. */
  readonly sampleRate?: number;
  /** Per voice slot: the occlusion pass's smoothed wet factor (`OcclusionPass.wet`, 1 open). Default: 1 for all. */
  readonly wet?: ArrayLike<number>;
  /** Milliseconds, for the IR timeout. Default `performance.now`. */
  readonly now?: () => number;
  /** Warnings (a faded zone, extra zones, an unknown output bus). Default `console.warn`. */
  readonly warn?: (message: string) => void;
  /** An IR asset's URL. Default `Assets.url`. */
  readonly url?: (path: string) => string;
}

type KernelState = "pending" | "ready" | "failed";

/** One kernel main knows of (one per IR key). */
interface Kernel {
  readonly key: string;
  /** The clip id while held (0 once released or failed). */
  id: number;
  readonly assetUrl?: string;
  readonly preset?: string;
  readonly label: string;
  state: KernelState;
  frames: number;
  truncated: boolean;
  prepareMs: number;
  requestedAt: number;
  message: string;
  /** Frame number of the last frame a zone in play used it (LRU). */
  lastUsed: number;
}

/** One zone of the registry. */
interface Zone {
  readonly comp: AudioReverbZone;
  readonly volume: ZoneVolume;
  /** Cache keys of the volume: world-matrix version and the shape fields. */
  version: number;
  shapeKey: string;
  kernel: Kernel | null;
  energy: number;
  /** The listener's normalised weight in it. */
  listenerWeight: number;
  /** The listener's distance outside it. */
  listenerOutside: number;
  /** Some voice had weight in it this frame. */
  touched: boolean;
  winner: boolean;
  /** Game seconds the best challenger has beaten this (weakest) active zone. */
  challenge: number;
  /** The core slot it holds, -1 none. */
  slot: number;
  rank: number;
  why: string;
  /** A fade warning was logged since the zone last held a slot. */
  warned: boolean;
  /** Frame last seen in the World. */
  seen: number;
}

const enum Phase {
  Free = 0,
  /** Sent state 1 (waiting, fading in or active in the core). */
  Active = 1,
  /** Sent state 2: sends ignored, the tail rings out. */
  Release = 2,
  /** Sent state 3: a 150 ms fade, then off. */
  Evict = 3,
  /** The core refused it: free once STATUS reads the slot off. */
  WaitOff = 4,
}

/** One core slot as main sees it. */
interface Slot {
  phase: Phase;
  zone: Zone | null;
  kernelId: number;
  irFrames: number;
  returnBus: number;
  wet: number;
  /** STATUS showed `kernelId` in this slot since it was assigned. */
  seenKernel: boolean;
  /** `mirror.blocks` when the slot's last command was staged. */
  sentBlocks: number;
}

const presetLabel = (p: string) => `preset ${p}`;

/** @internal The scene's zones, voice sends, the slot table and IR states (constructed by the core backend). */
export class ZoneManager {
  readonly counters: ZoneCounters = { zonesFaded: 0, irFailures: 0, irTruncated: 0, irPrepares: 0, kernelRefused: 0 };

  private readonly zones: Zone[] = [];
  private readonly byComp = new Map<AudioReverbZone, Zone>();
  private readonly kernels = new Map<string, Kernel>();
  private readonly byId = new Map<number, Kernel>();
  private readonly slots: Slot[] = [];
  private readonly warnedExtra = new WeakSet<AudioReverbZone>();
  private readonly warnedBus = new Set<string>();
  /** Per zone index: this voice's weights, then its sends. */
  private readonly w = new Float32Array(MAX_ZONES_PER_WORLD);
  private readonly s = new Float32Array(MAX_ZONES_PER_WORLD);
  private readonly lw = new Float32Array(MAX_ZONES_PER_WORLD);
  /** Per core slot: the index in `zones` of the zone whose sends it takes this frame, -1 none. */
  private readonly slotZone = new Int16Array(MAX_ZONE_SLOTS);
  private frameNo = 0;
  private sinceReplan = 0;
  private replanDt = 0;
  private rate: number;
  /** Active places the core's load ladder took away (refusedSlot), for the session. */
  private shed = 0;
  private maxActive = 0;
  /** The last ZONE_CONFIG sent. */
  private sentShared = 1;
  private readonly sentSlots: ZoneConfigSlots[] = [];
  private configDirty = false;
  private shared = 1;
  /** `contextReplaced` already asked for every kernel again (the replay that follows doesn't). */
  private reprepared = false;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly url: (path: string) => string;
  private readonly config: ZoneConfigSlots[] = [];

  constructor(readonly deps: ZoneManagerDeps) {
    this.rate = deps.sampleRate && deps.sampleRate > 0 ? deps.sampleRate : 48_000;
    this.now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.warn = deps.warn ?? ((m) => console.warn(`[myco] ${m}`));
    this.url = deps.url ?? ((p) => Assets.url(p));
    const n = Math.max(0, Math.min(MAX_ZONE_SLOTS, deps.maxZoneSlots | 0));
    for (let k = 0; k < n; k++) {
      this.slots.push({ phase: Phase.Free, zone: null, kernelId: 0, irFrames: 0, returnBus: 0, wet: 0, seenKernel: false, sentBlocks: 0 });
      this.config.push({ kernelId: 0, returnBus: 0, state: 0, reserved: 0, wet: 0, irFrames: 0 });
      this.sentSlots.push({ kernelId: 0, returnBus: 0, state: 0, reserved: 0, wet: 0, irFrames: 0 });
    }
    if (n > 0) {
      deps.irs.onPrepared = (e) => this.onPrepared(e.kernelId, e.frames, e.truncated, e.prepareMs);
      deps.irs.onFailed = (e) => this.onFailed(e.kernelId, e.message);
    }
  }

  /** The core slots laid out. */
  get slotCount(): number {
    return this.slots.length;
  }

  /**
   * The frame step: zones of `frame.world`, weights and sends for `view`'s voices into `deps.fx`, the active set, the
   * slots, kernels, and ZONE_CONFIG on change.
   */
  run(frame: ListenerFrame, view: SpatialVoiceView, settings: Pick<AudioSettings, "zones" | "buses">): void {
    if (this.slots.length === 0) return;
    this.frameNo++;
    this.maxActive = Math.max(0, Math.min(settings.zones.maxActive | 0, this.slots.length) - this.shed);
    this.syncRegistry(frame, settings);
    this.drainEvents();
    this.listenerWeights(frame);
    this.voiceSends(frame, view);
    this.replanDt += frame.dt;
    if (++this.sinceReplan >= ZONE_REPLAN_FRAMES) {
      this.plan(this.replanDt);
      this.sinceReplan = 0;
      this.replanDt = 0;
    }
    this.trackSlots();
    this.assignSlots();
    this.requestKernels();
    this.checkTimeouts();
    this.stageConfig();
  }

  /** Slot `i` was freed: nothing is kept per voice (its sends go with `voiceFx.forget`). */
  forget(i: number): void {
    void i;
  }

  /** A hard rebuild: ZONE_CONFIG with the active slots, last in the header (C10); every kernel is asked for again. */
  replay(b: ReplayBuilder): void {
    if (this.slots.length === 0) return;
    // Tails are lost in the rebuild's gap: releasing and evicting slots are simply free in the new core.
    for (const slot of this.slots) {
      if (slot.phase !== Phase.Active) this.freeSlot(slot);
      else {
        slot.seenKernel = false;
        slot.sentBlocks = this.deps.mirror.blocks;
      }
    }
    if (!this.reprepared) this.reprepare();
    this.reprepared = false;
    this.buildConfig();
    const n = this.config.length;
    const slots = this.config;
    const shared = this.shared;
    b.record(24 + 16 * n, (view, off) => writeZoneConfig(view, off, { voiceId: 0, frameOffset: ASAP, sharedReturnGain: shared, rampFrames: 0, slots }));
    this.remember();
  }

  /** The context's rate changed (a rebuild into a new context): every wanted kernel is prepared again at `rate`. */
  contextReplaced(rate: number): void {
    if (rate > 0) this.rate = rate;
    if (this.slots.length === 0) {
      this.deps.irs.reprepareAll?.(rate);
      return;
    }
    this.reprepare();
    this.reprepared = true;
  }

  /** `AudioDebugInfo.zones` (§1.6); undefined while no zone slot is laid out. */
  debug(): AudioZoneDebug[] | undefined {
    if (this.slots.length === 0) return undefined;
    const states = ["off", "waiting for kernel", "fading in", "active", "ringing out", "evicting"];
    const m = this.deps.mirror;
    return this.zones.map((z) => {
      const k = z.kernel;
      let state = "declared";
      if (z.slot >= 0) state = z.slot < m.zoneCount && m.zoneKernel[z.slot] === this.slots[z.slot]!.kernelId ? (states[m.zoneState[z.slot]!] ?? "off") : "assigned";
      else if (k) state = k.state === "ready" ? "prepared" : k.state === "pending" ? "preparing" : "failed";
      return {
        node: z.comp.node.name,
        world: z.comp.node.world.name ?? null,
        slot: z.slot,
        state,
        ir: z.comp.ir || z.comp.preset,
        irSeconds: k && k.state === "ready" ? k.frames / this.rate : 0,
        kernelKB: k && k.state === "ready" ? Math.ceil(kernelBytes(k.frames) / 1024) : 0,
        prepareMs: k?.prepareMs ?? 0,
        by: "worker",
        sendEnergy: z.energy,
        rank: z.rank,
        why: z.why,
      };
    });
  }

  dispose(): void {
    this.deps.irs.dispose?.();
  }

  // --- the frame's stages -------------------------------------------------------------------

  private syncRegistry(frame: ListenerFrame, settings: Pick<AudioSettings, "buses">): void {
    const world = frame.world;
    const stamp = this.frameNo;
    if (settings.buses !== this.busSource) {
      this.busSource = settings.buses;
      this.busNames = settings.buses.map((b) => b.name);
    }
    if (world) {
      let live = 0;
      for (const comp of world._componentsOfType(AudioReverbZone)) {
        if (!comp.isActiveAndEnabled) continue;
        if (live >= MAX_ZONES_PER_WORLD) {
          if (!this.warnedExtra.has(comp)) {
            this.warnedExtra.add(comp);
            this.warn(`Reverb zone "${comp.node.name}" is inert: a World holds at most ${MAX_ZONES_PER_WORLD} zones (ADR 0162).`);
          }
          continue;
        }
        live++;
        let z = this.byComp.get(comp);
        if (!z) {
          z = { comp, volume: makeZoneVolume(), version: -1, shapeKey: "", kernel: null, energy: 0, listenerWeight: 0, listenerOutside: Infinity, touched: false, winner: false, challenge: 0, slot: -1, rank: 0, why: "", warned: false, seen: 0 };
          this.byComp.set(comp, z);
          this.zones.push(z);
        }
        z.seen = stamp;
        this.refreshVolume(z);
        this.refreshKernel(z);
      }
    }
    // Zones gone from the World (removed, disabled, another World now has the listener).
    for (let n = this.zones.length - 1; n >= 0; n--) {
      const z = this.zones[n]!;
      if (z.seen === stamp) continue;
      if (z.slot >= 0) this.releaseSlot(this.slots[z.slot]!);
      this.zones.splice(n, 1);
      this.byComp.delete(z.comp);
    }
  }

  private refreshVolume(z: Zone): void {
    const c = z.comp;
    const node = c.node;
    const e = node.entity;
    const world = node.world;
    const version = world.tVersion[e] ?? 0;
    const shape = c.shape === "sphere" ? ZONE_SHAPE_SPHERE : ZONE_SHAPE_BOX;
    const key = `${shape},${c.center.x},${c.center.y},${c.center.z},${c.size.x},${c.size.y},${c.size.z},${c.radius}`;
    if (version === z.version && key === z.shapeKey) return;
    z.version = version;
    z.shapeKey = key;
    if (world.hasTransform[e]) zoneVolumeFromMatrix(z.volume, world.worldMatrix(e), e * 16, shape, c.center.x, c.center.y, c.center.z, c.size.x, c.size.y, c.size.z, c.radius);
    else zoneVolumeFromMatrix(z.volume, IDENTITY, 0, shape, c.center.x, c.center.y, c.center.z, c.size.x, c.size.y, c.size.z, c.radius);
  }

  /** The zone's kernel for its IR (asset or preset); a changed IR moves it to another kernel. */
  private refreshKernel(z: Zone): void {
    const c = z.comp;
    const key = c.ir ? `asset:${c.ir}` : `preset:${c.preset}`;
    if (z.kernel?.key === key) return;
    let k = this.kernels.get(key);
    if (!k) {
      k = c.ir
        ? { key, id: 0, assetUrl: this.url(c.ir), label: c.ir, state: "pending", frames: 0, truncated: false, prepareMs: 0, requestedAt: 0, message: "", lastUsed: 0 }
        : { key, id: 0, preset: c.preset, label: presetLabel(c.preset), state: "pending", frames: 0, truncated: false, prepareMs: 0, requestedAt: 0, message: "", lastUsed: 0 };
      this.kernels.set(key, k);
    }
    // An asset that failed before is tried again when the zone's IR changes to it (Failed → Declared).
    if (k.state === "failed" && z.kernel !== null) {
      k.state = "pending";
      k.message = "";
    }
    z.kernel = k;
    // A slot holding the old kernel can't change kernel in place: release it; the zone takes a slot again later.
    if (z.slot >= 0) this.releaseSlot(this.slots[z.slot]!);
  }

  private drainEvents(): void {
    this.deps.mirror.drainZoneEvents(this.eventSink);
  }

  private readonly eventSink = {
    event: (slotIndex: number, code: number): void => {
      const slot = this.slots[slotIndex];
      if (code === ZoneEvent.RefusedKernel) {
        this.counters.kernelRefused++;
        if (slot && slot.phase === Phase.Active && !slot.seenKernel) {
          const z = slot.zone;
          this.detach(slot);
          slot.phase = Phase.WaitOff;
          slot.sentBlocks = this.deps.mirror.blocks;
          if (z) z.why = "kernel refused: the slot was busy";
        }
      } else if (code === ZoneEvent.RefusedSlot) {
        // The core's load ladder allows one active zone fewer (its step 2): follow it for the session.
        if (slot && slot.phase === Phase.Active) {
          const z = slot.zone;
          this.freeSlot(slot);
          if (z) z.why = "faded: the core shed a reverb under load";
        }
        this.shed = Math.min(this.slots.length, this.shed + 1);
      } else if (code === ZoneEvent.BadBlob) {
        const k = slot ? this.byId.get(slot.kernelId) : undefined;
        if (k) this.fail(k, "the prepared kernel didn't fit the slot");
      }
    },
  };

  private listenerWeights(frame: ListenerFrame): void {
    const n = this.zones.length;
    const lw = this.lw;
    for (let z = 0; z < n; z++) {
      const zone = this.zones[z]!;
      const d = outsideDistance(zone.volume, frame.posX, frame.posY, frame.posZ);
      zone.listenerOutside = d;
      lw[z] = zoneWeight(d, zone.comp.blendDistance);
      zone.energy = 0;
      zone.touched = false;
    }
    normalizeWeights(lw, n);
    let sum = 0;
    for (let z = 0; z < n; z++) {
      const zone = this.zones[z]!;
      zone.listenerWeight = lw[z]!;
      if (zone.slot >= 0 && this.slots[zone.slot]!.phase === Phase.Active) sum += lw[z]! * lw[z]!;
    }
    this.shared = 1 - Math.min(1, Math.sqrt(sum));
  }

  private voiceSends(frame: ListenerFrame, view: SpatialVoiceView): void {
    const fx = this.deps.fx;
    const wetIn = this.deps.wet;
    const n = this.zones.length;
    const w = this.w;
    const s = this.s;
    const slots = this.slots;
    const nk = slots.length;
    const slotZone = this.slotZone;
    for (let k = 0; k < nk; k++) {
      const slot = slots[k]!;
      slotZone[k] = slot.phase === Phase.Active && slot.zone ? this.zones.indexOf(slot.zone) : -1;
    }
    for (let v = 0; v < view.count; v++) {
      const i = view.slots[v]!;
      const flags = view.viewFlags[i]!;
      if ((flags & SpatialViewFlag.SENDS) === 0 || view.world[i] !== frame.worldKey || n === 0) {
        for (let k = 0; k < nk; k++) if (fx.send(i, k) !== 0) fx.setSend(i, k, 0);
        continue;
      }
      const curve = view.curves.get(view.sendCurve[i]!);
      let gain: number;
      if ((flags & SpatialViewFlag.SPATIAL) !== 0 && (flags & SpatialViewFlag.AMBISONIC) === 0) {
        const x = view.posX[i]!, y = view.posY[i]!, zz = view.posZ[i]!;
        for (let z = 0; z < n; z++) {
          const zone = this.zones[z]!;
          w[z] = zoneWeight(outsideDistance(zone.volume, x, y, zz), zone.comp.blendDistance);
        }
        normalizeWeights(w, n);
        const d = Math.hypot(x - frame.posX, y - frame.posY, zz - frame.posZ);
        gain = sendCurveGain(curve, d, view.minDist[i]!, view.maxDist[i]!);
      } else {
        // Ambisonic and flat voices use the listener's weights; the curve at its near end.
        for (let z = 0; z < n; z++) w[z] = this.lw[z]!;
        gain = evalCurve(curve, 0);
      }
      const wet = wetIn ? (wetIn[i] ?? 1) : 1;
      const mixed = (flags & SpatialViewFlag.MIXED) !== 0;
      const aud = view.audibility0[i]!;
      for (let z = 0; z < n; z++) {
        const wz = w[z]!;
        if (wz <= 0) {
          s[z] = 0;
          continue;
        }
        const zone = this.zones[z]!;
        const send = zoneSend(view.volume[i]!, view.reverbSend[i]!, gain, wz, wet);
        s[z] = send;
        zone.touched = true;
        if (mixed) {
          const e = aud * send;
          zone.energy += e * e;
        }
      }
      for (let k = 0; k < nk; k++) {
        const z = slotZone[k]!;
        const level = z >= 0 ? s[z]! : 0;
        if (fx.send(i, k) !== level) fx.setSend(i, k, level);
      }
    }
  }

  /** The active set: ranking, hysteresis, faded zones. */
  private plan(dt: number): void {
    const zones = this.zones;
    for (const z of zones) {
      const k = z.kernel;
      if (k && k.state === "failed") z.why = `IR failed: ${k.message}`;
      else if (!(z.comp.wet > 0)) z.why = "wet 0";
      else if (z.energy <= 0) z.why = "no sources inside";
      else z.why = "";
    }
    const eligible = (z: Zone) => z.why === "";
    // Winners that lost their energy or their IR drop out.
    for (const z of zones) if (z.winner && !eligible(z)) z.winner = false;
    const better = (a: Zone, b: Zone) => (a.comp.priority !== b.comp.priority ? a.comp.priority - b.comp.priority : a.energy - b.energy);
    const ranked = zones.filter(eligible).sort((a, b) => better(b, a));
    ranked.forEach((z, r) => (z.rank = r + 1));
    for (const z of zones) if (!eligible(z)) z.rank = 0;
    let winners = ranked.filter((z) => z.winner).length;
    // Free places are taken at once, best first.
    for (const z of ranked) {
      if (winners >= this.maxActive) break;
      if (!z.winner) {
        z.winner = true;
        z.challenge = 0;
        winners++;
      }
    }
    while (winners > this.maxActive) {
      const weakest = ranked.filter((z) => z.winner).pop()!;
      weakest.winner = false;
      winners--;
    }
    // One challenge per replan: the best loser against the weakest winner.
    const challenger = ranked.find((z) => !z.winner);
    const actives = ranked.filter((z) => z.winner);
    const weakest = actives[actives.length - 1];
    if (challenger && weakest) {
      const p = challenger.comp.priority - weakest.comp.priority;
      if (p > 0) this.swap(challenger, weakest);
      else if (p === 0 && challenger.energy > ZONE_SWAP_RATIO * weakest.energy) {
        weakest.challenge += dt;
        if (weakest.challenge >= ZONE_SWAP_SECONDS) this.swap(challenger, weakest);
      } else weakest.challenge = 0;
    } else if (weakest) weakest.challenge = 0;
    // Faded: eligible but left out while the places are full.
    for (const z of ranked) {
      if (z.winner) continue;
      z.why = `faded: preset has ${this.maxActive} reverb${this.maxActive === 1 ? "" : "s"}`;
      if (!z.warned) {
        z.warned = true;
        this.counters.zonesFaded++;
        this.warn(`Reverb zone "${z.comp.node.name}" faded: ${this.maxActive} zone reverb${this.maxActive === 1 ? " is" : "s are"} in use (audio.zones.maxActive; ADR 0162).`);
      }
    }
  }

  private swap(win: Zone, lose: Zone): void {
    win.winner = true;
    win.challenge = 0;
    lose.winner = false;
    lose.challenge = 0;
  }

  /** Slots whose release or eviction finished (STATUS reads them off) become free. */
  private trackSlots(): void {
    const m = this.deps.mirror;
    for (let k = 0; k < this.slots.length; k++) {
      const slot = this.slots[k]!;
      if (slot.phase === Phase.Free) continue;
      const kernelThere = k < m.zoneCount ? m.zoneKernel[k]! : 0;
      const stateThere = k < m.zoneCount ? m.zoneState[k]! : ZoneState.Off;
      if (slot.kernelId !== 0 && kernelThere === slot.kernelId) slot.seenKernel = true;
      const settled = m.blocks - slot.sentBlocks >= UNSEEN_BLOCKS;
      if (slot.phase === Phase.WaitOff) {
        if (stateThere === ZoneState.Off && settled) this.freeSlot(slot);
        continue;
      }
      if (slot.phase === Phase.Release || slot.phase === Phase.Evict) {
        if (kernelThere !== slot.kernelId && (slot.seenKernel || settled)) this.freeSlot(slot);
      }
    }
  }

  private assignSlots(): void {
    const settingsBus = this.busOf;
    // Losers holding an active slot release it (their tail rings out).
    for (const slot of this.slots) {
      if (slot.phase === Phase.Active && slot.zone && !slot.zone.winner) this.releaseSlot(slot);
    }
    for (const z of this.zones) {
      if (!z.winner) continue;
      if (z.slot >= 0) {
        const slot = this.slots[z.slot]!;
        if (slot.phase === Phase.Release || slot.phase === Phase.Evict) {
          // Ranks again before the slot is freed: active again in place.
          slot.phase = Phase.Active;
          slot.sentBlocks = this.deps.mirror.blocks;
          this.configDirty = true;
        }
        if (slot.phase === Phase.Active) {
          const wet = clampWet(z.comp.wet);
          const bus = settingsBus(z.comp.output);
          if (wet !== slot.wet || bus !== slot.returnBus) {
            slot.wet = wet;
            slot.returnBus = bus;
          }
        }
        continue;
      }
      const free = this.slots.find((s) => s.phase === Phase.Free && this.offInCore(s));
      const k = z.kernel;
      if (free && k && k.state === "ready" && k.id !== 0) {
        free.phase = Phase.Active;
        free.zone = z;
        free.kernelId = k.id;
        free.irFrames = k.frames;
        free.wet = clampWet(z.comp.wet);
        free.returnBus = settingsBus(z.comp.output);
        free.seenKernel = false;
        free.sentBlocks = this.deps.mirror.blocks;
        z.slot = this.slots.indexOf(free);
        z.warned = false;
        this.configDirty = true;
        continue;
      }
      if (!free) {
        // No free slot: evict a ringing-out one (low has no standby slot) and wait for it.
        const ringing = this.slots.find((s) => s.phase === Phase.Release);
        if (ringing) {
          ringing.phase = Phase.Evict;
          ringing.sentBlocks = this.deps.mirror.blocks;
          this.configDirty = true;
        }
      }
    }
  }

  /** Kernels wanted, in order, within the budget (one per slot); LRU kernels outside every slot make room. */
  private requestKernels(): void {
    const frameNo = this.frameNo;
    const wanted: Kernel[] = [];
    const add = (k: Kernel | null) => {
      if (k && k.state !== "failed" && !wanted.includes(k)) wanted.push(k);
    };
    for (const z of this.zones) if (z.winner) add(z.kernel);
    for (const z of this.zones) if (z.touched) add(z.kernel);
    const near = this.zones.filter((z) => !z.winner && !z.touched && z.listenerOutside <= Math.max(0, z.comp.blendDistance) + ZONE_PRELOAD_MARGIN);
    near.sort((a, b) => a.listenerOutside - b.listenerOutside);
    for (const z of near) add(z.kernel);
    for (const k of wanted) k.lastUsed = frameNo;
    for (const s of this.slots) {
      const held = s.phase !== Phase.Free ? this.byId.get(s.kernelId) : undefined;
      if (held) held.lastUsed = frameNo;
    }
    const budget = this.slots.length;
    for (let n = 0; n < wanted.length; n++) {
      const k = wanted[n]!;
      if (k.id !== 0) continue;
      if (this.byId.size >= budget && !this.evictLru(wanted, n)) break;
      this.request(k);
    }
  }

  /**
   * Releases the least recently used kernel that no slot holds and that isn't wanted ahead of `wanted[upTo]` (wants are
   * in priority order: active zones, zones with voices, nearby zones); false if none can go.
   */
  private evictLru(wanted: readonly Kernel[], upTo: number): boolean {
    let victim: Kernel | null = null;
    for (const k of this.byId.values()) {
      if (this.slots.some((s) => s.phase !== Phase.Free && s.kernelId === k.id)) continue;
      const at = wanted.indexOf(k);
      if (at >= 0 && at < upTo) continue;
      if (!victim || k.lastUsed < victim.lastUsed || (k.lastUsed === victim.lastUsed && wanted.indexOf(victim) >= 0 && at < 0)) victim = k;
    }
    if (!victim) return false;
    this.releaseKernel(victim);
    return true;
  }

  private request(k: Kernel): void {
    const id = this.allocId();
    if (id === 0) return;
    k.id = id;
    k.state = "pending";
    k.requestedAt = this.now();
    this.byId.set(id, k);
    const maxFrames = Math.max(1, Math.round(this.deps.zoneMaxSeconds * this.rate));
    this.deps.irs.prepare(k.assetUrl !== undefined ? { kernelId: id, assetUrl: k.assetUrl, contextRate: this.rate, maxFrames } : { kernelId: id, preset: k.preset, contextRate: this.rate, maxFrames });
  }

  private allocId(): number {
    for (let id = ZONE_KERNEL_ID_FIRST; id <= ZONE_KERNEL_ID_LAST; id++) if (!this.byId.has(id)) return id;
    return 0;
  }

  /** The kernel leaves the budget (the worker unloads it from the worklet itself). */
  private releaseKernel(k: Kernel): void {
    if (k.id === 0) return;
    this.byId.delete(k.id);
    this.deps.irs.release(k.id);
    k.id = 0;
    if (k.state !== "failed") k.state = "pending";
  }

  private fail(k: Kernel, message: string): void {
    this.counters.irFailures++;
    k.message = message;
    for (const s of this.slots) if (s.phase !== Phase.Free && s.kernelId === k.id && s.kernelId !== 0) this.releaseSlot(s);
    this.releaseKernel(k);
    k.state = "failed";
    for (const z of this.zones) if (z.kernel === k) {
      z.winner = false;
      z.why = `IR failed: ${message}`;
    }
  }

  private checkTimeouts(): void {
    const t = this.now();
    for (const k of this.byId.values()) {
      if (k.state === "pending" && t - k.requestedAt > ZONE_IR_TIMEOUT_MS) this.fail(k, `timed out after ${ZONE_IR_TIMEOUT_MS / 1000} s`);
    }
  }

  private onPrepared(kernelId: number, frames: number, truncated: boolean, prepareMs: number): void {
    const k = this.byId.get(kernelId);
    if (!k || k.state === "failed") return;
    if (k.state === "pending") {
      this.counters.irPrepares++;
      if (truncated) this.counters.irTruncated++;
    }
    k.state = "ready";
    k.frames = frames;
    k.truncated = truncated;
    if (prepareMs > 0) k.prepareMs = prepareMs;
    for (const s of this.slots) if (s.phase !== Phase.Free && s.kernelId === kernelId && s.irFrames !== frames) {
      s.irFrames = frames;
      this.configDirty = true;
    }
  }

  private onFailed(kernelId: number, message: string): void {
    const k = this.byId.get(kernelId);
    if (!k || k.state === "failed") return;
    this.fail(k, message);
  }

  /** Every held kernel is asked for again at `this.rate` (a new context or core). */
  private reprepare(): void {
    const t = this.now();
    for (const k of this.byId.values()) {
      if (k.state === "failed") continue;
      k.state = "pending";
      k.requestedAt = t;
    }
    this.deps.irs.reprepareAll?.(this.rate);
  }

  // --- slots ------------------------------------------------------------------------------

  private offInCore(s: Slot): boolean {
    const k = this.slots.indexOf(s);
    const m = this.deps.mirror;
    return k >= m.zoneCount || m.zoneState[k] === ZoneState.Off;
  }

  private releaseSlot(slot: Slot): void {
    if (slot.phase !== Phase.Active) return;
    slot.phase = Phase.Release;
    slot.sentBlocks = this.deps.mirror.blocks;
    this.detach(slot);
    this.configDirty = true;
  }

  /** The slot's zone no longer holds it (the slot itself may still ring out). */
  private detach(slot: Slot): void {
    if (slot.zone) {
      slot.zone.slot = -1;
      slot.zone = null;
    }
  }

  private freeSlot(slot: Slot): void {
    this.detach(slot);
    slot.phase = Phase.Free;
    slot.kernelId = 0;
    slot.irFrames = 0;
    slot.wet = 0;
    slot.seenKernel = false;
    this.configDirty = true;
  }

  /** The bus names for `output` (index = BUS_CONFIG's order, `audio.buses`), refreshed when the list changes. */
  private busNames: readonly string[] = [];
  private busSource: unknown = null;
  private busOf = (name: string): number => {
    if (name === "") return 0;
    const b = this.busNames.indexOf(name);
    if (b >= 0) return b;
    if (!this.warnedBus.has(name)) {
      this.warnedBus.add(name);
      this.warn(`A reverb zone returns to bus "${name}", which doesn't exist; it returns to Master (ADR 0162).`);
    }
    return 0;
  };

  // --- ZONE_CONFIG ------------------------------------------------------------------------

  private buildConfig(): void {
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[k]!;
      const c = this.config[k]!;
      const off = s.phase === Phase.Free || s.phase === Phase.WaitOff;
      c.kernelId = off ? 0 : s.kernelId;
      c.returnBus = off ? 0 : s.returnBus;
      c.state = off ? 0 : s.phase === Phase.Active ? ZoneSlotState.Active : s.phase === Phase.Release ? ZoneSlotState.Release : ZoneSlotState.Evict;
      c.wet = off ? 0 : s.wet;
      c.irFrames = off ? 0 : s.irFrames;
    }
  }

  private remember(): void {
    for (let k = 0; k < this.config.length; k++) Object.assign(this.sentSlots[k]!, this.config[k]!);
    this.sentShared = this.shared;
    this.configDirty = false;
  }

  private stageConfig(): void {
    this.buildConfig();
    let changed = this.configDirty || Math.abs(this.shared - this.sentShared) > SHARED_EPSILON || (this.shared !== this.sentShared && (this.shared === 1 || this.shared === 0));
    for (let k = 0; k < this.config.length && !changed; k++) {
      const a = this.config[k]!, b = this.sentSlots[k]!;
      if (a.kernelId !== b.kernelId || a.state !== b.state || a.returnBus !== b.returnBus || a.irFrames !== b.irFrames) changed = true;
      else if (a.wet !== b.wet && (b.wet === 0 || a.wet === 0 || a.wet / b.wet > WET_RATIO || b.wet / a.wet > WET_RATIO)) changed = true;
    }
    if (!changed) return;
    this.deps.writer.zoneConfig(this.shared, Math.round(ZONE_RAMP_SECONDS * this.rate), this.config);
    this.remember();
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const clampWet = (w: number): number => (Number.isFinite(w) ? Math.min(2, Math.max(0, w)) : 0);

/** Bytes of a prepared kernel (`zones.rs` `kernel_blob_bytes`): header, two channels of head and tail spectra. */
export function kernelBytes(frames: number): number {
  const head = Math.min(32, Math.ceil(frames / 128));
  const tail = Math.ceil(Math.max(0, frames - 32 * 128) / 2048);
  return 32 + 2 * head * 128 * 8 + 2 * tail * 2048 * 8;
}
