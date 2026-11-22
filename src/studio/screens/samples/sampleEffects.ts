// The baked effect chain's edits (ADR 0328, 0331 level "sample"): add from the catalogue, remove, bypass, reorder,
// set a parameter; one labelled step each ("Add EQ", "Bypass Fades", "Move EQ up", "EQ · Low 3 dB"). Pure.
import { defaultEffect, effectSpec } from "../../../engine/audio/effects/catalogue";
import type { EffectType } from "../../../engine/audio/effects/types";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { freeId } from "./sampleEditing";

export const effectEdits = {
  add: (e: SampleEdits, type: EffectType): { next: SampleEdits; label: string } => ({ next: { ...e, effects: [...e.effects, defaultEffect(type, freeId("fx", e.effects.map((f) => f.id)))] }, label: `Add ${effectSpec(type).label}` }),
  remove: (e: SampleEdits, id: string) => ({ next: { ...e, effects: e.effects.filter((f) => f.id !== id) }, label: `Remove ${labelOf(e, id)}` }),
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

function labelOf(e: SampleEdits, id: string): string {
  const f = e.effects.find((x) => x.id === id);
  return f ? effectSpec(f.type).label : "effect";
}

