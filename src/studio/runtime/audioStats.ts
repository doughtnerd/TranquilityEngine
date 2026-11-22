// The runtime's figures for the Studio's status bar, from the public `Audio.debug()` and `Audio.latency`.
import type { AudioDebugInfo, AudioLatency } from "../../plugins/audio/runtime";

export interface StudioAudioStats {
  /** The backend playing ("core"). */
  readonly backend: string;
  readonly status: string;
  /** Hz. */
  readonly sampleRate: number;
  /** Voices mixed now, and the cap. */
  readonly voices: number;
  readonly voiceCap: number;
  /** The core's load, percent; null before it is measured or while hidden (`cpuNote` says why). */
  readonly cpuPercent: number | null;
  readonly cpuNote: string | null;
  /** Buffer underruns so far (audible glitches). */
  readonly underruns: number;
  /** Output latency, ms (base + output + limiter); `latencyReliable` false when the browser's figure is a guess. */
  readonly latencyMs: number;
  readonly latencyReliable: boolean;
  /** ADR 0331 (ABI 4.8): effects that got no effect memory (they pass their signal through), and whose the last was. */
  readonly fxStarved: number;
  readonly fxStarvedOwner: string | null;
}

/** The figures from a debug copy and the latency. Missing parts read as zero or unknown, never throw. */
export function statsFromDebug(info: Pick<AudioDebugInfo, "status" | "sampleRate" | "counters" | "core" | "cpu"> & Partial<Pick<AudioDebugInfo, "mix">>, latency: AudioLatency | null | undefined): StudioAudioStats {
  const cpu = info.cpu;
  const permille = cpu && cpu.hidden === null ? cpu.loadPermille : null;
  return {
    backend: String(info.core?.backend ?? "unknown"),
    status: info.status,
    sampleRate: Number.isFinite(info.sampleRate) ? info.sampleRate : 0,
    voices: info.counters?.mixedVoices ?? 0,
    voiceCap: info.counters?.mixedCap ?? 0,
    cpuPercent: permille === null || permille === undefined ? null : permille / 10,
    cpuNote: cpu?.hidden ?? (permille === null ? "CPU not measured yet" : null),
    underruns: info.counters?.underruns ?? 0,
    latencyMs: latency && Number.isFinite(latency.total) ? latency.total * 1000 : 0,
    latencyReliable: latency?.reliable ?? false,
    fxStarved: info.mix?.fxStarved ?? 0,
    fxStarvedOwner: info.mix?.fxStarvedOwner ?? null,
  };
}
