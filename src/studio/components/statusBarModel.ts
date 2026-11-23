// What the Studio's status bar says (ADR 0349 `StudioStatusBar`): the runtime's state and figures from its public
// debug info ("Rust core · 48 kHz · Voices 3 / 64 · CPU 4.2 % · 23 ms"), and trouble in words (locked, failed,
// underruns), each part with a tooltip saying more.
import type { StudioAudioStats } from "../runtime/audioStats";
import type { StudioAudioState } from "../runtime/studioAudioHost";

export interface StatusPart {
  readonly text: string;
  readonly tone?: "muted" | "warning" | "danger" | "success";
  readonly title?: string;
}

const khz = (hz: number) => `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;

/** The parts, left to right. */
export function statusParts(state: StudioAudioState, stats: StudioAudioStats | null): StatusPart[] {
  switch (state.kind) {
    case "idle":
      return [{ text: "No project open", tone: "muted" }];
    case "starting":
      return [{ text: "Starting the Rust audio core…", tone: "muted" }];
    case "failed":
      return [{ text: "Audio core unavailable", tone: "danger", title: state.reason }];
    case "locked":
      return [
        { text: "Rust core", title: "The Studio plays through the engine's Rust audio core" },
        { text: "Click anywhere to start audio", tone: "warning", title: "Browsers start audio only after a click or a key press" },
      ];
    case "running": {
      const parts: StatusPart[] = [{ text: "Rust core", tone: "success", title: "The Studio plays through the engine's Rust audio core" }];
      if (!stats) return parts;
      if (stats.sampleRate > 0) parts.push({ text: khz(stats.sampleRate), title: "Sample rate" });
      parts.push({ text: `Voices ${stats.voices} / ${stats.voiceCap}`, title: "Voices mixed now, of the voice cap", tone: stats.voiceCap > 0 && stats.voices >= stats.voiceCap ? "warning" : undefined });
      parts.push(stats.cpuPercent === null ? { text: "CPU —", tone: "muted", title: stats.cpuNote ?? "CPU not measured yet" } : { text: `CPU ${stats.cpuPercent.toFixed(1)} %`, title: "The audio core's share of its time budget", tone: stats.cpuPercent >= 80 ? "warning" : undefined });
      if (stats.latencyMs > 0) parts.push({ text: `${Math.round(stats.latencyMs)} ms`, title: stats.latencyReliable ? "Output latency" : "Output latency (the browser's estimate)", tone: stats.latencyReliable ? undefined : "muted" });
      if (stats.underruns > 0) parts.push({ text: `${stats.underruns} underrun${stats.underruns === 1 ? "" : "s"}`, tone: "warning", title: "Times the core couldn't fill the output in time (audible glitches)" });
      if (stats.fxStarved > 0) parts.push({ text: "Effect memory full", tone: "warning", title: `${stats.fxStarved} effect${stats.fxStarved === 1 ? "" : "s"} got no effect memory and pass${stats.fxStarved === 1 ? "es" : ""} the sound through unprocessed${stats.fxStarvedOwner ? ` (last: ${stats.fxStarvedOwner})` : ""}. Shorten delay times or run fewer delays, reverbs, chorus and pitch shifters.` });
      return parts;
    }
  }
}
