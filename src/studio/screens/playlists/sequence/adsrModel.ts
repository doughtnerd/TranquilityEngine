// A clip's Amp envelope drawn over it (proto A4 "Amp envelope (ADSR) overlay", spec B.2, decision "ADSR handles are to be
// built"): the shape over clip time (0 → full over Attack, held over Hold, down to Sustain over Decay, held, then to 0
// over Release at the clip's end), its handles (Attack; Hold; Decay and Sustain; Release), and what dragging each one
// sets, clamped to the effect's ranges and so the stages never cross. Values: ms and % as the effect stores them. The
// shape is the engine's model (`ampEnvelope.ts`, ADR 0362), the one the clip's voices play on the audio core, so what is
// drawn is what is heard. Pure.
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import { fitAmpEnvelope } from "../../../../engine/audio/effects/ampEnvelope";
import type { Effect } from "../../../../engine/audio/effects/types";

export interface Adsr {
  readonly attack: number;
  readonly hold: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

export type AdsrHandle = "attack" | "hold" | "decaySustain" | "release";

/** The handles in drawing order: Attack after Hold, so it stays on top while the hold is 0 (they sit together). */
export const ADSR_HANDLES: readonly AdsrHandle[] = ["hold", "attack", "decaySustain", "release"];

const param = (fx: Effect, name: keyof Adsr): number => {
  const v = fx.params[name];
  if (typeof v === "number") return v;
  return effectSpec("envelope").params.find((p) => p.name === name)?.default ?? 0;
};

/** The clip's first Amp envelope, or null. */
export function clipAdsr(effects: readonly Effect[]): { readonly effect: Effect; readonly adsr: Adsr } | null {
  const fx = effects.find((e) => e.type === "envelope");
  if (!fx) return null;
  return { effect: fx, adsr: { attack: param(fx, "attack"), hold: param(fx, "hold"), decay: param(fx, "decay"), sustain: param(fx, "sustain"), release: param(fx, "release") } };
}

/** The shape's corners in (clip seconds, level 0..1), the stages squeezed to fit a short clip as the voices play them. */
export function adsrShape(a: Adsr, length: number): { readonly points: readonly (readonly [number, number])[]; readonly handles: Readonly<Record<AdsrHandle, readonly [number, number]>> } {
  const L = Math.max(0, length);
  const e = fitAmpEnvelope({ attack: a.attack / 1000, hold: a.hold / 1000, decay: a.decay / 1000, sustain: Math.max(0, Math.min(1, a.sustain / 100)), release: a.release / 1000 }, L);
  const att = e.attack, hold = att + e.hold, dec = hold + e.decay, off = e.keyOff ?? L;
  const pts: [number, number][] = [[0, 0], [att, 1], [hold, 1], [dec, e.sustain], [off, e.sustain], [L, 0]];
  return { points: pts, handles: { attack: [att, 1], hold: [hold, 1], decaySustain: [dec, e.sustain], release: [off, e.sustain] } };
}

const range = (name: keyof Adsr) => effectSpec("envelope").params.find((p) => p.name === name)!;
const clamp = (name: keyof Adsr, v: number) => {
  const r = range(name);
  return Math.round(Math.max(r.min, Math.min(r.max, v)));
};

/** The parameters after dragging `handle` to clip time `x` (s) and level `y` (0..1). */
export function dragAdsr(a: Adsr, handle: AdsrHandle, x: number, y: number, length: number): Partial<Adsr> {
  const L = Math.max(0, length);
  const s = (ms: number) => ms / 1000;
  if (handle === "attack") return { attack: clamp("attack", Math.min(x, L - s(a.release) - s(a.decay) - s(a.hold)) * 1000) };
  if (handle === "hold") return { hold: clamp("hold", Math.min(x - s(a.attack), L - s(a.attack) - s(a.decay) - s(a.release)) * 1000) };
  if (handle === "decaySustain") {
    const before = s(a.attack) + s(a.hold);
    return { decay: clamp("decay", Math.min(x - before, L - before - s(a.release)) * 1000), sustain: clamp("sustain", y * 100) };
  }
  return { release: clamp("release", Math.min(L - x, L - s(a.attack) - s(a.hold) - s(a.decay)) * 1000) };
}

/** A handle's tooltip (proto: "Attack 5 ms · drag"). */
export function adsrTip(a: Adsr, handle: AdsrHandle): string {
  if (handle === "attack") return `Attack ${a.attack} ms · drag`;
  if (handle === "hold") return `Hold ${a.hold} ms · drag`;
  if (handle === "decaySustain") return `Decay ${a.decay} ms · Sustain ${a.sustain}% · drag`;
  return `Release ${a.release} ms · drag`;
}
