/**
 * Internal (ADR 0175, building on 0097, 0171 and 0172 R10): the bus capability rules and the live answers, in one place.
 *
 * **Rules.** Each rule has one limit, one parse severity, one live answer and one message:
 *
 * | rule                | limit | parse    | live (mixer.apply)                        | runs on         |
 * |---------------------|-------|----------|-------------------------------------------|-----------------|
 * | `busCount`          | 32    | problem  | refused (`opRefusal`)                     | every backend   |
 * | `insertsPerBus`     | 8     | problem  | refused (`opRefusal`)                     | every backend   |
 * | `compressorsPerBus` | 8     | warning  | kept; applies at the next Play            | the audio core  |
 * | `effectsPerBus`     | 8     | warning  | kept; applies at the next Play            | the audio core  |
 *
 * `insertsPerBus` is the mix model's declared cap (ADR 0331: a bus's or a return's insert chain holds at most 8
 * effects; `audio.json`'s parse reads it from here, `MIX_LIMITS.effectsPerOwner`). The two core rules are the audio
 * core's real limits (`audio-core/src/fx.rs`; the wire's `BUS_SLOT_MAX_EFFECTS`, which a plugin-side test holds equal to
 * `MAX_CORE_BUS_EFFECTS`). Since ABI 4.6 (ADR 0331) the core runs eight effects a bus, any number of them compressors,
 * so both equal the insert cap and the insert cap's refusal comes first: they stay as rules (a warning is a note on a
 * valid section: the edit is kept as authored and saved, R10) for a core that runs fewer. The Web Audio fallback runs
 * every effect it has, so the core-only rules don't apply to it live.
 *
 * **What the core runs** (`CORE_EFFECT_TYPES`): the catalogue types the core's shared effect DSP runs at the bus and
 * instance levels (`audio_dsp::fx`, ABI 4.6); the plugin's `effectKinds.ts` maps each to its wire kind.
 *
 * **Live answers.** `ApplyResult.reason` is one of `APPLY_REASONS`; `reasonMessage` is its only text. `ok: false` with a
 * reason: kept, applies at the next Play (`appliesAtNextPlay`). `ok: true` with a reason: kept, applies later this session
 * (`waitsForSlot`). `ok: false` without one: refused (`opRefusal` says why).
 *
 * Pure, and imports nothing at run time (the settings parse and the op functions import it).
 */
import type { AudioSettings, BusEffect, BusSettings } from "./settings";
import type { ApplyResult, MixOp, OpClass } from "./mixOps";

/** Buses per project: the core's slot count (`MAX_BUS` in the wire; tombstones count, `slotTable.ts`). */
export const MAX_BUSES = 32;
/** ADR 0331: effects per bus or return the mix model holds (the insert chain's cap, on every backend). */
export const MAX_BUS_INSERTS = 8;
/** Effects per bus the audio core runs (`MAX_EFFECTS` in `audio-core/src/fx.rs`, `BUS_SLOT_MAX_EFFECTS` on the wire; ABI 4.6). */
export const MAX_CORE_BUS_EFFECTS = 8;
/** Compressors per bus the audio core runs (ADR 0331: no one-compressor limit since ABI 4.6; the insert cap bounds it). */
export const MAX_CORE_BUS_COMPRESSORS = 8;

/**
 * ADR 0331 (ABI 4.6): the catalogue types the audio core runs on bus chains and instance submixes (`audio_dsp::fx`).
 * The others (`envelope`, `fades`, `noiseReduction`, `reverse`) belong to the voice and sample levels.
 */
export const CORE_EFFECT_TYPES = [
  "eq", "lowpass", "highpass", "bandpass", "compressor", "sidechainCompressor", "limiter", "gain", "saturation",
  "distortion", "bitcrush", "formantShift", "pitchShift", "chorus", "delay", "reverb",
] as const;
export type CoreEffectType = (typeof CORE_EFFECT_TYPES)[number];
const CORE_SET: ReadonlySet<string> = new Set(CORE_EFFECT_TYPES);
/** True when the audio core runs catalogue type `type` on a bus chain or an instance submix. */
export const coreRuns = (type: string): type is CoreEffectType => CORE_SET.has(type);

export type BusRule = "busCount" | "insertsPerBus" | "compressorsPerBus" | "effectsPerBus";

/** What the rule's breach is to the parse: a `problem` (the rest is dropped) or a `warning` (kept as authored). */
export type ParseSeverity = "problem" | "warning";
/** What `mixer.apply` answers an op that breaks it: `refused`, or kept and applied at the next Play. */
export type LiveSeverity = "refused" | "nextPlay";

export interface BusRuleSpec {
  readonly limit: number;
  readonly parse: ParseSeverity;
  readonly live: LiveSeverity;
  /** Only the audio core has the limit (the fallback runs every effect). */
  readonly coreOnly: boolean;
  /** The rule's one message, a lower-case clause; the parse, refusal and live texts are built from it. */
  readonly message: string;
}

export const BUS_RULES: Readonly<Record<BusRule, BusRuleSpec>> = {
  busCount: { limit: MAX_BUSES, parse: "problem", live: "refused", coreOnly: false, message: `at most ${MAX_BUSES} buses` },
  insertsPerBus: { limit: MAX_BUS_INSERTS, parse: "problem", live: "refused", coreOnly: false, message: `a bus holds at most ${MAX_BUS_INSERTS} effects` },
  compressorsPerBus: {
    limit: MAX_CORE_BUS_COMPRESSORS, parse: "warning", live: "nextPlay", coreOnly: true,
    message: `a bus runs at most ${MAX_CORE_BUS_COMPRESSORS} compressors; the edit is saved and applies at the next Play, where only the first ${MAX_CORE_BUS_COMPRESSORS} compressors of the list run and the others are skipped`,
  },
  effectsPerBus: {
    limit: MAX_CORE_BUS_EFFECTS, parse: "warning", live: "nextPlay", coreOnly: true,
    message: `a bus runs at most ${MAX_CORE_BUS_EFFECTS} effects; the edit is saved and applies at the next Play, where only the first ${MAX_CORE_BUS_EFFECTS} of the list run`,
  },
};

const compressors = (effects: readonly Pick<BusEffect, "type">[]): number => effects.filter((e) => e.type === "compressor").length;

/** One rule a parsed bus list breaks: `bus` is the bus's index, or -1 for the list (`busCount`). */
export interface BusRuleFinding { rule: BusRule; bus: number }

/** The rules `buses` breaks, in list order (the list's own first, then each bus's: the insert cap, the core's effects, then compressors). */
export function busRuleFindings(buses: readonly Pick<BusSettings, "effects">[]): BusRuleFinding[] {
  const out: BusRuleFinding[] = [];
  if (buses.length > BUS_RULES.busCount.limit) out.push({ rule: "busCount", bus: -1 });
  buses.forEach((b, i) => {
    // Past the insert cap the chain is cut to it (a problem); the core's own limit is reported once the chain fits.
    if (b.effects.length > BUS_RULES.insertsPerBus.limit) out.push({ rule: "insertsPerBus", bus: i });
    else if (b.effects.length > BUS_RULES.effectsPerBus.limit) out.push({ rule: "effectsPerBus", bus: i });
    if (compressors(b.effects) > BUS_RULES.compressorsPerBus.limit) out.push({ rule: "compressorsPerBus", bus: i });
  });
  return out;
}

/** A finding as the parse reports it: `where` (`audio.buses`, `audio.buses[2]`), the message, and what the severity does. */
export function findingText(rule: BusRule, where: string): string {
  const spec = BUS_RULES[rule];
  return `${where}: ${spec.message}${spec.parse === "problem" ? "; the rest are ignored" : ""}.`;
}

/** The rule `op` takes past its limit on `a`, or null (only ops that add can: `addBus`, `addEffect`). */
export function ruleBrokenBy(a: Pick<AudioSettings, "buses">, op: MixOp): BusRule | null {
  if (op.op === "addBus") return a.buses.length + 1 > BUS_RULES.busCount.limit ? "busCount" : null;
  if (op.op !== "addEffect") return null;
  const bus = a.buses.find((b) => b.name === op.bus);
  if (!bus) return null;
  if (bus.effects.length + 1 > BUS_RULES.insertsPerBus.limit) return "insertsPerBus";
  if (op.effect?.type === "compressor" && compressors(bus.effects) + 1 > BUS_RULES.compressorsPerBus.limit) return "compressorsPerBus";
  return bus.effects.length + 1 > BUS_RULES.effectsPerBus.limit ? "effectsPerBus" : null;
}

/** `opRefusal`'s message for a `refused` rule `op` breaks ("At most 32 buses."), else null. */
export function ruleRefusal(a: Pick<AudioSettings, "buses">, op: MixOp): string | null {
  const rule = ruleBrokenBy(a, op);
  if (rule === null || BUS_RULES[rule].live !== "refused") return null;
  const m = BUS_RULES[rule].message;
  return `${m[0]!.toUpperCase()}${m.slice(1)}.`;
}

/** Whether one more bus is refused (the Section's "Add bus" buttons). */
export const atBusLimit = (a: Pick<AudioSettings, "buses">): boolean => a.buses.length >= BUS_RULES.busCount.limit;

// ---- live answers ---------------------------------------------------------------------------------------------------

/** What a live target runs (the Mixer's pipeline checks the rules against it). */
export interface LiveCaps {
  /** The audio core's bus chain: its per-bus effect and compressor limits apply. */
  readonly coreChain: boolean;
  /** Level-mode ducking rules run. */
  readonly levelDucking: boolean;
}

export const CORE_LIVE_CAPS: LiveCaps = Object.freeze({ coreChain: true, levelDucking: true });
export const FALLBACK_LIVE_CAPS: LiveCaps = Object.freeze({ coreChain: false, levelDucking: false });

/** Every reason an `ApplyResult` can carry. */
export const APPLY_REASONS = ["compressorsPerBus", "effectsPerBus", "needsAudioCore", "structuralUnavailable", "noLiveBackend", "waitsForSlot"] as const;
export type ApplyReason = (typeof APPLY_REASONS)[number];

const REASON_TEXT: Readonly<Record<Exclude<ApplyReason, BusRule>, string>> = {
  needsAudioCore: "Needs the audio core",
  structuralUnavailable: "this structural edit applies at the next Play",
  noLiveBackend: "no live audio backend",
  waitsForSlot: "the bus waits for a free bus slot (a removed bus is still fading out); it applies as soon as one frees, normally within about 40 ms",
};

/** A reason's one message (the Mixer's banner shows it as "Applies at the next Play: <message>. The edit is saved."). */
export function reasonMessage(reason: ApplyReason): string {
  return reason === "compressorsPerBus" || reason === "effectsPerBus" ? BUS_RULES[reason].message : REASON_TEXT[reason];
}

/** Whether a result is an edit kept for the next Play (rather than applied, deferred within the session, or refused). */
export const appliesAtNextPlay = (r: Pick<ApplyResult, "ok" | "reason">): r is ApplyResult & { reason: ApplyReason } => !r.ok && r.reason !== undefined;

/**
 * The answer, before sending, for an op that passed `opRefusal` and changes something: a core-only rule it breaks on a
 * target with the core's chain (kept, applies at the next Play), else null (send it).
 */
export function liveRuleAnswer(a: Pick<AudioSettings, "buses">, op: MixOp, caps: LiveCaps): ApplyReason | null {
  const rule = ruleBrokenBy(a, op);
  if (rule === null || BUS_RULES[rule].live !== "nextPlay" || (BUS_RULES[rule].coreOnly && !caps.coreChain)) return null;
  return rule as Exclude<BusRule, "busCount" | "insertsPerBus">;
}

/** The answer, after a target applied `op` to the model, for a feature the target doesn't run (a level ducking rule), else null. */
export function unsupportedAnswer(op: MixOp, caps: LiveCaps): ApplyReason | null {
  return !caps.levelDucking && op.op === "setDucking" && op.rule !== null && op.rule.mode === "level" ? "needsAudioCore" : null;
}

/** A class the Mixer sends (never `none`). */
export type SentClass = Exclude<OpClass, "none">;
