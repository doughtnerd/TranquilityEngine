// A clip's Amp envelope drawn over it (proto A4 "Amp envelope (ADSR) overlay", spec B.2, decision "ADSR handles are to be
// built"): the shape over clip time (0 → full over Attack, down to Sustain over Decay, held, then to 0 over Release at
// the clip's end), its three handles (Attack; Decay and Sustain; Release), and what dragging each one sets, clamped to
// the effect's ranges and so the stages never cross. Values: ms and % as the effect stores them. Pure.
import { effectSpec } from "../../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../../engine/audio/effects/types";

export interface Adsr {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

export type AdsrHandle = "attack" | "decaySustain" | "release";

const param = (fx: Effect, name: keyof Adsr): number => {
  const v = fx.params[name];
  if (typeof v === "number") return v;
  return effectSpec("envelope").params.find((p) => p.name === name)?.default ?? 0;
};

/** The clip's first Amp envelope, or null. */
export function clipAdsr(effects: readonly Effect[]): { readonly effect: Effect; readonly adsr: Adsr } | null {
  const fx = effects.find((e) => e.type === "envelope");
  if (!fx) return null;
  return { effect: fx, adsr: { attack: param(fx, "attack"), decay: param(fx, "decay"), sustain: param(fx, "sustain"), release: param(fx, "release") } };
}

/** The shape's corners in (clip seconds, level 0..1), the stages squeezed to fit a short clip. */
export function adsrShape(a: Adsr, length: number): { readonly points: readonly (readonly [number, number])[]; readonly handles: Readonly<Record<AdsrHandle, readonly [number, number]>> } {
  const L = Math.max(0, length);
  const att = Math.min(L, a.attack / 1000);
  const dec = Math.min(L - att, a.decay / 1000);
  const rel = Math.min(L - att - dec, a.release / 1000);
  const s = Math.max(0, Math.min(1, a.sustain / 100));
  const pts: [number, number][] = [[0, 0], [att, 1], [att + dec, s], [L - rel, s], [L, 0]];
  return { points: pts, handles: { attack: [att, 1], decaySustain: [att + dec, s], release: [L - rel, s] } };
}

const range = (name: keyof Adsr) => effectSpec("envelope").params.find((p) => p.name === name)!;
const clamp = (name: keyof Adsr, v: number) => {
  const r = range(name);
  return Math.round(Math.max(r.min, Math.min(r.max, v)));
};

/** The parameters after dragging `handle` to clip time `x` (s) and level `y` (0..1). */
export function dragAdsr(a: Adsr, handle: AdsrHandle, x: number, y: number, length: number): Partial<Adsr> {
  const L = Math.max(0, length);
  if (handle === "attack") return { attack: clamp("attack", Math.min(x, L - a.release / 1000 - a.decay / 1000) * 1000) };
  if (handle === "decaySustain") {
    const att = a.attack / 1000;
    return { decay: clamp("decay", Math.min(x - att, L - att - a.release / 1000) * 1000), sustain: clamp("sustain", y * 100) };
  }
  return { release: clamp("release", Math.min(L - x, L - a.attack / 1000 - a.decay / 1000) * 1000) };
}

/** A handle's tooltip (proto: "Attack 5 ms · drag"). */
export function adsrTip(a: Adsr, handle: AdsrHandle): string {
  if (handle === "attack") return `Attack ${a.attack} ms · drag`;
  if (handle === "decaySustain") return `Decay ${a.decay} ms · Sustain ${a.sustain}% · drag`;
  return `Release ${a.release} ms · drag`;
}
