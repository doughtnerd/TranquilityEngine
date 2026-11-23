// Reading a take's animation records (ADR 0348, 0373; T73): the plugin records of a take file (the audio take reader hands
// them over, `engine/audio/take/extensions.ts`) become, per recorded Animator, its frames (as the live debugger shows them),
// its keyframes and the rows each frame can be re-evaluated from. Lenient: a record that doesn't read is left out with one
// problem line, and the rest is kept; records of types this reader doesn't know pass.
import type { TakeExtensionRecord } from "../../../../../engine/audio/take/extensions";
import type { AnimatorDebugFrame } from "./frame";
import { ANIM_FRAME, ANIM_KEY, ANIM_RAW, ANIM_SELECT, ANIM_TARGET, decodeFrameRecord } from "./frameRecord";
import type { RawFrame } from "./recorder";
import { RawDecoder, decodeKey, decodeSelect, decodeTarget, type TakeTargetInfo } from "./takeRecords";

/** One recorded frame with what re-evaluating it takes. */
export interface TakeEntry {
  readonly frame: AnimatorDebugFrame;
  /** What the core applied that frame (null: it wasn't recorded or didn't read, so the frame can't be re-evaluated). */
  readonly raw: RawFrame | null;
  /** Rows of the other pass applied before it. */
  readonly before: readonly RawFrame[];
  /** The instance's snapshot before the frame applied (a keyframe), or null. */
  readonly key: Uint8Array | null;
}

/** One Animator of a take. */
export interface AnimationTakeTarget {
  readonly info: TakeTargetInfo;
  /** The frames in recording order. */
  readonly entries: readonly TakeEntry[];
  /** True when the Animator's graph changed during the take (its tables were declared more than once, differently). */
  readonly changedWhileRecording: boolean;
}

/** A take's animation records, read. */
export interface AnimationTake {
  readonly targets: readonly AnimationTakeTarget[];
  /** Records that didn't read, one line each (at most `MAX_PROBLEMS`). */
  readonly problems: readonly string[];
  /** Seconds the longest Animator's frames span on its own clock. */
  readonly duration: number;
}

const MAX_PROBLEMS = 20;

interface Building {
  info: TakeTargetInfo;
  readonly entries: TakeEntry[];
  readonly raws: RawDecoder;
  pendingKey: { index: number; snapshot: Uint8Array } | null;
  pendingRaw: { index: number; raw: RawFrame; before: RawFrame[] } | null;
  changed: boolean;
}

/** Reads the animation records among `records` (a take's plugin records, in file order). */
export function readAnimationTake(records: Iterable<TakeExtensionRecord>): AnimationTake {
  const targets = new Map<number, Building>();
  const problems: string[] = [];
  let skipped = 0;
  let selected: Building | null = null;
  const problem = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
    else skipped++;
  };
  for (const r of records) {
    switch (r.type) {
      case ANIM_TARGET: {
        const read = decodeTarget(r.payload);
        if ("refused" in read) {
          problem(read.refused);
          selected = null;
          break;
        }
        const t = read.target;
        const known = targets.get(t.id);
        if (known) {
          known.changed ||= known.info.graphHash !== t.graphHash;
          known.info = t;
          known.pendingKey = null;
          known.pendingRaw = null;
          selected = known;
        } else {
          selected = { info: t, entries: [], raws: new RawDecoder(), pendingKey: null, pendingRaw: null, changed: false };
          targets.set(t.id, selected);
        }
        break;
      }
      case ANIM_SELECT: {
        const read = decodeSelect(r.payload);
        if ("refused" in read) problem(read.refused);
        selected = "refused" in read ? null : (targets.get(read.target) ?? null);
        break;
      }
      case ANIM_KEY: {
        const read = decodeKey(r.payload);
        if ("refused" in read) problem(read.refused);
        else if (selected) selected.pendingKey = read;
        break;
      }
      case ANIM_RAW: {
        if (!selected) break;
        const read = selected.raws.decode(r.payload);
        if ("refused" in read) problem(read.refused);
        else selected.pendingRaw = read;
        break;
      }
      case ANIM_FRAME: {
        const read = decodeFrameRecord(r.payload);
        if ("refused" in read) {
          problem(read.refused);
          break;
        }
        if (!selected) break;
        const f = read.frame;
        const raw = selected.pendingRaw?.index === f.index ? selected.pendingRaw : null;
        const key = selected.pendingKey?.index === f.index ? selected.pendingKey.snapshot : null;
        selected.entries.push({ frame: f, raw: raw?.raw ?? null, before: raw?.before ?? [], key });
        selected.pendingRaw = null;
        selected.pendingKey = null;
        break;
      }
      default:
        break;
    }
  }
  if (skipped > 0) problems.push(`${skipped} more records didn't read`);
  const out = [...targets.values()].filter((t) => t.entries.length > 0).map((t): AnimationTakeTarget => ({ info: t.info, entries: t.entries, changedWhileRecording: t.changed }));
  return { targets: out, problems, duration: out.reduce((m, t) => Math.max(m, t.entries.at(-1)?.frame.time ?? 0), 0) };
}
