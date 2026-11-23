// What the Studio's status bar says (ADR 0349 `StudioStatusBar`; the prototype's status bar, spec §3.6), from real data:
// on the left the audio core and its figures from its public debug info ("Rust core · 48 kHz", "Voices 3 / 4,096",
// "CPU 1.8%") and the playhead or the game session's clock ("Playhead 00:00.520"); on the right the device ("Device
// OK", or the trouble in words: underruns, the output changed since calibrating), the voice cap, the meters and whether
// the document in hand is saved. Each part has a tooltip saying more.
import type { StudioAudioStats } from "../runtime/audioStats";
import type { StudioAudioState } from "../runtime/studioAudioHost";
import { formatClock } from "./replayControlsModel";

export interface StatusPart {
  readonly text: string;
  readonly tone?: "muted" | "warning" | "danger" | "success";
  readonly title?: string;
}

export interface StatusContext {
  /** The screen's playhead, or the game session's clock, seconds. */
  readonly clock?: { readonly label: "Playhead" | "Session"; readonly seconds: number } | null;
  /** The document in hand: written to its file, holding edits not yet written, or in a read-only project. */
  readonly document?: "saved" | "unsaved" | "readOnly" | null;
  /** The output changed since the audio offset was set. */
  readonly stale?: boolean;
}

export interface StatusReadouts {
  readonly left: readonly StatusPart[];
  readonly right: readonly StatusPart[];
}

const khz = (hz: number) => `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;
const count = (n: number) => n.toLocaleString("en-US");

function documentPart(doc: StatusContext["document"]): StatusPart[] {
  if (doc === "saved") return [{ text: "Saved", title: "Every edit is written to its file" }];
  if (doc === "unsaved") return [{ text: "Unsaved", tone: "warning", title: "The document in hand has edits not written to its file yet" }];
  if (doc === "readOnly") return [{ text: "Read-only", tone: "warning", title: "This project can't be saved to" }];
  return [];
}

/** The readouts, left and right, each left to right. */
export function statusReadouts(state: StudioAudioState, stats: StudioAudioStats | null, ctx: StatusContext = {}): StatusReadouts {
  const doc = documentPart(ctx.document);
  const clock = ctx.clock ? [{ text: `${ctx.clock.label} ${formatClock(ctx.clock.seconds)}`, title: ctx.clock.label === "Playhead" ? "The playhead" : "The game session's clock (the open take's time)" }] : [];
  switch (state.kind) {
    case "idle":
      return { left: [{ text: "No project open", tone: "muted" }], right: [] };
    case "starting":
      return { left: [{ text: "Starting the Rust audio core…", tone: "muted" }], right: doc };
    case "failed":
      return { left: [{ text: "Audio core unavailable", tone: "danger", title: state.reason }], right: doc };
    case "locked":
      return {
        left: [{ text: "Rust core", title: "The Studio plays through the engine's Rust audio core" }, ...clock],
        right: [{ text: "Click anywhere to start audio", tone: "warning", title: "Browsers start audio only after a click or a key press" }, ...doc],
      };
    case "running": {
      const core: StatusPart = { text: stats && stats.sampleRate > 0 ? `Rust core · ${khz(stats.sampleRate)}` : "Rust core", title: "The Studio plays through the engine's Rust audio core, at this sample rate" };
      if (!stats) return { left: [core, ...clock], right: [{ text: "Meters: live", title: "Meters follow the audio core" }, ...doc] };
      const full = stats.voiceCap > 0 && stats.voices >= stats.voiceCap;
      const left: StatusPart[] = [
        core,
        { text: `Voices ${count(stats.voices)} / ${count(stats.voiceCap)}`, title: "Voices mixed now, of the voice cap", tone: full ? "warning" : undefined },
        stats.cpuPercent === null ? { text: "CPU —", tone: "muted", title: stats.cpuNote ?? "CPU not measured yet" } : { text: `CPU ${stats.cpuPercent.toFixed(1)}%`, title: "The audio core's share of its time budget", tone: stats.cpuPercent >= 80 ? "warning" : undefined },
        ...clock,
      ];
      const right: StatusPart[] = [];
      if (stats.underruns > 0) right.push({ text: `${stats.underruns} underrun${stats.underruns === 1 ? "" : "s"}`, tone: "warning", title: "Times the core couldn't fill the output in time (audible glitches)" });
      else if (ctx.stale) right.push({ text: "Device changed", tone: "warning", title: "The output changed since the audio offset was set: calibrate again in the device menu" });
      else right.push({ text: "Device OK", tone: "success", title: `The output plays without glitches${stats.latencyMs > 0 ? ` · latency ${Math.round(stats.latencyMs)} ms${stats.latencyReliable ? "" : " (the browser's estimate)"}` : ""}` });
      right.push(full ? { text: "Voice cap: full", tone: "warning", title: `All ${count(stats.voiceCap)} voices are in use: the quietest or oldest give way to new ones` } : { text: "Voice cap: OK", title: `${count(stats.voices)} of ${count(stats.voiceCap)} voices in use` });
      if (stats.fxStarved > 0) right.push({ text: "Effect memory full", tone: "warning", title: `${stats.fxStarved} effect${stats.fxStarved === 1 ? "" : "s"} got no effect memory and pass${stats.fxStarved === 1 ? "es" : ""} the sound through unprocessed${stats.fxStarvedOwner ? ` (last: ${stats.fxStarvedOwner})` : ""}. Shorten delay times or run fewer delays, reverbs, chorus and pitch shifters.` });
      right.push({ text: "Meters: live", title: "Meters follow the audio core" });
      right.push(...doc);
      return { left, right };
    }
  }
}
