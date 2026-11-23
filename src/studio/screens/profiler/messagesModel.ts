// The Profiler screen's Messages panel and its warning markers (ADR 0348 "The Profiler screen"; the prototype's log):
// warnings, errors and notes in time order, each with the time it seeks to and the voice it selects. Built from the
// voices' problems (stolen, blocked by a voice limit, missing file, refused, failed), the loudness marks against the
// target (over or under it, a warning like a voice-limit one, ADR 0348's loudness warnings), the capture's markers and
// notes (music transitions, snapshots) and what the capture says of itself (truncated, gaps). The prototype's log was
// out of order; this one is sorted by time, then errors before warnings before notes. Pure.
import { formatSeconds } from "../../../plugins/audio/editor/mix/tracks/events";
import { isProblem, STATUS_SEVERITY, voiceSummary, type VoiceBlock } from "./voiceModel";

export type MessageKind = "error" | "warning" | "info";

export const KIND_TEXT: Readonly<Record<MessageKind, string>> = { error: "Error", warning: "Warning", info: "Info" };

export interface ProfilerMessage {
  /** Unique in the list. */
  readonly key: string;
  readonly kind: MessageKind;
  /** Viewport seconds the row seeks to. */
  readonly time: number;
  readonly text: string;
  /** The voice block a click selects, if any. */
  readonly voice: string | null;
  /** Where it came from (a voice, a loudness mark, a marker, a note, the capture itself). */
  readonly source: "voice" | "loudness" | "marker" | "note" | "capture";
  /** The bus it is about (a voice's bus, a loudness mark's), for "Open in Mixer ›" (spec §3.2: links carry the object); else null. */
  readonly bus: string | null;
}

/** A loudness mark on the viewport axis (`LoudnessSource.marks`) with its bus named. */
export interface LoudnessWarning {
  readonly busName: string;
  readonly kind: "over" | "under";
  readonly metric: "integrated" | "shortTerm" | "momentary" | "truePeak";
  readonly from: number;
  readonly to: number;
}

/** A note at an instant: a music transition, a snapshot, a gap. */
export interface ProfilerNote {
  readonly time: number;
  readonly text: string;
  readonly kind?: MessageKind;
}

export interface MessageInput {
  readonly voices: readonly VoiceBlock[];
  readonly loudness?: readonly LoudnessWarning[];
  /** The capture's markers on the viewport axis. */
  readonly markers?: readonly { readonly time: number; readonly text: string }[];
  readonly notes?: readonly ProfilerNote[];
  /** The capture started at a later keyframe (the ring wrapped). */
  readonly truncated?: boolean;
}

const METRIC_TEXT: Readonly<Record<LoudnessWarning["metric"], string>> = { integrated: "integrated", shortTerm: "short-term", momentary: "momentary", truePeak: "true peak" };

const RANK: Readonly<Record<MessageKind, number>> = { error: 0, warning: 1, info: 2 };

/** The loudness mark as a sentence: `Master over the target (short-term) for 2.400 s`. */
export function loudnessText(w: LoudnessWarning): string {
  const length = w.to > w.from ? ` for ${formatSeconds(w.to - w.from)}` : "";
  return `${w.busName} ${w.kind} the target (${METRIC_TEXT[w.metric]})${length}`;
}

/** Every message, sorted by time, then kind (errors first), then text. */
export function buildMessages(input: MessageInput): ProfilerMessage[] {
  const out: ProfilerMessage[] = [];
  if (input.truncated) out.push({ key: "capture.truncated", kind: "info", time: 0, text: "The ring wrapped: this capture starts at a later keyframe, not at the start of the run.", voice: null, source: "capture", bus: null });
  for (const b of input.voices) {
    if (!isProblem(b)) continue;
    out.push({ key: `voice.${b.key}`, kind: STATUS_SEVERITY[b.status] === "error" ? "error" : "warning", time: b.status === "stolen" || b.status === "failed" ? b.end : b.start, text: voiceSummary(b), voice: b.key, source: "voice", bus: b.busName || null });
  }
  (input.loudness ?? []).forEach((w, i) => out.push({ key: `loudness.${i}`, kind: "warning", time: w.from, text: loudnessText(w), voice: null, source: "loudness", bus: w.busName || null }));
  (input.markers ?? []).forEach((m, i) => out.push({ key: `marker.${i}`, kind: "info", time: m.time, text: `Marker: ${m.text}`, voice: null, source: "marker", bus: null }));
  (input.notes ?? []).forEach((n, i) => out.push({ key: `note.${i}`, kind: n.kind ?? "info", time: n.time, text: n.text, voice: null, source: "note", bus: null }));
  return out.sort((a, b) => a.time - b.time || RANK[a.kind] - RANK[b.kind] || a.text.localeCompare(b.text));
}

/** Messages of the chosen kinds (all when `kinds` is empty). */
export function filterMessages(messages: readonly ProfilerMessage[], kinds: ReadonlySet<MessageKind>): ProfilerMessage[] {
  return kinds.size === 0 ? [...messages] : messages.filter((m) => kinds.has(m.kind));
}

/** How many of each kind. */
export function messageCounts(messages: readonly ProfilerMessage[]): Record<MessageKind, number> {
  const out: Record<MessageKind, number> = { error: 0, warning: 0, info: 0 };
  for (const m of messages) out[m.kind]++;
  return out;
}

/** A marker on the ruler: the capture's own markers and every warning and error (the prototype's danger and warning ticks). */
export interface RulerMark {
  readonly time: number;
  readonly kind: MessageKind;
  readonly text: string;
  readonly voice: string | null;
}

/** The ruler's marks: markers as notes, problems and loudness marks as warnings or errors, by time. */
export function rulerMarks(messages: readonly ProfilerMessage[]): RulerMark[] {
  return messages.filter((m) => m.source !== "note" && m.source !== "capture").map((m) => ({ time: m.time, kind: m.kind, text: m.text, voice: m.voice }));
}
