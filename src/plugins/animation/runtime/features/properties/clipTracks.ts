// A `myco.anim@1` clip's track table and string table, read on the host (ADR 0371, "Bindings"): what each track targets
// (`nodePath` relative to the Animator's node, component id, field path), so the binding table can find its ECS column,
// and the strings the core's records name by id (notify methods, args JSON, discrete asset references, audio assets).
// The container is checked by `readAnimationHeader` (the engine's reader of `anim-format`'s layout); this reads the
// `TRACKS` records and decodes the strings (`native/anim/crates/anim-format/src/clip.rs` documents both). Lenient: bytes
// that don't parse answer null, never throw. A pure library.
import { readAnimationHeader } from "../../../../../engine/animation/binaryHeader";

const NONE = 0xffffffff;
const TRACK_LEN = 32;

/** @internal One track's record. */
export interface ClipTrack {
  /** `anim-format`'s `TrackKind` id (the `TRACK_KINDS` order of `engine/animation/tracks.ts`). */
  readonly kind: number;
  readonly flags: number;
  /** `discrete`: the `DiscreteType` id (bool, enum, asset); `quat`: the interpolation; else 0. */
  readonly subtype: number;
  /** The target node's path relative to the Animator's node ("" is the node itself), or null (bone and clip-level tracks). */
  readonly nodePath: string | null;
  /** The component id (`engine.Light`), or null. */
  readonly component: string | null;
  /** The field path (`intensity`, `drive.targetRotation`; a morph track's target name), or null. */
  readonly field: string | null;
}

/** @internal A clip's tracks and strings. */
export interface ClipTracks {
  readonly tracks: readonly ClipTrack[];
  readonly strings: readonly string[];
  /** String `id`, or null for `NONE` or an id past the table. */
  string(id: number): string | null;
}

/** @internal Reads a compiled clip's track and string tables; null when the bytes aren't a valid clip. */
export function readClipTracks(bytes: Uint8Array): ClipTracks | null {
  const read = readAnimationHeader(bytes, "myco.anim@1");
  if (!read.ok) return null;
  const sec = (name: string) => read.header.sections.find((s) => s.name === name);
  const stringsSection = sec("STRINGS"), tracksSection = sec("TRACKS");
  if (!stringsSection || !tracksSection) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);

  const n = stringsSection.count;
  const chars = stringsSection.offset + 4 * (n + 1);
  const decoder = new TextDecoder();
  const strings: string[] = [];
  for (let i = 0; i < n; i++) strings.push(decoder.decode(bytes.subarray(chars + u32(stringsSection.offset + 4 * i), chars + u32(stringsSection.offset + 4 * i + 4))));
  const string = (id: number): string | null => (id === NONE ? null : (strings[id] ?? null));

  const tracks: ClipTrack[] = [];
  for (let i = 0; i < tracksSection.count; i++) {
    const at = tracksSection.offset + i * TRACK_LEN;
    tracks.push({
      kind: view.getUint8(at),
      flags: view.getUint8(at + 1),
      subtype: view.getUint8(at + 2),
      nodePath: string(u32(at + 8)),
      component: string(u32(at + 12)),
      field: string(u32(at + 16)),
    });
  }
  return { tracks, strings, string };
}
