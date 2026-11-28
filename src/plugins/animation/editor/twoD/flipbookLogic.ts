// Flipbook edits (ADR 0371 "Sprites and 2D", 0373 "2D tools"; T56): the rules of making a flipbook from slices and editing
// one, over the format an image sidecar holds (`flipbooks.<name>: { slices, fps, loop }`, `engine/animation/sprites/sidecar.ts`).
// Pure: every edit a user can get refused returns the refused-or-next result (ADR 0307, 0313), and the views apply it through
// `applyEdit`.
//
// The format has one rate and an ordered list of slice names: no per-frame duration and no events. A frame's duration is
// therefore how many consecutive entries show the same slice (its *hold*, so `hold / fps` seconds), which is exactly how
// the runtime plays it (key `i` starts at `i / fps`). The views show frames as runs of holds; events are not offered since
// the format has none.
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { DEFAULT_FLIPBOOK_FPS, SPRITE_2D_LIMITS, whyNotFlipbookName, type SpriteFlipbook } from "../../../../engine/animation/sprites/sidecar";
import { UNDERSCORED, uniqueName } from "../../../../engine/core/uniqueName";

/** An image's flipbooks by name. */
export type Flipbooks = Readonly<Record<string, SpriteFlipbook>>;

/** One frame as the views show it: a slice and how many entries in a row show it. */
export interface Frame {
  readonly slice: string;
  readonly hold: number;
}

/** Names in natural order: `run_2` before `run_10`, case-insensitive, ties by the plain comparison. */
export function naturalCompare(a: string, b: string): number {
  const ta = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const tb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i]!, y = tb[i]!;
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** `names` ordered by name and number. */
export const orderByName = (names: readonly string[]): string[] => [...names].sort(naturalCompare);

/** The longest shared start of `names` with trailing digits and separators trimmed (`run_0`, `run_1` → `run`), or "". */
function commonStem(names: readonly string[]): string {
  if (names.length === 0) return "";
  let stem = names[0]!;
  for (const n of names) {
    let i = 0;
    while (i < stem.length && i < n.length && stem[i] === n[i]) i++;
    stem = stem.slice(0, i);
  }
  return stem.replace(/[\s_\-.0-9]+$/, "");
}

/** A name for a flipbook of these slices that no flipbook of `taken` has: their common stem (`run`), else `flipbook`, with `_2`, `_3`… when taken. */
export function suggestFlipbookName(slices: readonly string[], taken: Flipbooks): string {
  return uniqueName(commonStem(slices) || "flipbook", (name) => name in taken, UNDERSCORED);
}

/** What creating a flipbook from slices made. */
export interface CreatedFlipbook {
  readonly flipbooks: Flipbooks;
  readonly name: string;
}

/** Options of {@link createFlipbook}. */
export interface CreateFlipbookOptions {
  /** The new flipbook's name (default: {@link suggestFlipbookName}). */
  readonly name?: string;
  readonly fps?: number;
  readonly loop?: boolean;
}

/** Why `fps` isn't a frame rate, or null. */
export function whyNotFps(fps: number): string | null {
  if (!Number.isFinite(fps) || fps <= 0) return "the frame rate must be above 0";
  if (fps > SPRITE_2D_LIMITS.maxFps) return `the frame rate is at most ${SPRITE_2D_LIMITS.maxFps}`;
  return null;
}

/**
 * A flipbook of the `selected` slices (names the image has), its frames ordered by name and number (`run_2` before `run_10`),
 * added to `flipbooks`. Refused with no slices, a slice the image lacks, a name that is bad or taken, or past a limit.
 */
export function createFlipbook(flipbooks: Flipbooks, imageSlices: readonly string[], selected: readonly string[], options: CreateFlipbookOptions = {}): EditResult<CreatedFlipbook> {
  const unique = [...new Set(selected)];
  if (unique.length === 0) return refuse("select at least one slice");
  const missing = unique.filter((s) => !imageSlices.includes(s));
  if (missing.length > 0) return refuse(`the image has no slice named ${missing.map((m) => `"${m}"`).join(", ")}`);
  if (unique.length > SPRITE_2D_LIMITS.framesPerFlipbook) return refuse(`a flipbook has at most ${SPRITE_2D_LIMITS.framesPerFlipbook} frames`);
  const frames = orderByName(unique);
  const name = options.name ?? suggestFlipbookName(frames, flipbooks);
  const fps = options.fps ?? DEFAULT_FLIPBOOK_FPS;
  const why = whyNotFlipbookName(name) ?? whyNotFps(fps);
  if (why) return refuse(why);
  if (name in flipbooks) return refuse(`there's already a flipbook named "${name}"`);
  if (Object.keys(flipbooks).length >= SPRITE_2D_LIMITS.flipbooks) return refuse(`an image has at most ${SPRITE_2D_LIMITS.flipbooks} flipbooks`);
  return accept({ flipbooks: { ...flipbooks, [name]: { slices: frames, fps, loop: options.loop ?? true } }, name });
}

/** `flipbooks` with `name` replaced by what `edit` makes of it; refused when there is no such flipbook or `edit` refuses. */
export function editFlipbook(flipbooks: Flipbooks, name: string, edit: (flipbook: SpriteFlipbook) => EditResult<SpriteFlipbook>): EditResult<Flipbooks> {
  const flipbook = flipbooks[name];
  if (!flipbook) return refuse(`there's no flipbook named "${name}"`);
  const result = edit(flipbook);
  if ("refused" in result) return result;
  return accept(result.next === flipbook ? flipbooks : { ...flipbooks, [name]: result.next });
}

/** `flipbooks` without `name`. */
export function removeFlipbook(flipbooks: Flipbooks, name: string): EditResult<Flipbooks> {
  if (!(name in flipbooks)) return refuse(`there's no flipbook named "${name}"`);
  return accept(Object.fromEntries(Object.entries(flipbooks).filter(([n]) => n !== name)));
}

/** `flipbooks` with `from` renamed `to`, in the same place in the list. Refused for a bad name, a taken one or no such flipbook. */
export function renameFlipbook(flipbooks: Flipbooks, from: string, to: string): EditResult<Flipbooks> {
  if (!(from in flipbooks)) return refuse(`there's no flipbook named "${from}"`);
  if (to === from) return accept(flipbooks);
  const why = whyNotFlipbookName(to);
  if (why) return refuse(why);
  if (to in flipbooks) return refuse(`there's already a flipbook named "${to}"`);
  return accept(Object.fromEntries(Object.entries(flipbooks).map(([n, f]) => [n === from ? to : n, f])));
}

/** The flipbook with this frame rate (frames per second). */
export function setFps(flipbook: SpriteFlipbook, fps: number): EditResult<SpriteFlipbook> {
  const why = whyNotFps(fps);
  if (why) return refuse(why);
  return accept(fps === flipbook.fps ? flipbook : { ...flipbook, fps });
}

/** The flipbook looping or not. */
export const setLoop = (flipbook: SpriteFlipbook, loop: boolean): EditResult<SpriteFlipbook> => accept(loop === flipbook.loop ? flipbook : { ...flipbook, loop });

/** The flipbook's frames as runs: each slice with how many entries in a row show it. */
export function framesOf(flipbook: SpriteFlipbook): Frame[] {
  const out: { slice: string; hold: number }[] = [];
  for (const slice of flipbook.slices) {
    const last = out[out.length - 1];
    if (last && last.slice === slice) last.hold++;
    else out.push({ slice, hold: 1 });
  }
  return out;
}

const entries = (frames: readonly Frame[]): string[] => frames.flatMap((f) => Array<string>(f.hold).fill(f.slice));

/** The flipbook showing `frames` in turn (runs of the same slice merge when stored, as {@link framesOf} reads them back). */
function withFrames(flipbook: SpriteFlipbook, frames: readonly Frame[]): EditResult<SpriteFlipbook> {
  const slices = entries(frames);
  if (slices.length === 0) return refuse("a flipbook needs at least one frame");
  if (slices.length > SPRITE_2D_LIMITS.framesPerFlipbook) return refuse(`a flipbook has at most ${SPRITE_2D_LIMITS.framesPerFlipbook} frames (holds count)`);
  return accept({ ...flipbook, slices });
}

/** Frame `from` moved to position `to` (both indices into {@link framesOf}). Refused out of range. */
export function moveFrame(flipbook: SpriteFlipbook, from: number, to: number): EditResult<SpriteFlipbook> {
  const frames = framesOf(flipbook);
  if (!Number.isInteger(from) || from < 0 || from >= frames.length) return refuse(`there's no frame ${from + 1}`);
  if (!Number.isInteger(to) || to < 0 || to >= frames.length) return refuse(`there's no position ${to + 1}`);
  if (from === to) return accept(flipbook);
  const [moved] = frames.splice(from, 1);
  frames.splice(to, 0, moved!);
  return withFrames(flipbook, frames);
}

/** Frame `index` held for `hold` entries, so it lasts `hold / fps` seconds. Refused below 1 or out of range. */
export function setHold(flipbook: SpriteFlipbook, index: number, hold: number): EditResult<SpriteFlipbook> {
  const frames = framesOf(flipbook);
  if (!Number.isInteger(index) || index < 0 || index >= frames.length) return refuse(`there's no frame ${index + 1}`);
  if (!Number.isInteger(hold) || hold < 1) return refuse("a frame is held for at least 1 entry");
  return withFrames(flipbook, frames.map((f, i) => (i === index ? { ...f, hold } : f)));
}

/** `slice` added as a new frame at `at` (default: the end). Refused for a slice the image lacks (`imageSlices`) or past the limit. */
export function addFrame(flipbook: SpriteFlipbook, slice: string, imageSlices: readonly string[], at?: number): EditResult<SpriteFlipbook> {
  if (!imageSlices.includes(slice)) return refuse(`the image has no slice named "${slice}"`);
  const frames = framesOf(flipbook);
  const position = at === undefined ? frames.length : Math.max(0, Math.min(frames.length, at));
  frames.splice(position, 0, { slice, hold: 1 });
  return withFrames(flipbook, frames);
}

/** Frame `index` removed. Refused for the only frame or out of range. */
export function removeFrame(flipbook: SpriteFlipbook, index: number): EditResult<SpriteFlipbook> {
  const frames = framesOf(flipbook);
  if (!Number.isInteger(index) || index < 0 || index >= frames.length) return refuse(`there's no frame ${index + 1}`);
  if (frames.length === 1) return refuse("a flipbook needs at least one frame");
  return withFrames(flipbook, frames.filter((_, i) => i !== index));
}

/** Seconds a frame lasts. */
export const frameSeconds = (flipbook: SpriteFlipbook, hold: number): number => hold / flipbook.fps;

/** Seconds one pass takes (the runtime's clip duration). */
export const flipbookDuration = (flipbook: SpriteFlipbook): number => flipbook.slices.length / flipbook.fps;

/** The slice showing `seconds` into the flipbook, as the runtime plays it: entry `floor(t × fps)`, wrapping when it loops and holding the last when it doesn't. Null for no frames. */
export function sliceAt(flipbook: SpriteFlipbook, seconds: number): string | null {
  const n = flipbook.slices.length;
  if (n === 0) return null;
  const i = Math.floor(Math.max(0, seconds) * flipbook.fps + 1e-9);
  return flipbook.slices[flipbook.loop ? i % n : Math.min(i, n - 1)] ?? null;
}

/** A slice drawn as a CSS background crop of the image in a `box` × `box` preview: its size and where the image sits behind it. */
export function frameCrop(rect: readonly [number, number, number, number], image: readonly [number, number], box: number): { width: number; height: number; backgroundSize: string; backgroundPosition: string } {
  const scale = box / Math.max(1, rect[2], rect[3]);
  return { width: rect[2] * scale, height: rect[3] * scale, backgroundSize: `${image[0] * scale}px ${image[1] * scale}px`, backgroundPosition: `${-rect[0] * scale}px ${-rect[1] * scale}px` };
}
