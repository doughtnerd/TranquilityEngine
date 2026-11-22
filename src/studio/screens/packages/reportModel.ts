// The Packages screen's Report (ADR 0337 §5 step 6, §6, §8): `audio-report.json`'s view without exporting — per platform,
// each sound's shipped size and memory, each package's size and memory, the totals and the budget warnings. Estimated from
// the plan and the sources' facts (`encoding/estimate.ts`) until Convert now runs the export's audio step for the platform;
// then exact, from its report. The totals follow the export's rules: a packaged sound's bytes count once per package that
// holds it, a packaged streamed sound's loose media once plus its prefetch head per package; memory is the static bound,
// the preload packages plus the largest other package. Budgets are tripwires: past one, a warning, never a failure. Pure.
import type { AudioBudget, EncodingConfig, LoadMode } from "../../../engine/audio/encoding/types";
import type { PackCodec } from "../../../engine/audio/packaging/format";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { AudioPlan, AudioReport } from "../../../export/audio";
import { estimateShipped, formatBytes, runtimeMemory, type SourceFacts } from "../../encoding/estimate";

const MB = 1024 * 1024;

export interface ReportSound {
  readonly path: string;
  /** The profile in force (the nearest the resolver consulted), or null for the built-in defaults. */
  readonly profile: string | null;
  readonly codec: PackCodec;
  readonly load: LoadMode;
  /** Download bytes of one copy (null while its length isn't known). */
  readonly bytes: number | null;
  readonly memoryBytes: number | null;
  readonly packages: readonly string[];
  readonly notes: readonly string[];
}

export interface ReportPackage {
  readonly name: string;
  readonly preload: boolean;
  readonly bytes: number;
  readonly memoryBytes: number;
  readonly sounds: number;
  readonly problems: readonly string[];
}

export interface PlatformReport {
  readonly platform: ImportPlatform;
  /** From a Convert now (the export's own figures), else estimated. */
  readonly exact: boolean;
  readonly sounds: readonly ReportSound[];
  readonly packages: readonly ReportPackage[];
  readonly totals: { readonly files: number; readonly sourceBytes: number; readonly shippedBytes: number; readonly memoryBytes: number };
  /** Sounds whose size isn't known yet (their facts are still being read); their share is missing from the totals. */
  readonly unknown: number;
  readonly budget: AudioBudget;
  readonly warnings: readonly string[];
  readonly overDownload: boolean;
  readonly overMemory: boolean;
  readonly problems: readonly string[];
}

/** The budget warnings of `shipped` and `memory` bytes against `budget` (the export's words). */
export function budgetWarnings(platform: ImportPlatform, budget: AudioBudget, shipped: number, memory: number): { warnings: string[]; overDownload: boolean; overMemory: boolean } {
  const warnings: string[] = [];
  const overDownload = budget.downloadMB !== undefined && shipped > budget.downloadMB * MB;
  const overMemory = budget.memoryMB !== undefined && memory > budget.memoryMB * MB;
  if (overDownload) warnings.push(`audio download ${(shipped / MB).toFixed(1)} MB is over the ${platform} budget of ${budget.downloadMB} MB.`);
  if (overMemory) warnings.push(`audio memory ${(memory / MB).toFixed(1)} MB (preload packages plus the largest other package) is over the ${platform} budget of ${budget.memoryMB} MB.`);
  return { warnings, overDownload, overMemory };
}

/** The static memory bound: the preload packages plus the largest other package. */
export const memoryBound = (packages: readonly Pick<ReportPackage, "preload" | "memoryBytes">[]): number =>
  packages.filter((p) => p.preload).reduce((n, p) => n + p.memoryBytes, 0) + packages.filter((p) => !p.preload).reduce((m, p) => Math.max(m, p.memoryBytes), 0);

/** The report estimated from `plan` and each sound's source facts. */
export function estimatedReport(plan: AudioPlan, facts: (path: string) => SourceFacts): PlatformReport {
  const sounds: ReportSound[] = [];
  const pk = new Map(plan.packages.map((p) => [p.def.name, { bytes: 0, memoryBytes: 0, sounds: 0 }]));
  let shipped = 0, source = 0, unknown = 0;
  for (const s of plan.sounds) {
    const f = facts(s.path);
    source += f.bytes;
    const est = estimateShipped(f, s.codec, s.resolution.settings, s.ambisonic);
    if (!est) unknown++;
    const bytes = est?.bytes ?? null;
    const memory = est?.memoryBytes ?? null;
    sounds.push({ path: s.path, profile: s.resolution.profiles[0]?.name ?? null, codec: est?.codec ?? s.codec, load: s.load, bytes, memoryBytes: memory, packages: s.packages, notes: s.notes });
    if (bytes === null) continue;
    if (s.packages.length === 0) shipped += bytes;
    else {
      const head = s.load === "stream" && est ? runtimeMemory("stream", "pcm", est.frames, est.channels, 0, Math.round((s.resolution.settings.prefetchMs / 1000) * est.rate)) : 0;
      if (s.load === "stream") shipped += bytes;
      for (const name of s.packages) {
        const p = pk.get(name);
        if (!p) continue;
        p.bytes += s.load === "stream" ? head : bytes;
        p.memoryBytes += memory ?? 0;
        p.sounds++;
      }
    }
  }
  const packages: ReportPackage[] = plan.packages.map((p) => ({ name: p.def.name, preload: p.def.preload, ...pk.get(p.def.name)!, problems: p.problems }));
  shipped += packages.reduce((n, p) => n + p.bytes, 0);
  const memory = memoryBound(packages);
  const budget = plan.config.budgets[plan.platform] ?? {};
  return {
    platform: plan.platform, exact: false, sounds, packages,
    totals: { files: sounds.length, sourceBytes: source, shippedBytes: shipped, memoryBytes: memory },
    unknown, budget, ...budgetWarnings(plan.platform, budget, shipped, memory), problems: plan.problems,
  };
}

/** The report of a Convert now (the export's `AudioReport`), with the budgets as `audio.json` holds them now. */
export function exactReport(r: AudioReport, config: EncodingConfig): PlatformReport {
  const budget = config.budgets[r.platform] ?? {};
  const sounds: ReportSound[] = r.sounds.map((s) => ({
    path: s.path, profile: null, codec: s.codec, load: s.load, bytes: s.packages.length > 0 ? Math.round(s.shippedBytes / Math.max(1, s.packages.length)) : s.shippedBytes,
    memoryBytes: s.memoryBytes, packages: s.packages, notes: s.notes,
  }));
  const packages: ReportPackage[] = r.packages.map((p) => ({ name: p.name, preload: p.preload, bytes: p.bytes, memoryBytes: p.memoryBytes, sounds: p.sounds.length, problems: p.problems }));
  return {
    platform: r.platform, exact: true, sounds, packages, totals: r.totals, unknown: 0, budget,
    ...budgetWarnings(r.platform, budget, r.totals.shippedBytes, r.totals.memoryBytes), problems: r.problems,
  };
}

/** A budget bar: the share of the budget used (may pass 1) and its words, or null without a budget. */
export function budgetBar(bytes: number, mb: number | undefined): { share: number; text: string; over: boolean } | null {
  if (mb === undefined) return null;
  const share = mb > 0 ? bytes / (mb * MB) : bytes > 0 ? Infinity : 0;
  return { share, text: `${formatBytes(bytes)} of ${mb} MB`, over: share > 1 };
}
