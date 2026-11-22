// ADR 0331 (ABI 4.5; levels 4.9): submixes on the core backend. Main owns the pool: `settings.voices.submixes` slots
// (default 32), clamped to the core's `SUBMIXES_MAX`.
//
// - **An instance's own chain** (its root playlist's or sequence's): `open` gives instance group `group` a slot and sends
//   its SUBMIX (group, output bus, insert chain) before the instance's first PLAY, so the core routes the group's voices
//   on that bus into the slot.
// - **A level's chain** (ABI 4.9: a nested playlist's, a sequence track's or a clip's): `openLevel` gives the level a
//   slot of the instance's own, with no group (its voices name it with a ROUTE, `PlayRequest.submix`), feeding the slot
//   of the level above it on the same bus (`parent`), else its bus. A level is keyed within its instance, so playing it
//   again (a Queue's next pick of the same entry, a sequence clip on the next pass of a loop) reuses its slot and its
//   state (a delay's echoes carry on), as an FMOD event instance's track and instrument effects do.
// - **Close and tails.** `close(group)` runs when the instance's group is given back (its voices have ended). A slot whose
//   chain has no tail to speak of (filters, EQ, gain, dynamics, saturation) is freed at once. A slot with a delay, a
//   reverb, a chorus or a pitch or formant shifter is let go first (SUBMIX with group 0: it takes no new voices, its
//   chain keeps running) and freed once the instance's tails have rung out (`tailSeconds`, summed over its slots, as a
//   level's output runs through the levels above it), checked whenever the pool is asked for a slot. The core stops
//   running a slot whose input and output have been silent for 32 quanta, so a ringing slot costs nothing once quiet.
// - **A full pool** first frees the ringing slot nearest its end (a tail is the least of what plays), then refuses: the
//   caller plays the instance or level without its chain (the playlist runtime maps filters and gain onto each voice),
//   warned once and marked in a running capture (a MARKER: the capture format has no submix kind yet).
//
// The chain is the catalogue's effects (`effects/catalogue.ts`) as the core's `SUBMIX_FX_*` kinds, parameters in the
// catalogue's order with its defaults filled in (`effectKinds.ts`, the one table the bus chains share). Since ABI 4.6
// the core runs every type `CORE_EFFECT_TYPES` lists but the sidechain compressor (a bus effect: an instance has no key
// bus); any other kind passes through. Disabled effects are sent bypassed.
//
// Replay: after a rebuild's RESET the slots in use are sent again (session phase `replayHeader`, before the voices; a
// voice's ROUTE follows its replayed PLAY, `coreAutomation.replayVoice`), and a new bus tree re-sends them with their
// buses' new indices (`busesReset`).
import { effectParamValue } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";
import {
  AUTO_TARGET_FX, AUTO_TARGET_LOG, AUTO_TARGET_PARAM_SHIFT, AUTO_TARGET_SLOT_SHIFT, SUBMIX_AUTOMATE_BINDINGS_FIXED_END, BUS_AUTOMATE_MAX_BINDINGS, SUBMIX_EFFECTS_MAX,
  SUBMIX_FIXED_END, SUBMIX_EFFECTS_FIXED_END, SUBMIX_FX_ON, SUBMIXES_MAX, ASAP, writeSubmix, writeSubmixAutomate, type SubmixAutomateBindings as AutomateBindings, type SubmixEffects,
} from "../wire.generated";
import type { SubmixLane } from "../backend";
import { AUTOMATION_GLOBAL, AUTOMATION_TIME } from "./commandWriter";
import { EFFECT_RECORD_PARAMS, FX_KINDS, fxKind, fxParams } from "./effectKinds";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";
import type { SendGate } from "./session";
import type { SubmixLevel } from "../backend";

/** The default pool when the settings name none (ADR 0331). */
export const DEFAULT_SUBMIXES = 32;

/** The core's kind for each catalogue effect type it runs (`effectKinds.ts`; any other type is sent as passthrough, 0). */
export const SUBMIX_KINDS: Readonly<Record<string, number>> = FX_KINDS;

/** A chain whose tail is shorter than this is freed at once on close (seconds). */
const TAIL_MIN = 0.1;
/** The longest an instance's slots are kept ringing after its voices end (seconds). */
const TAIL_MAX = 30;

/** What the pool needs of the core backend. */
export interface CoreSubmixesHost {
  readonly writer: Pick<CommandWriter, "submix"> & Partial<Pick<CommandWriter, "submixAutomate">>;
  readonly session: SendGate;
  /** The pool size the settings ask for (`settings.voices.submixes`; undefined: the default). */
  poolSize(): number | undefined;
  busIndex(name: string): number;
  profile(): ProfileSink;
  warnOnce(key: string, message: string): void;
  /** Seconds, for tails (absent: `performance.now()`). */
  now?(): number;
}

interface Slot {
  /** The instance group that owns it (frees it on `close`). */
  owner: number;
  /** The group the core routes into it (an instance's own chain); 0 for a level (ROUTE only) or a ringing tail. */
  group: number;
  /** The level's key within its instance (`""` for the instance's own chain). */
  key: string;
  bus: string;
  /** The slot it feeds, or null for its bus. */
  parent: number | null;
  effects: SubmixEffects[];
  /** The catalogue effects it was opened with (by identity: an unchanged level isn't sent again). */
  source: readonly Effect[];
  /** Seconds its chain rings on after its input stops (`tailSeconds`). */
  tail: number;
  /** While ringing out after its instance ended: when it is freed (seconds); else NaN. */
  freeAt: number;
  /** The close it rings out from (the slots of one instance are freed together). */
  ring: number;
  /** The effects' ids, in chain order (what `SubmixLane.effect` names). */
  ids: string[];
  /** ABI 4.10: the slot's parameter automation as written (SUBMIX_AUTOMATE; an instance's own chain only). */
  bindings: AutomateBindings[];
}

/** The catalogue effect `e` as a SUBMIX effect: its kind (a registered plugin effect's, ABI 5.0), bypass flag and parameters in the catalogue's order. */
export function submixEffect(e: Effect): SubmixEffects {
  return { type: fxKind(e.type), flags: e.on ? SUBMIX_FX_ON : 0, p: fxParams(e.type, e.params, EFFECT_RECORD_PARAMS) };
}

/**
 * How long `effects` ring on after their input stops, seconds: a delay until its feedback has fallen 80 dB, a reverb
 * 1.5× its decay (its RT60, to about −90 dB), a chorus its longest delay, a pitch or formant shifter its grain; filters,
 * EQ, gain, saturation and dynamics none to speak of (a few milliseconds).
 */
function tailSeconds(effects: readonly Effect[]): number {
  let t = 0;
  for (const e of effects) {
    if (!e.on) continue;
    const v = (name: string, fallback: number): number => {
      const x = effectParamValue(e, name);
      return x !== undefined && Number.isFinite(x) ? x : fallback;
    };
    switch (e.type) {
      case "delay": {
        const time = Math.max(0, v("time", 250)) / 1000;
        const fb = Math.min(0.95, Math.max(0, v("feedback", 30) / 100));
        t += fb > 1e-3 ? time * (1 + Math.log(1e-4) / Math.log(fb)) : time;
        break;
      }
      case "reverb": t += 1.5 * Math.max(0.1, v("decay", 2)); break;
      case "chorus": t += 0.05; break;
      case "pitchShift": case "formantShift": t += 0.1; break;
      default: break;
    }
  }
  return Math.min(TAIL_MAX, t);
}

/** ADR 0331: the core backend's submix pool (instances' and their levels'). */
export class CoreSubmixes {
  private readonly slots: (Slot | null)[] = new Array(SUBMIXES_MAX).fill(null);
  /** Instance group → the slot of its own chain. */
  private readonly byGroup = new Map<number, number>();
  /** `${group} ${key}` → a level's slot. */
  private readonly levels = new Map<string, number>();
  /** The handle of each slot (one object a slot, so voices compare equal). */
  private readonly handles: SubmixLevel[] = Array.from({ length: SUBMIXES_MAX }, (_, slot) => Object.freeze({ slot }));
  /** Refusals since start (debug). */
  refused = 0;
  private rings = 0;

  constructor(private readonly host: CoreSubmixesHost) {}

  /** The pool's size now: the settings' (default 32), clamped to the core's slots. */
  get capacity(): number {
    const n = this.host.poolSize();
    const want = n === undefined || !Number.isFinite(n) ? DEFAULT_SUBMIXES : Math.floor(n);
    return Math.max(0, Math.min(SUBMIXES_MAX, want));
  }

  /** Slots in use (ringing tails included). */
  get size(): number {
    let n = 0;
    for (const s of this.slots) if (s) n++;
    return n;
  }

  /**
   * Gives instance `group` (1..1024) a submix feeding `bus` that runs `effects` (an instance already holding one has it
   * reconfigured). False when the pool is full (or set to 0): the instance plays without its chain. `where` names the
   * instance in the warning and the capture's marker.
   */
  open(group: number, bus: string, effects: readonly Effect[], where: string): boolean {
    if (!validGroup(group)) return false;
    let index = this.byGroup.get(group);
    if (index === undefined) {
      index = this.take(where);
      if (index < 0) return false;
      this.byGroup.set(group, index);
    }
    const kept = effects.slice(0, SUBMIX_EFFECTS_MAX);
    // A reconfigured instance keeps its automation while its chain keeps the effects it names (the core keeps it too).
    const prev = this.slots[index];
    const ids = kept.map((e) => e.id);
    const keep = !!prev && prev.group === group && prev.ids.join("\u0000") === ids.join("\u0000");
    this.configure(index, { owner: group, group, key: "", bus, parent: null, effects: this.chain(effects, where), source: effects, tail: tailSeconds(effects), freeAt: Number.NaN, ring: 0, ids, bindings: keep ? prev!.bindings : [] });
    // The core keeps a slot's automation across a SUBMIX of the same group: clear it when the chain it named changed.
    if (!keep && prev?.group === group && prev.bindings.length > 0 && this.host.session.mayQueue) this.host.writer.submixAutomate?.(index, []);
    return true;
  }

  /**
   * ADR 0331 instance automation (ABI 4.10): instance `group`'s own submix's parameter automation (SUBMIX_AUTOMATE,
   * replacing what it had). A lane naming an effect the chain doesn't hold, or a parameter past the wire's, is left out.
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

  /** The level instance `group`'s own submix is, or null. */
  levelOf(group: number): SubmixLevel | null {
    const index = this.byGroup.get(group);
    return index === undefined ? null : this.handles[index]!;
  }

  /**
   * ADR 0331 levels: a submix of instance `group`'s own for its level `key` (a nested playlist, a sequence track, a clip),
   * feeding `parent` (null: `bus`) and running `effects`; the same key gets the same slot back (reconfigured). Null when
   * the pool is full (warned once).
   */
  openLevel(group: number, key: string, bus: string, effects: readonly Effect[], parent: SubmixLevel | null, where: string): SubmixLevel | null {
    if (!validGroup(group)) return null;
    const k = `${group} ${key}`;
    let index = this.levels.get(k);
    if (index === undefined) {
      index = this.take(where);
      if (index < 0) return null;
      this.levels.set(k, index);
    }
    const up = parent && parent.slot !== index && this.slots[parent.slot] ? parent.slot : null;
    const was = this.slots[index];
    // Played again unchanged (a Queue's next pick of the entry, the next pass of a sequence loop): nothing to send.
    if (was && was.source === effects && was.bus === bus && was.parent === up) return this.handles[index]!;
    this.configure(index, { owner: group, group: 0, key, bus, parent: up, effects: this.chain(effects, where), source: effects, tail: tailSeconds(effects), freeAt: Number.NaN, ring: 0, ids: effects.slice(0, SUBMIX_EFFECTS_MAX).map((e) => e.id), bindings: [] });
    return this.handles[index]!;
  }

  /** True when instance `group` holds a submix of its own. */
  has(group: number): boolean {
    return this.byGroup.has(group);
  }

  /**
   * Instance `group`'s voices have ended: its slots take no more voices, and each is freed once the instance's tails have
   * rung out (at once when they have none).
   */
  close(group: number): void {
    this.byGroup.delete(group);
    let tail = 0;
    const owned: number[] = [];
    this.slots.forEach((s, i) => {
      if (s && s.owner === group && Number.isNaN(s.freeAt)) {
        owned.push(i);
        tail += s.tail;
        this.levels.delete(`${group} ${s.key}`);
      }
    });
    if (owned.length === 0) return;
    tail = Math.min(TAIL_MAX, tail);
    const now = this.now();
    const ring = ++this.rings;
    for (const i of owned) {
      const s = this.slots[i]!;
      if (tail < TAIL_MIN) {
        this.free(i);
        continue;
      }
      // Rings out: no group (a new instance may take it), the same chain and parent.
      s.freeAt = now + tail;
      s.ring = ring;
      s.owner = 0;
      if (s.group !== 0) {
        s.group = 0;
        s.bindings = []; // the core drops a slot's automation with its group
        this.send(i, s);
      }
    }
  }

  /** The header REPLAY (after RESET): every slot in use again. */
  replayHeader(b: ReplayBuilder): void {
    this.slots.forEach((s, index) => {
      if (!s) return;
      const rec = { voiceId: index, frameOffset: ASAP, group: s.group, bus: this.busIndex(s.bus), parent: s.parent === null ? 0 : s.parent + 1, reserved: 0, effects: s.effects };
      b.record(SUBMIX_FIXED_END + SUBMIX_EFFECTS_FIXED_END * s.effects.length, (view, off) => writeSubmix(view, off, rec));
      if (s.bindings.length > 0 && s.group !== 0) {
        const auto = { voiceId: index, frameOffset: ASAP, bindings: s.bindings };
        b.record(16 + SUBMIX_AUTOMATE_BINDINGS_FIXED_END * s.bindings.length, (view, off) => writeSubmixAutomate(view, off, auto));
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
    this.levels.clear();
  }

  /** A free slot within the pool (after freeing tails that have rung out, then the ringing one nearest its end); -1 refuses. */
  private take(where: string): number {
    const cap = this.capacity;
    const now = this.now();
    this.slots.forEach((s, i) => s && s.freeAt <= now && this.free(i));
    let ringing = -1;
    for (let i = 0; i < cap; i++) {
      const s = this.slots[i];
      if (!s) return i;
      if (!Number.isNaN(s.freeAt) && (ringing < 0 || s.freeAt < this.slots[ringing]!.freeAt)) ringing = i;
    }
    if (ringing >= 0) {
      // The whole instance's ringing slots go together (a level must not feed a slot another instance takes).
      const ring = this.slots[ringing]!.ring;
      this.slots.forEach((s, i) => s && !Number.isNaN(s.freeAt) && s.ring === ring && this.free(i));
      return ringing;
    }
    this.refused++;
    this.host.warnOnce("submix-full", `audio: "${where}" plays without its effects: every submix (settings.voices.submixes: ${cap}) is in use (ADR 0331). Raise the pool or use fewer playlist, track and clip effect chains at once; this is warned once.`);
    const profile = this.host.profile();
    if (profile !== NULL_PROFILE_SINK) profile.marker(`submix refused: ${where} (pool of ${cap} full)`);
    return -1;
  }

  private chain(effects: readonly Effect[], where: string): SubmixEffects[] {
    if (effects.length > SUBMIX_EFFECTS_MAX) this.host.warnOnce(`submix-effects:${where}`, `audio: "${where}" has ${effects.length} effects; a submix's chain runs the first ${SUBMIX_EFFECTS_MAX}.`);
    return effects.slice(0, SUBMIX_EFFECTS_MAX).map(submixEffect);
  }

  private configure(index: number, slot: Slot): void {
    this.slots[index] = slot;
    this.send(index, slot);
  }

  private free(index: number): void {
    if (!this.slots[index]) return;
    this.slots[index] = null;
    if (this.host.session.mayQueue) this.host.writer.submix(index, 0, 0, []);
  }

  private send(index: number, s: Slot): void {
    if (this.host.session.mayQueue) this.host.writer.submix(index, s.group, this.busIndex(s.bus), s.effects, s.parent);
  }

  private sendBindings(index: number, s: Slot): void {
    if (this.host.session.mayQueue) this.host.writer.submixAutomate?.(index, s.bindings);
  }

  private busIndex(name: string): number {
    const b = this.host.busIndex(name);
    return b >= 0 ? b : 0;
  }

  private now(): number {
    return this.host.now ? this.host.now() : performance.now() / 1000;
  }
}

const validGroup = (group: number): boolean => Number.isInteger(group) && group >= 1 && group <= 1024;
