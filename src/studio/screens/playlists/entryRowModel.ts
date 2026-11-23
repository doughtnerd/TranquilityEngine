// What an entry row says (the prototype's `.lrow`): its meta after the name ("Clip · 0.70 s · 1 effect", "Queue · 3
// entries"), a random Queue's share of the picks ("50%"), and the Voice button's summary (the use's gain, "set" when
// the use changes anything, "shaped" when it has curves) with its tooltip; and the curve menu's edits of an entry's
// curves (copy, paste, turn off or on, clear). Pure.
import type { Entry, EntryUse, PlaylistBody } from "../../../engine/audio/playlist/types";

/** dB as the prototype writes it: "0 dB", "−4 dB", "+2.5 dB" (a real minus sign). */
export function dbText(db: number): string {
  const r = Math.round(db * 10) / 10;
  if (r === 0) return "0 dB";
  return `${r < 0 ? "−" : "+"}${Math.abs(r)} dB`;
}

const st = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(Math.round(v * 100) / 100)} st`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Voice button's text, its looks and tooltip. */
export function voiceSummary(use: Pick<EntryUse, "volume" | "pitch" | "curves">): { text: string; set: boolean; shaped: boolean; title: string } {
  const curves = Object.values(use.curves).filter(Boolean);
  const on = curves.filter((c) => !c!.bypass).length;
  const parts = [dbText(use.volume), ...(use.pitch ? [st(use.pitch)] : []), ...(curves.length ? [on === curves.length ? plural(curves.length, "curve") : `${plural(curves.length, "curve")} (${curves.length - on} off)`] : [])];
  return {
    text: dbText(use.volume),
    set: use.volume !== 0 || use.pitch !== 0,
    shaped: on > 0,
    title: `Voice: ${parts.join(" · ")}. Click to edit its curves (gain, pitch, pan, filters over voice time or a parameter); right-click for more.`,
  };
}

/** Each entry's share of a random Queue's picks, 0..1 (all 0 when every weight is 0). */
export function shares(entries: readonly Pick<EntryUse, "weight">[]): number[] {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  return entries.map((e) => (total > 0 ? Math.max(0, e.weight) / total : 0));
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

const TYPE_WORD: Record<PlaylistBody["type"], string> = { clip: "Clip", queue: "Queue", switch: "Switch", blend: "Blend", layer: "Layer", sequence: "Sequence" };

/** Seconds as "0.70 s", or "16.0 s" from ten seconds on. */
export const secondsText = (s: number): string => `${s >= 10 ? s.toFixed(1) : s.toFixed(2)} s`;

/**
 * The muted meta after an entry's name: its type and what it holds ("Queue · 3 entries", "Clip · 0.70 s · 1 effect");
 * a sample "0.70 s". `body` is an embedded or linked entry's playlist (null when it can't be read); `length` a
 * sample's length in seconds, null when unknown.
 */
export function entryMeta(e: Entry, body: PlaylistBody | null, length: (sample: string) => number | null): string {
  if (e.kind === "sample") {
    const l = length(e.sample);
    return l === null ? "" : secondsText(l);
  }
  if (e.kind === "line") return "Line";
  if (e.kind === "generator") return "Generator";
  if (!body) return e.kind === "linked" ? "missing" : "";
  const parts = [body.type === "blend" ? `${body.blend?.axes.length === 2 ? "2D" : "1D"} blend` : TYPE_WORD[body.type]];
  if (body.type === "clip") {
    const s = body.entries[0];
    const l = s?.kind === "sample" ? length(s.sample) : null;
    if (l !== null) parts.push(secondsText(s?.kind === "sample" && s.trim ? Math.max(0, s.trim[1] - s.trim[0]) : l));
  } else parts.push(plural(body.entries.length, "entry", "entries"));
  if (body.effects.length) parts.push(plural(body.effects.length, "effect"));
  return parts.join(" · ");
}

export type VoiceCurveMap = EntryUse["curves"];

/** "Turn automation off/on": every curve bypassed (true) or running (false). */
export const bypassAll = (curves: VoiceCurveMap, bypass: boolean): VoiceCurveMap =>
  Object.fromEntries(Object.entries(curves).map(([k, c]) => [k, c ? { ...c, bypass } : c])) as VoiceCurveMap;

/** Whether every curve is bypassed (and there is at least one). */
export const allBypassed = (curves: VoiceCurveMap): boolean => {
  const list = Object.values(curves).filter(Boolean);
  return list.length > 0 && list.every((c) => c!.bypass);
};
