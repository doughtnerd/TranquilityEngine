// The baked effect chain's edits (ADR 0342, 0345 level "sample"): add from the catalogue, remove, bypass, reorder,
// set a parameter; one labelled step each ("Add EQ", "Bypass Fades", "Move EQ up", "EQ · Low 3 dB"). Pure.
import { defaultEffect, effectSpec } from "../../../engine/audio/effects/catalogue";
import type { EffectType } from "../../../engine/audio/effects/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { withoutLanesOf } from "./sampleAutomation";
import { freeId } from "./sampleEditing";

export const effectEdits = {
  add: (e: SampleEdits, type: EffectType): { next: SampleEdits; label: string } => ({ next: { ...e, effects: [...e.effects, defaultEffect(type, freeId("fx", e.effects.map((f) => f.id)))] }, label: `Add ${effectSpec(type).label}` }),
  /** Its automation lanes go with it. */
  remove: (e: SampleEdits, id: string) => ({ next: { ...e, effects: e.effects.filter((f) => f.id !== id), automation: withoutLanesOf(e, id) }, label: `Remove ${labelOf(e, id)}` }),
  bypass: (e: SampleEdits, id: string) => {
    const f = e.effects.find((x) => x.id === id)!;
    return { next: { ...e, effects: e.effects.map((x) => (x.id === id ? { ...x, on: !x.on } : x)) }, label: `${f.on ? "Bypass" : "Turn on"} ${labelOf(e, id)}` };
  },
  move: (e: SampleEdits, id: string, dir: -1 | 1) => {
    const i = e.effects.findIndex((x) => x.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= e.effects.length) return { refused: "it's already at that end" } as const;
    const list = [...e.effects];
    [list[i], list[j]] = [list[j], list[i]];
    return { next: { ...e, effects: list }, label: `Move ${labelOf(e, id)} ${dir < 0 ? "up" : "down"}` };
  },
  param: (e: SampleEdits, id: string, name: string, value: number) => {
    const f = e.effects.find((x) => x.id === id)!;
    const spec = effectSpec(f.type).params.find((p) => p.name === name)!;
    return { next: { ...e, effects: e.effects.map((x) => (x.id === id ? { ...x, params: { ...x.params, [name]: value } } : x)) }, label: `${effectSpec(f.type).label} · ${spec.label} ${value}${spec.unit ? ` ${spec.unit}` : ""}` };
  },
};

/** Freeze (spec §4.1.7, §2.11): keep the current render as fixed audio and lock the chain; again unfreezes. */
export const freezeEdit = (e: SampleEdits): { next: SampleEdits; label: string } => ({ next: { ...e, frozen: !e.frozen }, label: e.frozen ? "Unfreeze" : "Freeze" });

/** The Add effect menu's categories (the prototype's combo), in order; a type in none falls under Other. */
export const EFFECT_CATEGORIES: readonly { readonly name: string; readonly types: readonly EffectType[] }[] = [
  { name: "Colour", types: ["saturation", "distortion", "bitcrush"] },
  { name: "Dynamics", types: ["compressor", "gain"] },
  { name: "EQ & filter", types: ["eq", "highpass", "lowpass", "bandpass"] },
  { name: "Envelope", types: ["fades"] },
  { name: "Pitch & time", types: ["pitchShift", "formantShift", "reverse"] },
  { name: "Restoration", types: ["noiseReduction"] },
];

/** The categories holding `available` types (each with only those), plus Other for the rest. Empty categories drop. */
export function effectCategories(available: readonly EffectType[]): { name: string; types: EffectType[] }[] {
  const placed = new Set<EffectType>();
  const out = EFFECT_CATEGORIES.map((c) => ({ name: c.name, types: c.types.filter((t) => available.includes(t) && (placed.add(t), true)) }));
  const rest = available.filter((t) => !placed.has(t));
  if (rest.length) out.push({ name: "Other", types: rest });
  return out.filter((c) => c.types.length > 0);
}

/** Types whose name holds `query` (case-insensitive), with their category, in menu order. */
export function searchEffects(available: readonly EffectType[], query: string): { type: EffectType; category: string }[] {
  const q = query.trim().toLowerCase();
  return effectCategories(available).flatMap((c) => c.types.filter((t) => effectSpec(t).label.toLowerCase().includes(q)).map((type) => ({ type, category: c.name })));
}

/** An effect row's summary line: its parameters ("Threshold −18 dB · Ratio 3:1"), or "whole sample" with none. */
export function effectSummary(f: { type: EffectType; params: Readonly<Record<string, number>> }): string {
  const spec = effectSpec(f.type);
  if (spec.params.length === 0) return "whole sample";
  return spec.params
    .slice(0, 3)
    .map((p) => {
      const v = f.params[p.name] ?? p.default;
      const n = Math.abs(v) >= 1000 && p.unit === "Hz" ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100);
      return `${p.label} ${n.replace("-", "−")}${p.unit === ":1" ? ":1" : p.unit ? ` ${p.unit}` : ""}`;
    })
    .join(" · ");
}

function labelOf(e: SampleEdits, id: string): string {
  const f = e.effects.find((x) => x.id === id);
  return f ? effectSpec(f.type).label : "effect";
}

