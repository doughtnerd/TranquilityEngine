// The Profiler's effects-cost track (ADR 0334 "effects cost per level", ADR 0331). The core's STATUS doesn't report the
// cost of each effect yet; what a capture carries is the CPU meter's work units per section, from which the editor's CPU
// track fits an estimated share of each quantum per section (`tracks/cpu.ts`, `cpu.sections`). The levels effects run at
// fall in those sections: voice (and instance) effects in Voices, bus and return effects in Buses; Spatial, Music and
// Loudness are the rest of the DSP. So the track draws those estimated shares, one lane each, in permille of a quantum,
// and says it is an estimate. Pure.
import { CPU_SECTION_COLORS, type CpuSectionKey } from "../../../plugins/audio/editor/mix/tracks/cpu";
import type { LineSeries } from "../../../plugins/audio/editor/mix/drawTimeline";
import { valueAt } from "./timelineGeometry";

/** Each section's lane label, and what of the DSP it holds. */
export const EFFECT_SECTIONS: Readonly<Record<CpuSectionKey, { readonly label: string; readonly holds: string }>> = {
  voices: { label: "Voices", holds: "voice and instance effects, resampling and voice gain" },
  buses: { label: "Buses", holds: "bus and return effects and mixing" },
  spatial: { label: "Spatial", holds: "panning, HRTF and Doppler" },
  music: { label: "Music", holds: "music streams" },
  loudness: { label: "Loudness", holds: "loudness metering" },
};

/** The sections in the order the CPU track lists its lanes. */
const ORDER = Object.keys(CPU_SECTION_COLORS) as CpuSectionKey[];

export interface EffectsCostLane {
  readonly key: CpuSectionKey;
  readonly label: string;
  readonly times: ArrayLike<number>;
  /** Estimated share of each quantum, permille. */
  readonly values: ArrayLike<number>;
}

export interface EffectsCost {
  readonly lanes: readonly EffectsCostLane[];
  /** The shared scale's top, permille (at least a whole quantum, 1000). */
  readonly peak: number;
}

/** The track from the CPU track's section lines (one per section, in its order); null when no sample was fitted. */
export function effectsCost(lines: readonly LineSeries[] | undefined): EffectsCost | null {
  if (!lines || lines.length === 0 || lines.every((l) => l.times.length === 0)) return null;
  const lanes = lines.slice(0, ORDER.length).map((l, i) => ({ key: ORDER[i]!, label: EFFECT_SECTIONS[ORDER[i]!].label, times: l.times, values: l.values }));
  return { lanes, peak: Math.max(1000, ...lines.map((l) => l.yMax ?? 0)) };
}

/** The track's value at `t`: the two costliest sections then, e.g. "Voices 312‰ · Buses 140‰"; null before the first sample. */
export function effectsCostText(cost: EffectsCost, t: number): string | null {
  const now = cost.lanes.map((l) => ({ label: l.label, v: valueAt(l, t) })).filter((x): x is { label: string; v: number } => x.v !== null && Number.isFinite(x.v));
  if (now.length === 0) return null;
  return now
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
    .map((x) => `${x.label} ${Math.round(x.v)}‰`)
    .join(" · ");
}
