// The Profiler screen's voices (ADR 0334 "The Profiler screen"; the prototype's voice lanes): every voice a capture saw,
// as a block from its start to its end with a status, read from the capture's typed voice events (ADR 0227) and named
// as the capture named its clip and bus at that instant (ADR 0260). Pure: no DOM, no Worker.
//
// Status, in the prototype's words: **played** (started and ended, or still playing at the capture's end), **stolen**
// (a voice limit took it), **blocked by voice limit** (refused: its bus, the pool or the cap was full), **missing file**
// (refused: its clip failed to load), **refused** (it never fits) and **failed** (it stopped with an error). A refused
// voice never got a voice id, so its block is an instant. Everything but "played" is a problem ("Problems only").
// Lanes group blocks by bus or by clip; overlapping blocks take rows within a lane (`assignLanes`, the track kit's).
import { reasonText, type CaptureEventAt, type CaptureEventType, type CaptureNames, type CaptureReason } from "../../../plugins/audio/runtime/capture/reader";
import { assignLanes } from "../../../plugins/audio/editor/mix/tracks/lanes";

/** The voice events the model reads (`ProfileSource.events`' `types`). */
export const VOICE_EVENT_TYPES: readonly CaptureEventType[] = ["voiceStart", "voiceStop", "voiceSteal", "voiceRefused"];

export type VoiceStatus = "played" | "stolen" | "blocked" | "missing" | "refused" | "failed";

/** What each status reads as (the Voice panel's pill and the lanes' legend). */
export const STATUS_TEXT: Readonly<Record<VoiceStatus, string>> = {
  played: "Played",
  stolen: "Warning · Voice stolen",
  blocked: "Warning · Blocked by voice limit",
  missing: "Error · Missing file",
  refused: "Warning · Refused",
  failed: "Error · Failed while playing",
};

/** How bad a status is: the colour it draws in and the kind of message it makes. */
export const STATUS_SEVERITY: Readonly<Record<VoiceStatus, "ok" | "warning" | "error">> = {
  played: "ok",
  stolen: "warning",
  blocked: "warning",
  missing: "error",
  refused: "warning",
  failed: "error",
};

export interface VoiceBlock {
  /** Unique in the capture: `v<voice>.<n>` for a voice, `r<seq>` for a refusal. */
  readonly key: string;
  /** The core's voice id; null for a refusal (it never got one). */
  readonly voice: number | null;
  readonly clip: number;
  readonly clipName: string;
  readonly slot: number;
  readonly busName: string;
  /** Viewport seconds (0 = the capture's first record). */
  readonly start: number;
  /** Its end; the capture's end while `open`; `start` for a refusal. */
  readonly end: number;
  /** Still playing when the capture ended. */
  readonly open: boolean;
  /** Playing when the capture began (the first keyframe counted it), so `start` is 0. */
  readonly fromKeyframe: boolean;
  readonly status: VoiceStatus;
  /** The reason word the capture gave (the steal, refusal or stop reason), or null. */
  readonly reason: CaptureReason | null;
  /** The voice that stole it (a steal only). */
  readonly thief: number | null;
  /** The gain it started at, linear (null for a refusal or a voice from the keyframe). */
  readonly startGain: number | null;
}

/** A voice the capture's first keyframe already counted. */
export interface InitialVoice {
  readonly voice: number;
  readonly clip: number;
  readonly slot: number;
  readonly gain?: number;
}

const REFUSAL_STATUS: Partial<Record<CaptureReason, VoiceStatus>> = { busFull: "blocked", poolFull: "blocked", capRefused: "blocked", loadFailed: "missing", neverFits: "refused" };

interface Open {
  key: string;
  voice: number;
  clip: number;
  slot: number;
  start: number;
  fromKeyframe: boolean;
  startGain: number | null;
}

/**
 * The capture's voices as blocks, by start time. `events` are the typed voice events with axis seconds (any order: they
 * are sorted by time, then seq); `start` is the source's `startSeconds` (viewport 0); `duration` ends the open ones. A stop
 * or steal of a voice the model never saw start is ignored; a second start of a voice still open ends the first there.
 */
export function buildVoices(events: readonly CaptureEventAt[], names: CaptureNames, opts: { start: number; duration: number; initial?: readonly InitialVoice[] }): VoiceBlock[] {
  const { start: origin, duration } = opts;
  const out: VoiceBlock[] = [];
  const open = new Map<number, Open>();
  const counts = new Map<number, number>();
  const name = (o: { clip: number; slot: number }, at: number) => ({ clipName: names.clip(o.clip, origin + at), busName: names.bus(o.slot, origin + at) });
  const begin = (voice: number, clip: number, slot: number, at: number, fromKeyframe: boolean, startGain: number | null) => {
    const n = (counts.get(voice) ?? 0) + 1;
    counts.set(voice, n);
    open.set(voice, { key: `v${voice}.${n}`, voice, clip, slot, start: at, fromKeyframe, startGain });
  };
  const close = (o: Open, at: number, status: VoiceStatus, reason: CaptureReason | null, thief: number | null) => {
    open.delete(o.voice);
    out.push({ key: o.key, voice: o.voice, clip: o.clip, slot: o.slot, ...name(o, o.start), start: o.start, end: Math.max(o.start, at), open: false, fromKeyframe: o.fromKeyframe, status, reason, thief, startGain: o.startGain });
  };
  for (const v of opts.initial ?? []) begin(v.voice, v.clip, v.slot, 0, true, null);
  const sorted = [...events].sort((a, b) => a.seconds - b.seconds || a.seq - b.seq);
  for (const { seq, seconds, event: e } of sorted) {
    const at = seconds - origin;
    switch (e.type) {
      case "voiceStart": {
        const prev = open.get(e.voice);
        if (prev) close(prev, at, "played", null, null);
        begin(e.voice, e.clip, e.slot, at, false, Number.isFinite(e.gain) ? e.gain : null);
        break;
      }
      case "voiceStop": {
        const o = open.get(e.voice);
        if (o) close(o, at, e.reason === "failed" ? "failed" : "played", e.reason, null);
        break;
      }
      case "voiceSteal": {
        const o = open.get(e.voice);
        if (o) close(o, at, "stolen", e.reason, e.thief);
        break;
      }
      case "voiceRefused": {
        const status = (e.reason && REFUSAL_STATUS[e.reason]) ?? "refused";
        out.push({ key: `r${seq}`, voice: null, clip: e.clip, slot: e.slot, ...name(e, at), start: at, end: at, open: false, fromKeyframe: false, status, reason: e.reason, thief: null, startGain: null });
        break;
      }
      default:
        break;
    }
  }
  for (const o of open.values()) out.push({ key: o.key, voice: o.voice, clip: o.clip, slot: o.slot, ...name(o, o.start), start: o.start, end: Math.max(o.start, duration), open: true, fromKeyframe: o.fromKeyframe, status: "played", reason: null, thief: null, startGain: o.startGain });
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

export const isProblem = (b: Pick<VoiceBlock, "status">): boolean => b.status !== "played";

/** The block's reason as words ("bus max voices"), empty for none. */
export const reasonWords = (b: Pick<VoiceBlock, "reason">): string => reasonText(b.reason);

/** One line saying what happened to a voice, for its tooltip and the Messages panel. */
export function voiceSummary(b: VoiceBlock): string {
  const why = reasonWords(b);
  switch (b.status) {
    case "played":
      return b.open ? `${b.clipName} still playing at the end` : `${b.clipName} played`;
    case "stolen":
      return `${b.busName} stole ${b.clipName}${why ? ` (${why})` : ""}${b.thief !== null ? ` for voice ${b.thief}` : ""}`;
    case "blocked":
      return `${b.clipName} blocked: voice limit${why ? ` (${why})` : ""}`;
    case "missing":
      return `Missing file ${b.clipName}`;
    case "refused":
      return `${b.clipName} refused${why ? `: ${why}` : ""}`;
    case "failed":
      return `${b.clipName} failed while playing`;
  }
}

export type GroupBy = "bus" | "clip";

/** One lane: its blocks and the row each takes. */
export interface VoiceLane {
  readonly key: string;
  readonly label: string;
  readonly blocks: readonly VoiceBlock[];
  /** The row of each block (same order). */
  readonly rows: readonly number[];
  /** Rows used (at least 1). */
  readonly rowCount: number;
  /** Blocks that shared the last row because of the row cap. */
  readonly overflow: number;
  /** How many of its blocks are problems. */
  readonly problems: number;
}

/** The most rows one lane takes before blocks share its last row. */
export const MAX_LANE_ROWS = 4;

/**
 * The blocks in lanes by bus (`busName`) or by clip (`clipName`), lanes by label. With `problemsOnly`, lanes with no
 * problem are left out (a lane with one keeps its played blocks, which the view dims, as the prototype does).
 */
export function voiceLanes(blocks: readonly VoiceBlock[], groupBy: GroupBy, problemsOnly = false): VoiceLane[] {
  const groups = new Map<string, VoiceBlock[]>();
  for (const b of blocks) {
    const label = groupBy === "bus" ? b.busName : b.clipName;
    const list = groups.get(label);
    if (list) list.push(b);
    else groups.set(label, [b]);
  }
  const lanes: VoiceLane[] = [];
  for (const [label, list] of groups) {
    const problems = list.filter(isProblem).length;
    if (problemsOnly && problems === 0) continue;
    const { lane, lanes: n, overflow } = assignLanes(list.map((b) => ({ start: b.start, end: b.end > b.start ? b.end : b.start + 1e-6 })), MAX_LANE_ROWS);
    lanes.push({ key: `${groupBy}:${label}`, label, blocks: list, rows: lane, rowCount: Math.max(1, n), overflow, problems });
  }
  return lanes.sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether `block` shows at full strength under the filter (the prototype dims played voices to a quarter). */
export const dimmed = (block: Pick<VoiceBlock, "status">, problemsOnly: boolean): boolean => problemsOnly && !isProblem(block);
