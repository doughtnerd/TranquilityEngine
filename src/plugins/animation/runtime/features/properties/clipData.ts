// What the host knows about a loaded clip, by its core handle (ADR 0371): its track and string tables (read once, on
// first use, from the bytes the core holds, `AnimationCore.assetBytes`), its `COLUMN` records (where each property
// track's column sits in the column block, `AnimationCore.clipColumns`), and its JSON strings parsed on first use
// (notify args, audio params). Cached per page core and handle: a handle names one asset for its life (index plus
// generation), and the handful of clips a game plays keep only these small tables.
import type { AnimationCore } from "../../core/AnimationCore";
import { getRecord } from "../../core/records";
import { COLUMN, COLUMN_DEFAULT, COLUMN_U32 } from "../../wasm/wire/tracks";
import { readClipTracks, type ClipTracks } from "./clipTracks";

/** @internal One property track's column in the clip's column block. */
export interface ClipColumn {
  readonly track: number;
  readonly kind: number;
  /** u32 words (discrete payload ids, activation levels), else f32. */
  readonly u32: boolean;
  /** First word in the block, and words. */
  readonly offset: number;
  readonly width: number;
}

/** @internal A loaded clip as the host reads it. */
export interface ClipData {
  /** Null when the core holds no bytes for the handle or they don't parse. */
  readonly tracks: ClipTracks | null;
  /** The written columns (default columns, never written, are left out). */
  readonly columns: readonly ClipColumn[];
  /** String `id` parsed as JSON: undefined for `NONE`, a missing string or bad JSON (`bad` then says so). */
  json(id: number): { readonly value: unknown; readonly bad: boolean };
}

const NONE = 0xffffffff;
const NO_JSON = { value: undefined, bad: false } as const;
const BAD_JSON = { value: undefined, bad: true } as const;
const caches = new WeakMap<AnimationCore, Map<number, { readonly version: number; readonly data: ClipData }>>();

function load(core: AnimationCore, handle: number): ClipData {
  // The track table is read from a copy of the clip's bytes on first use (bindings, notifies), not here: the column
  // scatter asks for every clip that fills a block, and most skeletal clips have no property track to bind.
  let tracksRead = false;
  let tracksValue: ClipTracks | null = null;
  const tracks = (): ClipTracks | null => {
    if (!tracksRead) {
      tracksRead = true;
      const bytes = core.assetBytes(handle);
      tracksValue = bytes ? readClipTracks(bytes) : null;
    }
    return tracksValue;
  };
  const columns: ClipColumn[] = [];
  const records = core.clipColumns(handle);
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  for (let at = 0; at + COLUMN.stride <= records.byteLength; at += COLUMN.stride) {
    const c = getRecord(view, at, COLUMN);
    if (c.flags & COLUMN_DEFAULT) continue;
    columns.push({ track: c.track, kind: c.trackKind, u32: c.columnType === COLUMN_U32, offset: c.offset, width: c.width });
  }
  const parsed = new Map<number, { value: unknown; bad: boolean }>();
  return {
    get tracks() {
      return tracks();
    },
    columns,
    json(id) {
      if (id === NONE) return NO_JSON;
      let p = parsed.get(id);
      if (!p) {
        const text = tracks()?.string(id);
        if (text === null || text === undefined) p = NO_JSON;
        else {
          try {
            p = { value: JSON.parse(text) as unknown, bad: false };
          } catch {
            p = BAD_JSON;
          }
        }
        parsed.set(id, p);
      }
      return p;
    },
  };
}

/** @internal The host's tables of clip `handle` in `core` (read on first use). */
export function clipData(core: AnimationCore, handle: number): ClipData {
  let cache = caches.get(core);
  if (!cache) caches.set(core, (cache = new Map()));
  // A clip replaced in place (`replaceClip`, T70: raw → compiled) is read again.
  const version = core.assetVersion(handle);
  let d = cache.get(handle);
  if (!d || d.version !== version) cache.set(handle, (d = { version, data: load(core, handle) }));
  return d.data;
}
