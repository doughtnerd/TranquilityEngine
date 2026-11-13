// The ducking rule's editing model and the gain-reduction model (ADR 0171 §2.1, §7 amended by ADR 0172; task Dk1). Pure:
// no Preact, no editor, no backend.
//
// Editing: a rule's fields and limits (`mode`, `detector`, `threshold`, `amount`, `attack`, `release`), a new rule's
// defaults (a level rule, RMS detector, -30 dBFS: owner decision 8), the mode switch (a presence rule carries no
// `detector` or `threshold`, so the parse has nothing to report), and `duckRefusal`, which asks the settings parse itself
// whether a list of rules would lose one, so the section shows the parse's own message (a level cycle naming its rules,
// the 9th level rule, the 33rd rule) and never saves the rule.
//
// Reading: per target bus, the duck lane's gain (STATUS `busDuck` through `Bus.duckGain`), the reduction in dB and which
// rule leads. STATUS carries one gain per ducked bus (the min of its rules), not one per rule, so the lead is worked out
// from the rules and what their triggers are doing: the engaged rule heading lowest, else (a release tail) the rule
// heading lowest.
import {
  DEFAULT_DUCK_DETECTOR,
  DEFAULT_DUCK_THRESHOLD,
  MAX_DUCK_RULES,
  MAX_LEVEL_RULES,
  parseAudioSettings,
  type AudioSettings,
  type DuckingDetector,
  type DuckingMode,
  type DuckingRule,
} from "../../../../engine/audio/settings";

export { DEFAULT_DUCK_DETECTOR, DEFAULT_DUCK_THRESHOLD, MAX_DUCK_RULES, MAX_LEVEL_RULES };

/** What a level rule answers on a backend without level ducking (the Babylon fallback; `babylonBackend.NEEDS_AUDIO_CORE` says the same). */
export const NEEDS_AUDIO_CORE = "Needs the audio core";

export const DUCK_MODES: readonly DuckingMode[] = ["presence", "level"];
export const DUCK_DETECTORS: readonly DuckingDetector[] = ["peak", "rms"];

/** The ranges the parse keeps a rule's numbers in (`settings.ts`: threshold -80..0 dBFS; amount 0..1; attack and release 0..10 s). */
export const DUCK_LIMITS = {
  threshold: [-80, 0],
  amount: [0, 1],
  attack: [0, 10],
  release: [0, 10],
} as const;

/** A new rule's numbers (the parse's defaults). */
export const DUCK_DEFAULTS = { amount: 0.4, attack: 0.1, release: 0.5 } as const;

const clampTo = (n: number, [lo, hi]: readonly [number, number] | readonly number[]): number => Math.min(hi!, Math.max(lo!, n));

/** A new rule: **level**, RMS detector, -30 dBFS (ADR 0172 owner decision 8). */
export function newDuckRule(target: string, trigger: string, mode: DuckingMode = "level"): DuckingRule {
  const rule: DuckingRule = { target, trigger, mode, amount: DUCK_DEFAULTS.amount, attack: DUCK_DEFAULTS.attack, release: DUCK_DEFAULTS.release };
  return mode === "level" ? { ...rule, detector: DEFAULT_DUCK_DETECTOR, threshold: DEFAULT_DUCK_THRESHOLD } : rule;
}

/**
 * The rule in another mode. To level it keeps a detector and threshold it has and else takes the defaults; to presence it
 * drops both (the parse reports them on a presence rule).
 */
export function ruleWithMode(rule: DuckingRule, mode: DuckingMode): DuckingRule {
  if (mode === "presence") {
    const { detector: _d, threshold: _t, ...rest } = rule;
    return { ...rest, mode };
  }
  return { ...rule, mode, detector: rule.detector ?? DEFAULT_DUCK_DETECTOR, threshold: rule.threshold ?? DEFAULT_DUCK_THRESHOLD };
}

/**
 * One field of a rule changed. Numbers are clamped to their limits; `detector` and `threshold` on a presence rule change
 * nothing (the section doesn't show them there).
 */
export function ruleWithField(rule: DuckingRule, key: keyof DuckingRule, value: string | number): DuckingRule {
  switch (key) {
    case "mode":
      return value === "level" || value === "presence" ? ruleWithMode(rule, value) : rule;
    case "detector":
      return rule.mode === "level" && (value === "peak" || value === "rms") ? { ...rule, detector: value } : rule;
    case "threshold":
      return rule.mode === "level" && typeof value === "number" && Number.isFinite(value) ? { ...rule, threshold: clampTo(value, DUCK_LIMITS.threshold) } : rule;
    case "amount": case "attack": case "release":
      return typeof value === "number" && Number.isFinite(value) ? { ...rule, [key]: clampTo(value, DUCK_LIMITS[key]) } : rule;
    case "target": case "trigger":
      return typeof value === "string" ? { ...rule, [key]: value } : rule;
  }
}

export const levelRuleCount = (rules: readonly Pick<DuckingRule, "mode">[]): number => rules.filter((r) => r.mode === "level").length;

/**
 * Why `rules` can't replace `a`'s ducking list, in the settings parse's own words, or null when the parse keeps every
 * rule and adds no problem of its own: a bus above its target, a level cycle ("ducking[3] (Music ducks Voice): level
 * rules can't form a cycle ... ducking[0] (Voice ducks Music), ducking[3] (Music ducks Voice)"), the 9th level rule,
 * the 33rd rule. Problems the section already had don't count.
 */
export function duckRefusal(a: AudioSettings, rules: readonly DuckingRule[]): string | null {
  const had = new Set(parseAudioSettings(a).problems);
  const parsed = parseAudioSettings({ ...a, ducking: rules });
  const fresh = parsed.problems.filter((p) => !had.has(p));
  if (fresh.length === 0 && parsed.settings.ducking.length === rules.length) return null;
  return fresh.length > 0 ? fresh.join(" ") : "The rule is not valid.";
}

/** Whether the running backend does level ducking: the playing backend's `mixCaps` when known, else the backend the project asks for. */
export function levelDuckingAvailable(backend: AudioSettings["backend"], mixCaps?: { levelDucking: boolean } | null): boolean {
  return mixCaps ? mixCaps.levelDucking : backend !== "babylon";
}

// ---- the gain-reduction model ----

/** What the model reads of one live bus (`Bus.duckGain`, `Bus.activeVoices`, and a level in dBFS when the caller has one). */
export interface DuckBusReading {
  /** The duck lane's gain, 1 = not ducked (`Bus.duckGain`). */
  readonly duckGain: number;
  /** Voices playing on the bus (a presence rule's trigger). */
  readonly activeVoices: number;
  /** The bus's level in dBFS (a level rule's trigger; `-Infinity` or absent: silent). */
  readonly levelDb?: number;
}

/** `(name) => reading`, null while not playing. */
export type ReadDuckBus = (name: string) => DuckBusReading | null;

export interface DuckRuleRow {
  /** The rule's index in `audio.ducking`. */
  readonly index: number;
  readonly trigger: string;
  readonly mode: DuckingMode;
  /** The trigger is doing what the rule listens for right now (voices for presence; level over the threshold for level). */
  readonly engaged: boolean;
  /** A level rule on a backend without level ducking: shows "Needs the audio core" and does nothing. */
  readonly needsCore: boolean;
}

/** One ducked bus. */
export interface DuckRow {
  readonly bus: string;
  /** The duck lane's gain, 1 = not ducked; 1 while not playing. */
  readonly gain: number;
  /** Gain reduction in dB, >= 0 (`gainReductionDb`). */
  readonly reductionDb: number;
  readonly reducing: boolean;
  /** The rule heading lowest (see the file header), or null when not reducing or every rule needs the core. */
  readonly lead: number | null;
  /** The lead's trigger is engaged now; false in a release tail, where the lead is the rule heading lowest. */
  readonly leadEngaged: boolean;
  readonly rules: readonly DuckRuleRow[];
  /** A level rule targets the bus, so its gain-reduction meter shows even while not reducing (`MixerHost.levelDucked`). */
  readonly levelDucked: boolean;
}

/** Reduction in dB (>= 0) from a duck gain (1 = not ducked); NaN and over-unity read as none, gain 0 as 99. */
export function gainReductionDb(duckGain: number): number {
  if (!(duckGain < 1)) return 0;
  if (!(duckGain > 0)) return 99;
  return Math.min(99, -20 * Math.log10(duckGain));
}

/** "-6.0 dB" for a reduction, "0.0 dB" for none. */
export function formatReduction(reductionDb: number): string {
  const r = Math.round(reductionDb * 10) / 10;
  return r > 0 ? `-${r.toFixed(1)} dB` : "0.0 dB";
}

/**
 * One row per bus that is the target of a rule, in order of first appearance. `read` gives live buses (null: not playing,
 * every row at rest); `levelDucking` is whether the backend runs level rules (`levelDuckingAvailable`).
 */
export function buildDuckRows(a: AudioSettings, read: ReadDuckBus = () => null, levelDucking = true): DuckRow[] {
  const targets: string[] = [];
  for (const r of a.ducking) if (!targets.includes(r.target)) targets.push(r.target);
  return targets.map((bus) => {
    const live = read(bus);
    const gain = live && live.duckGain >= 0 && live.duckGain <= 1 ? live.duckGain : 1;
    const rules: DuckRuleRow[] = [];
    a.ducking.forEach((r, index) => {
      if (r.target !== bus) return;
      const mode: DuckingMode = r.mode === "level" ? "level" : "presence";
      const t = read(r.trigger);
      const needsCore = mode === "level" && !levelDucking;
      const engaged = !t || needsCore ? false : mode === "presence" ? t.activeVoices > 0 : (t.levelDb ?? -Infinity) >= (r.threshold ?? DEFAULT_DUCK_THRESHOLD);
      rules.push({ index, trigger: r.trigger, mode, engaged, needsCore });
    });
    const reducing = gain < 1;
    const heading = (row: DuckRuleRow): number => a.ducking[row.index]!.amount;
    const lowest = (rows: readonly DuckRuleRow[]): DuckRuleRow | undefined => rows.reduce<DuckRuleRow | undefined>((best, r) => (!best || heading(r) < heading(best) ? r : best), undefined);
    const live1 = rules.filter((r) => !r.needsCore);
    const engagedLead = reducing ? lowest(live1.filter((r) => r.engaged)) : undefined;
    const lead = reducing ? engagedLead ?? lowest(live1) : undefined;
    return {
      bus,
      gain,
      reductionDb: gainReductionDb(gain),
      reducing,
      lead: lead ? lead.index : null,
      leadEngaged: engagedLead !== undefined,
      rules,
      levelDucked: rules.some((r) => r.mode === "level"),
    };
  });
}
