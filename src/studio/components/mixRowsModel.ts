// The mixer's send and ducking rows (ADR 0349 `SendRow`, `DuckRow`; ADR 0344 sends, ducking): what a collapsed row
// says, which buses a ducking rule may be triggered by, and each row's edits as `{ next } | { refused }`, held to the
// limits `audio.json`'s parse declares (`MIX_LIMITS`), so the owner applies them as undo steps.
import type { MenuEntry } from "../../editor/ui/ContextMenu";
import { MIX_LIMITS } from "../../engine/audio/project/format";
import type { DuckingRule, Send } from "../../engine/audio/project/types";
import type { EditResult } from "../../plugins/audio/editor/editResult";
import { FADER_MAX_DB, FADER_MIN_DB, formatDb, snapFaderDb } from "./faderModel";

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** A send's level set to `db` (the fader's range and grid). */
export function editSendLevel(send: Send, db: number): EditResult<Send> {
  if (!Number.isFinite(db) && db !== -Infinity) return { refused: "the level must be a number" };
  const levelDb = snapFaderDb(clamp(db, [FADER_MIN_DB, FADER_MAX_DB]));
  return { next: levelDb === send.levelDb ? send : { ...send, levelDb } };
}

/** A collapsed send row's summary ("→ Reverb · −12.0 dB"). */
export const sendSummary = (send: Send): string => `→ ${send.to} · ${formatDb(send.levelDb)} dB`;

/** The returns `bus` may still send to: not Master, and not a return it already sends to. */
export function sendTargets(returns: readonly string[], bus: string, sends: readonly Send[], master = "Master"): { name: string; disabled: string | null }[] {
  return returns.map((name) => ({
    name,
    disabled: bus === master ? "Master can't send" : sends.some((s) => s.to === name) ? "already" : null,
  }));
}

/** A collapsed ducking row's summary ("−6.0 dB · while playing", "−8.0 dB · above −20 dBFS", or "Off"). */
export function duckSummary(rule: DuckingRule): string {
  if (!rule.enabled) return "Off";
  const when = rule.mode === "level" ? `above ${formatDb(rule.thresholdDb)} dBFS` : "while playing";
  return `${formatDb(rule.amountDb)} dB · ${when}`;
}

/** What a ducking row may change. */
export type DuckPatch = Partial<Pick<DuckingRule, "trigger" | "mode" | "detector" | "thresholdDb" | "amountDb" | "attackMs" | "releaseMs" | "enabled">>;

/**
 * A ducking rule with `patch` applied: numbers held to the parse's limits (threshold −80..0 dBFS, amount −60..0 dB,
 * attack and release 0..10 000 ms). Refused when the trigger would be the ducked bus itself.
 */
export function editDuck(rule: DuckingRule, patch: DuckPatch): EditResult<DuckingRule> {
  const next: DuckingRule = { ...rule };
  if (patch.trigger !== undefined) {
    if (patch.trigger === rule.target) return { refused: `${rule.target} can't duck itself` };
    next.trigger = patch.trigger;
  }
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.detector !== undefined) next.detector = patch.detector;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  for (const [key, limits] of [["thresholdDb", MIX_LIMITS.thresholdDb], ["amountDb", MIX_LIMITS.amountDb], ["attackMs", MIX_LIMITS.duckMs], ["releaseMs", MIX_LIMITS.duckMs]] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) return { refused: "the value must be a number" };
    next[key] = clamp(v, limits);
  }
  const same = (Object.keys(next) as (keyof DuckingRule)[]).every((k) => next[k] === rule[k]);
  return { next: same ? rule : next };
}

/**
 * The buses a rule ducking `target` may be triggered by, in the order given, each with why it can't be (or null):
 * the ducked bus itself, Master, a bus above the target (its level includes the target's), or a trigger another rule
 * on the target already uses ("already"). `current` (the row's own trigger) stays pickable.
 */
export function duckTriggerOptions(
  names: readonly string[],
  target: string,
  rules: readonly DuckingRule[],
  parentOf: (name: string) => string | null,
  current?: string,
  master = "Master",
): { name: string; disabled: string | null }[] {
  const above = new Set<string>();
  for (let p = parentOf(target), guard = 0; p !== null && guard < 64; p = parentOf(p), guard++) above.add(p);
  return names.map((name) => ({
    name,
    disabled:
      name === target ? "the ducked bus" : name === master ? "Master can't trigger" : above.has(name) ? `contains ${target}` : name !== current && rules.some((r) => r.target === target && r.trigger === name) ? "already" : null,
  }));
}

/**
 * MX-33: the "Ducked by" menu: every bus that may trigger the rule, the current one checked, the others that can't with
 * their reason as a muted note ("already", "Master can't trigger"); choosing one calls `choose`.
 */
export function triggerEntries(triggers: readonly { readonly name: string; readonly disabled: string | null }[], current: string, choose: (name: string) => void): MenuEntry[] {
  return [
    { kind: "group", label: "Duck when this plays" },
    ...triggers.map((t): MenuEntry => ({
      id: t.name,
      label: t.name,
      checked: t.name === current,
      disabled: t.disabled !== null && t.name !== current,
      ...(t.disabled !== null && t.name !== current ? { note: t.disabled } : {}),
      run: () => {
        if (t.name !== current) choose(t.name);
      },
    })),
  ];
}
