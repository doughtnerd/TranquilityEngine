// ADR 0171 amended by 0172 (M5, contract K0; plan seam; task Dp1): presence ducking in the core (ADR 0172 §1.1;
// architecture §4.6 R4; api-and-models §4.2 `BUS_DUCK`, `BUS_PRESENCE`). The core backend calls these hooks when the bus
// tree is configured, when the settings change and when a voice starts or stops:
//
// - **Rules.** `BUS_DUCK` (replace-all, asap) carries every presence rule of the settings (`mode` not `"level"`; Sc1 adds
//   level rules), target and trigger as bus slots, at configure and whenever the settings' `ducking` list changes (then
//   with the mask, asap).
// - **Presence.** `BUS_PRESENCE` carries a mask, bit b while slot b has a voice (virtual and locked included; a voice
//   stops counting at its explicit stop, or at its free when it ended on its own, a STATUS later). A record goes out when
//   the bit of a slot some rule triggers on changes (other slots' bits only ride along, so a project without ducking
//   sends nothing per voice), **stamped at the voice's start frame** (or asap when that frame is not ahead of *F*_now, as its
//   PLAY is) and asap at an explicit stop; the core applies it at the start of the quantum holding the frame and the duck
//   follows with the rule's attack and release (`duck.rs`).
// - **Order.** Each record carries the whole mask, so a later record must not be overtaken by an earlier-written one
//   stamped further ahead. The bit changes still waiting for their frame are kept (`PENDING`); every record's mask is the
//   presence **at its own frame** (those changes left out), each waiting change has its own record, and when a new change
//   alters the mask at a waiting frame, that frame's record is sent again (the core applies same-frame records in batch order, so the newer one wins).
// - **Replay** (§4.2): `BUS_DUCK`, then `BUS_PRESENCE` with every counted voice, after `BUS_CONFIG` (`replay`).
//
// Nothing here allocates per voice (the core voice-start allocation gate, `eventBench.test.ts`). The Babylon fallback
// never uses this: it keeps main's presence computation (`mixer.ts`).
import type { Mixer } from "../../../../engine/audio/mixer";
import type { DuckingRule } from "../../../../engine/audio/settings";
import { ASAP, MAX_DUCK_RULES, writeBusDuck, writeBusPresence, type BusDuckRules } from "../wire.generated";
import type { ClockMap } from "./clock";
import type { CommandWriter } from "./commandWriter";
import type { ReplayBuilder } from "./replay";
import { VoiceState, type VoiceTable } from "./voiceTable";

/** Bits in a presence mask (`BUS_PRESENCE`'s `u32`): slots past it never trigger. */
const MASK_BITS = 32;
/** Bit changes kept while they wait for their frame. Past it the oldest is forgotten (its record stays sent). */
const PENDING = 64;

/** What presence needs of the core backend (read when a hook runs, so it can be handed over before they exist). */
export interface PresenceHost {
  readonly writer: Pick<CommandWriter, "busDuck" | "busPresence">;
  readonly table: Pick<VoiceTable, "capacity" | "state" | "bus" | "startFrame">;
  readonly clockMap: Pick<ClockMap, "stampFor">;
  readonly mixer: Pick<Mixer, "audioSettings" | "busNames">;
}

export class Presence {
  /** Counted voices per bus slot (all changes applied, waiting ones included). */
  private readonly count = new Int32Array(MASK_BITS);
  /** Per voice-table slot: 1 + the bus slot it is counted on, 0 when not counted. */
  private counted: Int16Array = new Int16Array(0);
  // Bit changes waiting for their frame: the frame, the bus, +1/-1 on the count, the mask last sent for that frame.
  private readonly pendFrame = new Float64Array(PENDING);
  private readonly pendBus = new Uint8Array(PENDING);
  private readonly pendDelta = new Int8Array(PENDING);
  private readonly pendSent = new Uint32Array(PENDING);
  private pendLen = 0;
  private readonly scratch = new Int32Array(MASK_BITS);
  /** The presence rules last sent (`BUS_DUCK`), for the replay; and the settings list they came from. */
  private rules: BusDuckRules[] = [];
  private rulesFrom: readonly DuckingRule[] | null = null;
  /** The slots some presence rule triggers on: only their bit changes are sent (the others ride along in the masks). */
  private triggers = 0;
  /** Records sent (tests and `Audio.debug()`): `BUS_DUCK`, `BUS_PRESENCE`. */
  duckRecords = 0;
  presenceRecords = 0;

  constructor(private readonly host: PresenceHost | null = null) {}

  /** The bus tree was (re)configured with `mixer`'s settings: send the rules and the presence mask, recounted from the table. */
  configured(mixer: Mixer, _busLive: ArrayLike<number>): void {
    const host = this.host;
    if (!host) return;
    this.sendRules(mixer.audioSettings.ducking, mixer.busNames);
    // Recount from the table: a remap moved voices to new slots, and a stopping voice no longer counts.
    const t = host.table;
    if (this.counted.length !== t.capacity) this.counted = new Int16Array(t.capacity);
    this.count.fill(0);
    this.pendLen = 0;
    for (let i = 0; i < t.capacity; i++) {
      this.counted[i] = 0;
      const s = t.state[i]!;
      if (s === VoiceState.FREE || s === VoiceState.STOPPING || s === VoiceState.ENDING) continue;
      const b = t.bus[i]!;
      if (b >= MASK_BITS) continue;
      this.counted[i] = b + 1;
      this.count[b]!++;
    }
    host.writer.busPresence(this.maskAt(Infinity));
    this.presenceRecords++;
  }

  /** The mixer's settings changed (its change notification): a new `ducking` list is sent again. */
  settingsChanged(mixer: Mixer): void {
    if (this.host && mixer.audioSettings.ducking !== this.rulesFrom) {
      this.sendRules(mixer.audioSettings.ducking, mixer.busNames);
      this.resendMask();
    }
  }

  /**
   * A voice in table slot `slot` started on bus index `bus` (or moved onto it); its start frame is
   * `table.startFrame[slot]` (0 for asap). The slot, not the frame, is passed: a Float64Array element passed as an
   * argument would box a heap number per voice start (the core voice-start allocation gate in `eventBench.test.ts`).
   */
  voiceStarted(bus: number, slot: number): void {
    const host = this.host;
    if (!host || bus < 0 || bus >= MASK_BITS) return;
    const t = host.table;
    if (this.counted.length !== t.capacity) this.counted = new Int16Array(t.capacity);
    const s = t.state[slot]!;
    if (s === VoiceState.STOPPING || s === VoiceState.ENDING) return;
    if (this.counted[slot] !== 0) this.change(this.counted[slot]! - 1, -1, undefined);
    this.counted[slot] = bus + 1;
    this.change(bus, 1, host.clockMap.stampFor(t.startFrame[slot]!));
  }

  /** The voice in table slot `slot` on bus index `bus` stopped (explicitly: asap), ended or moved off it (no allocation, as above). */
  voiceStopped(_bus: number, slot: number): void {
    if (!this.host || slot < 0 || slot >= this.counted.length) return;
    const c = this.counted[slot]!;
    if (c === 0) return;
    this.counted[slot] = 0;
    this.change(c - 1, -1, undefined);
  }

  /** `BUS_DUCK`, every presence rule of `rules`, replace-all, asap (§4.2; Sc1 adds level rules). */
  writeDucking(rules: readonly DuckingRule[]): void {
    if (!this.host) return;
    this.sendRules(rules, this.host.mixer.busNames);
    this.resendMask();
  }

  /** The hard rebuild (§4.2, after `BUS_CONFIG`): `BUS_DUCK` with the rules last sent, then the presence of every counted voice, asap. */
  replay(out: ReplayBuilder): void {
    if (!this.host) return;
    const rules = this.rules;
    out.record(16 + 24 * rules.length, (view, off) => writeBusDuck(view, off, { voiceId: 0, frameOffset: ASAP, rules }));
    // Every counted voice, waiting ones included: the new core's frames are not the old one's.
    this.pendLen = 0;
    const mask = this.maskAt(Infinity);
    out.record(16, (view, off) => writeBusPresence(view, off, { voiceId: 0, frameOffset: ASAP, mask }));
  }

  /** The presence mask now and at every frame after the waiting changes (bit b while bus b counts a voice). */
  get mask(): number {
    return this.maskAt(Infinity);
  }

  // --- Internals ---

  /** New triggers: every counted voice's bit, asap (a waiting start of a new trigger counts from now). */
  private resendMask(): void {
    this.pendLen = 0;
    this.host!.writer.busPresence(this.maskAt(Infinity));
    this.presenceRecords++;
  }

  private sendRules(list: readonly DuckingRule[], names: readonly string[]): void {
    const host = this.host!;
    this.rulesFrom = list;
    const out: BusDuckRules[] = [];
    for (const r of list) {
      if (r.mode === "level" || out.length >= MAX_DUCK_RULES) continue;
      const target = names.indexOf(r.target);
      const trigger = names.indexOf(r.trigger);
      if (target < 0 || trigger < 0 || trigger >= MASK_BITS) continue;
      out.push({ target, trigger, flags: 0, thresholdDb: r.threshold ?? -30, amount: r.amount, attack: r.attack, release: r.release });
    }
    this.rules = out;
    let triggers = 0;
    for (const r of out) triggers |= 1 << r.trigger;
    this.triggers = triggers >>> 0;
    host.writer.busDuck(out);
    this.duckRecords++;
  }

  /** The mask at `frame`: the counts with every waiting change after `frame` left out. */
  private maskAt(frame: number): number {
    const c = this.scratch;
    c.set(this.count);
    for (let k = 0; k < this.pendLen; k++) if (this.pendFrame[k]! > frame) c[this.pendBus[k]!]! -= this.pendDelta[k]!;
    let m = 0;
    for (let b = 0; b < MASK_BITS; b++) if (c[b]! > 0) m |= 1 << b;
    return m >>> 0;
  }

  /** Bus `bus`'s count moves by `delta` at frame `at` (undefined: asap); sends what changed. */
  private change(bus: number, delta: number, at: number | undefined): void {
    const host = this.host!;
    // Waiting changes whose frame is no longer ahead of F_now have applied (or apply before anything sent now).
    let n = 0;
    for (let k = 0; k < this.pendLen; k++) {
      if (host.clockMap.stampFor(this.pendFrame[k]!) === undefined) continue;
      this.pendFrame[n] = this.pendFrame[k]!;
      this.pendBus[n] = this.pendBus[k]!;
      this.pendDelta[n] = this.pendDelta[k]!;
      this.pendSent[n] = this.pendSent[k]!;
      n++;
    }
    this.pendLen = n;
    // A slot no rule triggers on changes no duck: counted, not sent (its bit rides along in the next record).
    const trig = this.triggers;
    if (((trig >>> bus) & 1) === 0) {
      this.count[bus]! += delta;
      return;
    }
    const frame = at ?? -Infinity;
    const before = this.maskAt(frame);
    this.count[bus]! += delta;
    if (at !== undefined) {
      if (this.pendLen === PENDING) this.drop(0);
      const k = this.pendLen++;
      this.pendFrame[k] = at;
      this.pendBus[k] = bus;
      this.pendDelta[k] = delta;
    }
    const mask = this.maskAt(frame);
    // A stamped change always gets its own record, so every waiting frame has one that later changes can correct.
    if (((mask ^ before) & trig) !== 0 || at !== undefined) {
      host.writer.busPresence(mask, at);
      this.presenceRecords++;
    }
    // Every waiting frame after this one: its record is sent again when its mask moved.
    for (let k = 0; k < this.pendLen; k++) {
      const f = this.pendFrame[k]!;
      if (at !== undefined && f === at) {
        this.pendSent[k] = mask;
        continue;
      }
      if (f <= frame) continue;
      const m = this.maskAt(f);
      if (((m ^ this.pendSent[k]!) & trig) === 0) continue;
      for (let j = 0; j < this.pendLen; j++) if (this.pendFrame[j] === f) this.pendSent[j] = m;
      host.writer.busPresence(m, f);
      this.presenceRecords++;
    }
  }

  private drop(k: number): void {
    for (let j = k + 1; j < this.pendLen; j++) {
      this.pendFrame[j - 1] = this.pendFrame[j]!;
      this.pendBus[j - 1] = this.pendBus[j]!;
      this.pendDelta[j - 1] = this.pendDelta[j]!;
      this.pendSent[j - 1] = this.pendSent[j]!;
    }
    this.pendLen--;
  }
}
