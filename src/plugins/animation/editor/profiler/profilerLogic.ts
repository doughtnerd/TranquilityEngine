// The Animation table's rows (T34, ADR 0370 "an Animation table: instances evaluated, skipped by LOD, time per
// stage"): a frame-stats snapshot into the rows the Play Stats panel shows. Pure: no DOM, no engine.
//
// There are no per-Animator rows: the core reports counts per `evaluate` call, not per instance (see
// `runtime/core/frameMeter.ts`), so the table is the World's totals.
import type { PlayStatsRow } from "../../../../editor/sdk";
import type { AnimationFrameStats } from "../../runtime/core/frameMeter";

/** The core's memory, bytes: what it holds now and what its limits asked for. */
export interface CoreMemory {
  readonly memoryBytes: number;
  readonly neededBytes: number;
}

/** Milliseconds with two decimals. */
export const formatMs = (ms: number): string => `${ms.toFixed(2)} ms`;

/** A per-frame average: whole numbers plain, fractions with one decimal ("12", "0.5"). */
export const formatCount = (n: number): string => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

/** Bytes as MB with one decimal. */
export const formatMegabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Instruction fuel as thousands ("12.3k") or millions ("1.2M"). */
export const formatFuel = (fuel: number): string => (fuel >= 1e6 ? `${(fuel / 1e6).toFixed(1)}M` : fuel >= 1e3 ? `${(fuel / 1e3).toFixed(1)}k` : String(Math.round(fuel)));

/** The table's rows for one World: stage times, instance counts, memory, third-party node fuel and faults. */
export function animationRows(stats: AnimationFrameStats, memory: CoreMemory): PlayStatsRow[] {
  const total = stats.gatherMs + stats.evaluateMs + stats.applyMs;
  const rows: PlayStatsRow[] = [
    { label: "Frame", value: formatMs(total), detail: `gather ${formatMs(stats.gatherMs)} · apply ${formatMs(stats.applyMs)}` },
    { label: "Evaluate", value: formatMs(stats.evaluateMs), detail: "core: graphs, rigs, tweens, skinning" },
    { label: "Instances", value: formatCount(stats.active), detail: `of ${formatCount(stats.instances)} · culled ${formatCount(stats.culled)}` },
    { label: "LOD skipped", value: formatCount(stats.lodSkipped) },
    { label: "Evaluated", value: formatCount(stats.evaluated), detail: `${formatCount(stats.bones)} bones` },
    { label: "Skinned", value: formatCount(stats.skinned), detail: "bone matrices written" },
    { label: "Core memory", value: formatMegabytes(memory.memoryBytes), detail: `limits need ${formatMegabytes(memory.neededBytes)}` },
    { label: "Node fuel", value: formatFuel(stats.nodeFuel), detail: "third-party nodes, per frame" },
    { label: "Node faults", value: String(stats.faults) },
  ];
  return rows;
}
