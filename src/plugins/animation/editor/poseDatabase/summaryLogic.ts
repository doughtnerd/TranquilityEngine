// What the pose database tool shows of a baked file (ADR 0373 "Pose database tool"; T55): the summary of a
// `myco.posedb@1` file read from its header and small sections on the host, as the runtime's asset readers read a
// skeleton or a clip (`runtime/assetInfo.ts`): frames, dimensions, features, sample rate, the clips it lists with their
// frame counts, the tags with theirs, and the file's size. Layout: `native/anim/crates/anim-format/src/posedb.rs`
// (the container's header and section table, `INFO`, `STRINGS`, `FEATURES`, `FRAMES`, `CLIPS`, `TAG_NAMES`, `TAGS`).
// Lenient: bytes that aren't a pose database answer null. A pure library.

const HEADER_LEN = 32;
const ENTRY_LEN = 16;
const NONE = 0xffffffff;
const MAGIC = "MYCOPSDB";
const STRINGS = 1, INFO = 2, FEATURES = 3, FRAMES = 6, CLIPS = 7, TAG_NAMES = 8, TAGS = 9, KD_NODES = 10;
const INFO_LEN = 32, FEATURE_LEN = 24, FRAME_LEN = 8;
const FEATURE_KINDS = ["bone position", "bone velocity", "trajectory position", "trajectory direction", "custom"] as const;

/** @internal A baked pose database's summary. */
export interface PoseDbSummary {
  /** The file's size in bytes. */
  readonly size: number;
  readonly frames: number;
  /** Feature dimensions per frame. */
  readonly dims: number;
  /** Frames per second of the bake. */
  readonly rate: number;
  /** Seconds of motion (frames / rate). */
  readonly seconds: number;
  /** The skeleton reference the bake stored, or null. */
  readonly skeleton: string | null;
  /** Whether a KD-tree was baked. */
  readonly kdTree: boolean;
  /** Feature count per kind name (`bone position`, `trajectory direction`…), kinds with none left out. */
  readonly features: readonly { readonly kind: string; readonly count: number }[];
  /** The clips it lists, each with the frames baked from it. */
  readonly clips: readonly { readonly asset: string; readonly frames: number }[];
  /** The tags, each with the frames that carry it. */
  readonly tags: readonly { readonly name: string; readonly frames: number }[];
}

interface Section {
  readonly offset: number;
  readonly length: number;
  readonly count: number;
}

function sectionsOf(bytes: Uint8Array): { view: DataView; byKind: Map<number, Section> } | null {
  if (bytes.byteLength < HEADER_LEN) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(20, true);
  if (HEADER_LEN + count * ENTRY_LEN > bytes.byteLength) return null;
  const byKind = new Map<number, Section>();
  for (let i = 0; i < count; i++) {
    const at = HEADER_LEN + i * ENTRY_LEN;
    const s = { offset: view.getUint32(at + 4, true), length: view.getUint32(at + 8, true), count: view.getUint32(at + 12, true) };
    if (s.offset + s.length > bytes.byteLength) return null;
    byKind.set(view.getUint32(at, true), s);
  }
  return { view, byKind };
}

function readStrings(bytes: Uint8Array, view: DataView, s: Section | undefined): string[] | null {
  if (!s) return null;
  const data = s.offset + 4 * (s.count + 1);
  if (data > s.offset + s.length) return null;
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < s.count; i++) {
    const a = view.getUint32(s.offset + 4 * i, true), b = view.getUint32(s.offset + 4 * i + 4, true);
    if (b < a || data + b > s.offset + s.length) return null;
    out.push(decoder.decode(bytes.subarray(data + a, data + b)));
  }
  return out;
}

/** The summary of the `myco.posedb@1` file `bytes`, or null when they don't parse. */
export function readPoseDbSummary(bytes: Uint8Array): PoseDbSummary | null {
  const c = sectionsOf(bytes);
  if (!c) return null;
  const { view, byKind } = c;
  const info = byKind.get(INFO);
  const strings = readStrings(bytes, view, byKind.get(STRINGS));
  const features = byKind.get(FEATURES), frameRefs = byKind.get(FRAMES), clipIds = byKind.get(CLIPS);
  if (!info || info.length < INFO_LEN || !strings || !features || !frameRefs || !clipIds) return null;
  const frames = view.getUint32(info.offset, true);
  const rate = view.getFloat32(info.offset + 24, true);
  const skeletonId = view.getUint32(info.offset + 28, true);
  const tagCount = view.getUint32(info.offset + 20, true);
  if (frameRefs.count !== frames || frames * FRAME_LEN > frameRefs.length || features.count * FEATURE_LEN > features.length || clipIds.count * 4 > clipIds.length) return null;
  if (!(Number.isFinite(rate) && rate > 0)) return null;
  const string = (id: number): string | null => (id === NONE ? null : (strings[id] ?? null));

  const kinds = new Array<number>(FEATURE_KINDS.length).fill(0);
  for (let i = 0; i < features.count; i++) {
    const kind = view.getUint8(features.offset + i * FEATURE_LEN);
    if (kind < kinds.length) kinds[kind]!++;
  }
  const clipFrames = new Array<number>(clipIds.count).fill(0);
  for (let f = 0; f < frames; f++) {
    const clip = view.getUint32(frameRefs.offset + f * FRAME_LEN, true);
    if (clip < clipFrames.length) clipFrames[clip]!++;
  }
  const clips = Array.from({ length: clipIds.count }, (_, i) => ({ asset: string(view.getUint32(clipIds.offset + 4 * i, true)) ?? "", frames: clipFrames[i]! }));

  const tagNames = byKind.get(TAG_NAMES), tagWords = byKind.get(TAGS);
  const tags: { name: string; frames: number }[] = [];
  if (tagNames && tagWords && tagCount > 0 && tagNames.count === tagCount) {
    const words = Math.ceil(tagCount / 32);
    if (frames * words * 4 <= tagWords.length) {
      for (let t = 0; t < tagCount; t++) {
        let n = 0;
        for (let f = 0; f < frames; f++) if ((view.getUint32(tagWords.offset + 4 * (f * words + (t >> 5)), true) >>> (t & 31)) & 1) n++;
        tags.push({ name: string(view.getUint32(tagNames.offset + 4 * t, true)) ?? "", frames: n });
      }
    }
  }
  return {
    size: bytes.byteLength,
    frames,
    dims: view.getUint32(info.offset + 4, true),
    rate,
    seconds: frames / rate,
    skeleton: string(skeletonId),
    kdTree: byKind.has(KD_NODES),
    features: FEATURE_KINDS.map((kind, i) => ({ kind, count: kinds[i]! })).filter((k) => k.count > 0),
    clips,
    tags,
  };
}

/** A byte count as "512 B", "12.4 KB" or "1.3 MB". */
export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A summary as the lines the tool shows. */
export function describeSummary(s: PoseDbSummary): { readonly label: string; readonly value: string }[] {
  const lines = [
    { label: "Frames", value: `${s.frames} (${s.seconds.toFixed(1)} s at ${s.rate} Hz)` },
    { label: "Size", value: describeSize(s.size) },
    { label: "Dimensions", value: `${s.dims} per frame, ${s.features.map((f) => `${f.count} ${f.kind}`).join(", ") || "no features"}` },
    { label: "Search", value: s.kdTree ? "KD-tree" : "linear scan" },
  ];
  if (s.skeleton) lines.push({ label: "Skeleton", value: s.skeleton });
  return lines;
}
