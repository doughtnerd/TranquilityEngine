// The Animation window's rows (ADR 0373): a clip's tracks as rows grouped by bound node, component and field, bone
// tracks under Bones by bone and channel, and the clip-wide rows (markers, named curves). Each row that holds keys is a
// **channel** of one track: a component of a curve track (`Position.x`), a bone channel, or a track's key list
// (rotations, discrete values, events, audio, activation, subclips, control, markers). A multi-component field also
// gets a summary row whose diamonds stand for every component keyed at that time.
//
// A channel's keys are handled as `[time, payload]` pairs (`keyList.ts`'s `Key`), so the shared key-list edits move,
// scale, copy and paste every kind the same way; ranged keys (`end`) carry their length, so moving one moves its end.
//
// Pure; no DOM.
import type { CurveKey } from "../../../../engine/core/curve";
import { CURVE_TRACK_WIDTH, type CurveTrackKind, type QuatKey, type Track, type TrackKind } from "../../../../engine/animation/tracks";
import type { Key } from "../../../../editor/ui/curves/keyList";

/** Which keys of a track a row holds. */
export type Channel =
  | { readonly kind: "curve"; readonly component: number }
  | { readonly kind: "bone"; readonly part: "translation" | "rotation" | "scale" }
  | { readonly kind: "keys" };

/** One key on a row. */
export interface RowKey {
  readonly id: string;
  readonly t: number;
  readonly label: string;
}

/** One row. Leaf rows have a `track` and `channel`; summary rows list their leaves in `leaves`; headings have neither. */
export interface TrackRow {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly heading: boolean;
  readonly track: number | null;
  readonly channel: Channel | null;
  readonly kind: TrackKind | null;
  /** A summary row's leaf rows (a vector field's components). */
  readonly leaves?: readonly string[];
  readonly keys: readonly RowKey[];
  /** Ranges drawn under the keys (activation on spans, notify states, subclips). */
  readonly spans?: readonly { readonly id: string; readonly from: number; readonly to: number; readonly label: string }[];
  /** The series colour index (1..8) of the keys. */
  readonly color?: number;
}

/** A key pair's payload: what follows the time. */
export type KeyPair = Key<unknown>;

const COMPONENT_NAMES: Readonly<Record<CurveTrackKind, readonly string[]>> = {
  float: [""], morph: [""], curve: [""], vec2: ["x", "y"], vec3: ["x", "y", "z"], vec4: ["x", "y", "z", "w"], color: ["r", "g", "b", "a"],
};
const PART_LABEL = { translation: "Position", rotation: "Rotation", scale: "Scale" } as const;
const KEYED_LABEL: Partial<Record<TrackKind, string>> = { event: "Events", audio: "Audio", activation: "Active", subclip: "Subclips", control: "Control", marker: "Markers", quat: "", discrete: "" };

const isCurveKind = (k: TrackKind): k is CurveTrackKind => k in CURVE_TRACK_WIDTH;
const title = (type: string) => type.replace(/^[^.]*\./, "");
const fmt = (t: number) => `${t.toFixed(2)} s`;

/** A leaf row's id: its track and channel. */
export function rowId(track: number, ch: Channel): string {
  return `${track}:${ch.kind === "curve" ? `c${ch.component}` : ch.kind === "bone" ? ch.part[0] : "k"}`;
}

/** A leaf row's id read back, or null. */
export function parseRowId(id: string): { track: number; channel: Channel } | null {
  const m = /^(\d+):(c(\d+)|t|r|s|k)$/.exec(id);
  if (!m) return null;
  const track = Number(m[1]);
  if (m[3] !== undefined) return { track, channel: { kind: "curve", component: Number(m[3]) } };
  if (m[2] === "k") return { track, channel: { kind: "keys" } };
  return { track, channel: { kind: "bone", part: m[2] === "t" ? "translation" : m[2] === "r" ? "rotation" : "scale" } };
}

/** A leaf key's id (its row and index) and back. */
export const keyId = (row: string, index: number): string => `${row}#${index}`;
export function parseKeyId(id: string): { row: string; index: number } | null {
  const at = id.lastIndexOf("#");
  return at > 0 ? { row: id.slice(0, at), index: Number(id.slice(at + 1)) } : null;
}

/** The channels a track has, in row order. */
export function channelsOf(track: Track): Channel[] {
  if (track.kind === "bone") return (["translation", "rotation", "scale"] as const).map((part) => ({ kind: "bone", part }));
  if (isCurveKind(track.kind)) return Array.from({ length: CURVE_TRACK_WIDTH[track.kind] }, (_, component) => ({ kind: "curve", component }));
  return [{ kind: "keys" }];
}

/** Whether keys of channel `a` may be pasted onto channel `b` (the same kind of payload). */
export function channelsCompatible(ta: Track, a: Channel, tb: Track, b: Channel): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "curve") return true; // any number curve takes any other's keys
  if (a.kind === "bone") return a.part === (b as typeof a).part || (a.part !== "rotation" && (b as typeof a).part !== "rotation");
  if (ta.kind !== tb.kind) return false;
  return ta.kind !== "discrete" || tb.kind !== "discrete" || ta.valueType === tb.valueType;
}

type Ranged = { readonly time: number; readonly end?: number };

/** A channel's keys as `[time, payload]` pairs (ranged keys carry their length as `len`). */
export function channelKeys(track: Track, ch: Channel): KeyPair[] {
  if (ch.kind === "bone" && track.kind === "bone") return track[ch.part].map((k) => [k[0], k.slice(1)]);
  if (ch.kind === "curve" && isCurveKind(track.kind)) return ((track as { curves: readonly (readonly CurveKey[])[] }).curves[ch.component] ?? []).map((k) => [k[0], k.slice(1)]);
  switch (track.kind) {
    case "quat":
      return track.keys.map((k) => [k[0], k.slice(1)]);
    case "discrete":
      return track.keys.map((k) => [k[0], k[1]]);
    case "event":
    case "audio":
    case "activation":
    case "subclip":
    case "control":
    case "marker":
      return (track.keys as readonly Ranged[]).map((k) => {
        const { time, end, ...rest } = k;
        return [time, end === undefined ? rest : { ...rest, len: end - time }];
      });
    default:
      return [];
  }
}

/**
 * `track` with channel `ch`'s keys replaced by `pairs` (sorted by time; times clamped into `0..duration`, a ranged key's
 * end too).
 */
export function withChannelKeys(track: Track, ch: Channel, pairs: readonly KeyPair[], duration: number): Track {
  const clampT = (t: number) => Math.min(duration, Math.max(0, t)) + 0;
  const sorted = [...pairs].map((p): KeyPair => [clampT(p[0]), p[1]]).sort((a, b) => a[0] - b[0]);
  const tuple = <T>(p: KeyPair) => [p[0], ...(p[1] as number[])] as unknown as T;
  if (ch.kind === "bone" && track.kind === "bone") return { ...track, [ch.part]: sorted.map((p) => tuple(p)) };
  if (ch.kind === "curve" && isCurveKind(track.kind)) {
    const t = track as Extract<Track, { kind: CurveTrackKind }>;
    return { ...t, curves: t.curves.map((c, i) => (i === ch.component ? sorted.map((p) => tuple<CurveKey>(p)) : c)) };
  }
  switch (track.kind) {
    case "quat":
      return { ...track, keys: sorted.map((p) => tuple<QuatKey>(p)) };
    case "discrete":
      return { ...track, keys: sorted.map((p) => [p[0], p[1]] as const) as never };
    case "event":
    case "audio":
    case "activation":
    case "subclip":
    case "control":
    case "marker":
      return {
        ...track,
        keys: sorted.map((p) => {
          const { len, ...rest } = p[1] as { len?: number };
          return len === undefined ? { ...rest, time: p[0] } : { ...rest, time: p[0], end: clampT(p[0] + len) };
        }),
      } as Track;
    default:
      return track;
  }
}

/** A key's short description for its tooltip. */
function describe(track: Track, ch: Channel, payload: unknown): string {
  if (ch.kind === "curve") return String((payload as number[])[0]);
  if (ch.kind === "bone") return (payload as number[]).map((v) => v.toFixed(3)).join(", ");
  switch (track.kind) {
    case "quat":
      return (payload as number[]).map((v) => v.toFixed(3)).join(", ");
    case "discrete":
      return JSON.stringify(payload);
    case "event":
      return `${(payload as { method: string }).method}()`;
    case "audio":
      return (payload as { audio: string }).audio;
    case "marker": {
      const m = payload as { kind: string; name?: string };
      return m.name ? `${m.kind} ${m.name}` : m.kind;
    }
    case "subclip":
      return (payload as { clip: string }).clip;
    case "control":
      return (payload as { action: string }).action;
    default:
      return "on";
  }
}

/** What rows read about the clip. */
export interface RowsOptions {
  /** The bound node's name, for tracks on the Animator's own node (nodePath ""). */
  readonly rootName?: string;
}

/** The clip's rows, in display order (see the file header). */
export function trackRows(tracks: readonly Track[], options: RowsOptions = {}): TrackRow[] {
  const rows: TrackRow[] = [];
  const leaf = (track: number, ch: Channel, label: string, depth: number, color?: number): TrackRow => {
    const t = tracks[track]!;
    const id = rowId(track, ch);
    const pairs = channelKeys(t, ch);
    const keys = pairs.map((p, i) => ({ id: keyId(id, i), t: p[0], label: `${label || t.kind} key at ${fmt(p[0])}: ${describe(t, ch, p[1])}` }));
    const spans = pairs.flatMap((p, i) => {
      const len = (p[1] as { len?: number } | null)?.len;
      return typeof len === "number" && len > 0 ? [{ id: `${id}~${i}`, from: p[0], to: p[0] + len, label: `${label} ${fmt(p[0])} – ${fmt(p[0] + len)}` }] : [];
    });
    return { id, label, depth, heading: false, track, channel: ch, kind: t.kind, keys, ...(spans.length ? { spans } : {}), ...(color ? { color } : {}) };
  };
  const heading = (id: string, label: string, depth: number): TrackRow => ({ id, label, depth, heading: true, track: null, channel: null, kind: null, keys: [] });

  // Property and keyed tracks bound to nodes, grouped by node, then component.
  const nodes = new Map<string, number[]>();
  tracks.forEach((t, i) => {
    if (t.kind === "bone" || t.kind === "marker" || t.kind === "curve") return;
    const path = t.target.nodePath;
    nodes.set(path, [...(nodes.get(path) ?? []), i]);
  });
  let color = 0;
  for (const [path, list] of [...nodes].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push(heading(`n:${path}`, path || options.rootName || "Self", 0));
    const byComponent = new Map<string, number[]>();
    for (const i of list) {
      const t = tracks[i]!;
      const key = isCurveKind(t.kind) || t.kind === "quat" || t.kind === "discrete" ? (t.kind === "morph" ? "Morph targets" : title((t as { target: { component: string } }).target.component)) : "";
      byComponent.set(key, [...(byComponent.get(key) ?? []), i]);
    }
    for (const [component, members] of byComponent) {
      const depth = component ? 2 : 1;
      if (component) rows.push(heading(`n:${path}/${component}`, component, 1));
      for (const i of members) {
        const t = tracks[i]!;
        color = (color % 8) + 1;
        if (isCurveKind(t.kind) && CURVE_TRACK_WIDTH[t.kind] > 1) {
          const names = COMPONENT_NAMES[t.kind];
          const field = (t as { target: { field: string } }).target.field;
          const leaves = channelsOf(t).map((ch, c) => leaf(i, ch, `${field}.${names[c]}`, depth + 1, color));
          const times = [...new Set(leaves.flatMap((l) => l.keys.map((k) => k.t)))].sort((a, b) => a - b);
          const id = `f:${i}`;
          rows.push({ id, label: field, depth, heading: false, track: i, channel: null, kind: t.kind, leaves: leaves.map((l) => l.id), keys: times.map((tm) => ({ id: `${id}@${tm}`, t: tm, label: `${field} keys at ${fmt(tm)}` })), color });
          rows.push(...leaves);
        } else if (isCurveKind(t.kind) || t.kind === "quat" || t.kind === "discrete") {
          rows.push(leaf(i, channelsOf(t)[0]!, (t as { target: { field: string } }).target.field, depth, color));
        } else {
          rows.push(leaf(i, { kind: "keys" }, KEYED_LABEL[t.kind] || t.kind, depth, color));
        }
      }
    }
  }

  // Bone tracks.
  const bones = tracks.map((t, i) => [t, i] as const).filter(([t]) => t.kind === "bone");
  if (bones.length) {
    rows.push(heading("bones", "Bones", 0));
    for (const [t, i] of bones) {
      color = (color % 8) + 1;
      rows.push(heading(`b:${i}`, (t as { bone: string }).bone, 1));
      for (const ch of channelsOf(t)) rows.push(leaf(i, ch, PART_LABEL[(ch as { part: keyof typeof PART_LABEL }).part], 2, color));
    }
  }

  // Clip-wide rows: markers and named curves.
  const clipWide = tracks.map((t, i) => [t, i] as const).filter(([t]) => t.kind === "marker" || t.kind === "curve");
  if (clipWide.length) {
    rows.push(heading("clip", "Clip", 0));
    for (const [t, i] of clipWide) {
      color = (color % 8) + 1;
      rows.push(leaf(i, channelsOf(t)[0]!, t.kind === "marker" ? "Markers" : `Curve ${(t as { name: string }).name}`, 1, color));
    }
  }
  return rows;
}

/** The leaf keys a key id on the rows stands for: itself, or every component keyed at a summary key's time. */
export function leafKeysOf(rows: readonly TrackRow[], id: string): string[] {
  const at = id.indexOf("@");
  if (at < 0) return parseKeyId(id) ? [id] : [];
  const row = rows.find((r) => r.id === id.slice(0, at));
  const t = Number(id.slice(at + 1));
  if (!row?.leaves) return [];
  return row.leaves.flatMap((leafId) => rows.find((r) => r.id === leafId)?.keys.filter((k) => Math.abs(k.t - t) < 1e-6).map((k) => k.id) ?? []);
}

/** The summary key ids whose every leaf key is in `selected` (so a summary diamond shows selected with its keys). */
export function summarySelected(rows: readonly TrackRow[], selected: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.leaves) for (const k of r.keys) {
    const leaves = leafKeysOf(rows, k.id);
    if (leaves.length && leaves.every((l) => selected.has(l))) out.push(k.id);
  }
  return out;
}
