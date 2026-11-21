// The ducking rule's editing model and the gain reduction (ADR 0171 §2.1, §7 amended by ADR 0172; task Dk1). Pure:
// no Preact, no editor, no backend.
//
// Editing: a rule's fields and limits (`mode`, `detector`, `threshold`, `amount`, `attack`, `release`), a new rule's
// defaults (a level rule, RMS detector, -30 dBFS: owner decision 8), the mode switch (a presence rule carries no
// `detector` or `threshold`, so the parse has nothing to report), and `duckRefusal`, which asks the settings parse itself
// whether a list of rules would lose one, so the section shows the parse's own message (a level cycle naming its rules,
// the 9th level rule, the 33rd rule) and never saves the rule.
//
// Reading: a ducked bus's reduction in dB from its duck lane's gain (STATUS `busDuck` through `Bus.duckGain`).
import { reasonMessage } from "../../../../engine/audio/busCapability";
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

/** What a level rule answers on a backend without level ducking (the Babylon fallback; ADR 0175's `needsAudioCore` reason). */
export const NEEDS_AUDIO_CORE = reasonMessage("needsAudioCore");

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
const DUCK_DEFAULTS = { amount: 0.4, attack: 0.1, release: 0.5 } as const;

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
function ruleWithMode(rule: DuckingRule, mode: DuckingMode): DuckingRule {
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
