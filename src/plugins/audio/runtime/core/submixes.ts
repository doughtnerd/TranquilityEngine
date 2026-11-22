// ADR 0331 (ABI 4.5): instance submixes on the core backend. Main owns the pool: `settings.voices.submixes` slots (default
// 32), clamped to the core's `SUBMIXES_MAX`. `open` gives an instance group a slot and sends its SUBMIX (group, output
// bus, insert chain) before the instance's first PLAY, so the core routes the group's voices on that bus into the slot;
// `close` frees it (SUBMIX with no effects) when the group is given back. A full pool refuses: the caller plays the
// instance without its chain (the playlist runtime falls back to mapping filters and gain onto each voice), and the
// refusal is warned once and marked in a running capture (a MARKER: the capture format has no submix kind yet).
//
// The chain is the catalogue's effects (`effects/catalogue.ts`) as the core's `SUBMIX_FX_*` kinds, parameters in the
// catalogue's order with its defaults filled in (`effectKinds.ts`, the one table the bus chains share). Since ABI 4.6
// the core runs every type `CORE_EFFECT_TYPES` lists but the sidechain compressor (a bus effect: an instance has no key
// bus); any other kind passes through. Disabled effects are sent bypassed.
//
// Replay: after a rebuild's RESET the slots in use are sent again (session phase `replayHeader`, before the voices), and
// a new bus tree re-sends them with their buses' new indices (`busesReset`).
import type { Effect } from "../../../../engine/audio/effects/types";
import {
  AUTO_TARGET_FX, AUTO_TARGET_LOG, AUTO_TARGET_PARAM_SHIFT, AUTO_TARGET_SLOT_SHIFT, AUTOMATE_BINDINGS_FIXED_END, BUS_AUTOMATE_MAX_BINDINGS, SUBMIX_EFFECTS_MAX,
  SUBMIX_FIXED_END, SUBMIX_EFFECTS_FIXED_END, SUBMIX_FX_ON, SUBMIXES_MAX, ASAP, writeSubmix, writeSubmixAutomate, type AutomateBindings, type SubmixEffects,
} from "../wire.generated";
import type { SubmixLane } from "../backend";
import { AUTOMATION_GLOBAL, AUTOMATION_TIME } from "./commandWriter";
import { FX_KINDS, fxKind, fxParams } from "./effectKinds";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";
import type { SendGate } from "./session";

/** The default pool when the settings name none (ADR 0331). */
export const DEFAULT_SUBMIXES = 32;

/** The core's kind for each catalogue effect type it runs (`effectKinds.ts`; any other type is sent as passthrough, 0). */
export const SUBMIX_KINDS: Readonly<Record<string, number>> = FX_KINDS;

/** What the pool needs of the core backend. */
export interface CoreSubmixesHost {
  readonly writer: Pick<CommandWriter, "submix"> & Partial<Pick<CommandWriter, "submixAutomate">>;
  readonly session: SendGate;
  /** The pool size the settings ask for (`settings.voices.submixes`; undefined: the default). */
  poolSize(): number | undefined;
  busIndex(name: string): number;
  profile(): ProfileSink;
  warnOnce(key: string, message: string): void;
}

interface Slot {
  group: number;
  bus: string;
  effects: SubmixEffects[];
  /** The effects' ids, in chain order (what `SubmixLane.effect` names). */
  ids: string[];
  /** ABI 4.8: the slot's parameter automation as written (SUBMIX_AUTOMATE). */
  bindings: AutomateBindings[];
}

/** The catalogue effect `e` as a SUBMIX effect: its kind, bypass flag and parameters in the catalogue's order. */
export function submixEffect(e: Effect): SubmixEffects {
  return { type: fxKind(e.type), flags: e.on ? SUBMIX_FX_ON : 0, p: fxParams(e.type, e.params, 8) };
}

/** ADR 0331: the core backend's instance submix pool. */
export class CoreSubmixes {
  private readonly slots: (Slot | null)[] = new Array(SUBMIXES_MAX).fill(null);
  private readonly byGroup = new Map<number, number>();
  /** Refusals since start (debug). */
  refused = 0;

  constructor(private readonly host: CoreSubmixesHost) {}

  /** The pool's size now: the settings' (default 32), clamped to the core's slots. */
  get capacity(): number {
    const n = this.host.poolSize();
    const want = n === undefined || !Number.isFinite(n) ? DEFAULT_SUBMIXES : Math.floor(n);
    return Math.max(0, Math.min(SUBMIXES_MAX, want));
  }

  /** Slots in use. */
  get size(): number {
    return this.byGroup.size;
  }

  /**
   * Gives instance `group` (1..1024) a submix feeding `bus` that runs `effects` (an instance already holding one has it
   * reconfigured). False when the pool is full (or set to 0): the instance plays without its chain. `where` names the
   * instance in the warning and the capture's marker.
   */
  open(group: number, bus: string, effects: readonly Effect[], where: string): boolean {
    if (!Number.isInteger(group) || group < 1 || group > 1024) return false;
    let index = this.byGroup.get(group);
    if (index === undefined) {
      const cap = this.capacity;
      index = this.slots.findIndex((s, i) => s === null && i < cap);
      if (index < 0) {
        this.refused++;
        this.host.warnOnce(`submix-full:${where}`, `audio: "${where}" plays without its effects: every instance submix (settings.voices.submixes: ${cap}) is in use (ADR 0331).`);
        const profile = this.host.profile();
        if (profile !== NULL_PROFILE_SINK) profile.marker(`submix refused: ${where} (pool of ${cap} full)`);
        return false;
      }
      this.byGroup.set(group, index);
    }
    const kept = effects.slice(0, SUBMIX_EFFECTS_MAX);
    // A reconfigured instance keeps its automation while its chain keeps the effects it names (the core keeps it too).
    const prev = this.slots[index];
    const ids = kept.map((e) => e.id);
    const keep = prev !== null && prev !== undefined && prev.group === group && prev.ids.join("\u0000") === ids.join("\u0000");
    const slot: Slot = { group, bus, effects: kept.map(submixEffect), ids, bindings: keep ? prev.bindings : [] };
    if (effects.length > SUBMIX_EFFECTS_MAX) this.host.warnOnce(`submix-effects:${where}`, `audio: "${where}" has ${effects.length} effects; an instance's chain runs the first ${SUBMIX_EFFECTS_MAX}.`);
    this.slots[index] = slot;
    this.send(index, slot);
    // The core keeps a slot's automation across a SUBMIX of the same group: clear it when the chain it named changed.
    if (!keep && prev?.group === group && prev.bindings.length > 0 && this.host.session.mayQueue) this.host.writer.submixAutomate?.(index, []);
    return true;
  }

  /**
   * ADR 0331 instance automation (ABI 4.8): instance `group`'s submix parameter automation (SUBMIX_AUTOMATE, replacing
   * what it had). A lane naming an effect the chain doesn't hold, or a parameter past the wire's, is left out.
   */
  automate(group: number, lanes: readonly SubmixLane[]): void {
    const index = this.byGroup.get(group);
    if (index === undefined) return;
    const s = this.slots[index]!;
    const bindings: AutomateBindings[] = [];
    for (const l of lanes) {
      const fx = s.ids.indexOf(l.effect);
      if (fx < 0 || l.param < 0 || l.param > 0xff || bindings.length >= BUS_AUTOMATE_MAX_BINDINGS) continue;
      const param = l.input.time !== undefined ? AUTOMATION_TIME | l.input.time : l.input.global ? AUTOMATION_GLOBAL | l.input.slot : l.input.slot;
      const target = (AUTO_TARGET_FX | (fx << AUTO_TARGET_SLOT_SHIFT) | (l.param << AUTO_TARGET_PARAM_SHIFT) | (l.log ? AUTO_TARGET_LOG : 0)) >>> 0;
      bindings.push({ param, curve: l.curve, target });
    }
    if (bindings.length === 0 && s.bindings.length === 0) return;
    s.bindings = bindings;
    this.sendBindings(index, s);
  }

  /** True when instance `group` holds a submix. */
  has(group: number): boolean {
    return this.byGroup.has(group);
  }

  /** Frees instance `group`'s submix (its voices have ended); nothing when it has none. */
  close(group: number): void {
    const index = this.byGroup.get(group);
    if (index === undefined) return;
    this.byGroup.delete(group);
    this.slots[index] = null;
    if (this.host.session.mayQueue) this.host.writer.submix(index, 0, 0, []);
  }

  /** The header REPLAY (after RESET): every slot in use again. */
  replayHeader(b: ReplayBuilder): void {
    this.slots.forEach((s, index) => {
      if (!s) return;
      const rec = { voiceId: index, frameOffset: ASAP, group: s.group, bus: this.busIndex(s.bus), effects: s.effects };
      b.record(SUBMIX_FIXED_END + SUBMIX_EFFECTS_FIXED_END * s.effects.length, (view, off) => writeSubmix(view, off, rec));
      if (s.bindings.length > 0) {
        const auto = { voiceId: index, frameOffset: ASAP, bindings: s.bindings };
        b.record(16 + AUTOMATE_BINDINGS_FIXED_END * s.bindings.length, (view, off) => writeSubmixAutomate(view, off, auto));
      }
    });
  }

  /** A new bus tree: the slots again with their buses' indices now. */
  busesReset(): void {
    this.slots.forEach((s, index) => s && this.send(index, s));
  }

  /** Every slot goes (the backend is disposed or the session ended). */
  clear(): void {
    this.slots.fill(null);
    this.byGroup.clear();
  }

  private send(index: number, s: Slot): void {
    if (this.host.session.mayQueue) this.host.writer.submix(index, s.group, this.busIndex(s.bus), s.effects);
  }

  private sendBindings(index: number, s: Slot): void {
    if (this.host.session.mayQueue) this.host.writer.submixAutomate?.(index, s.bindings);
  }

  private busIndex(name: string): number {
    const b = this.host.busIndex(name);
    return b >= 0 ? b : 0;
  }
}
