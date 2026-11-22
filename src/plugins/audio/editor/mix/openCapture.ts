// ADR 0171 amended by 0172 (M5a, task X2; api-and-models §7, architecture §3.7): opening a capture from a file.
//
// One route for both ways in: a `.mycap` dropped on the Profiler panel and the bar's Open button (an `<input type=file>`,
// which is also the picker in the Tauri webview; the editor SDK has no File > Open contribution for plugins, so there is
// no menu hook to register and the ground rules forbid a menu entry) both call `profilerSlots.onDropFile`, which
// `installOpenCapture` fills with `routeCaptureFile`. That reads nothing it will refuse: a name that isn't `.mycap`, or a
// file too big to be a capture, is turned away with a banner before its bytes are read; everything else goes to the
// controller's `openBlob`, whose decode (the Worker, with the security caps in `capture/format.ts`; the file-size bound
// is the reader's `CAPTURE_MAX_FILE_BYTES`) produces the banners for a truncated, foreign, bomb or other-wire file.
// Nothing here raises a decode cap. A take (ADR 0334, `.mycotake`: a capture with the take flag and the game's requests)
// opens the same way; its size bound is the reader's `TAKE_MAX_FILE_BYTES` (the decode accepts that size only with the
// take flag set, so a capture renamed to `.mycotake` is still held to the capture cap there).
import { CAPTURE_MAX_FILE_BYTES, TAKE_MAX_FILE_BYTES } from "../../runtime/capture/reader";
import { TAKE_EXTENSION } from "../../runtime/capture/save";
import type { ProfilerController, ProfilerSlots } from "./ProfilerPanel";

/** The file extension a capture is saved with (`capture/save.ts`). */
export const CAPTURE_EXTENSION = ".mycap";

/** What the route needs of a file (a `File`, or a Tauri-read stand-in). */
export interface CaptureFileLike {
  readonly name: string;
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** What the route needs of the controller (`ProfilerController` satisfies it). */
export type CaptureOpener = Pick<ProfilerController, "openBlob" | "refuseFile">;

/** The name desktop and Android saves get: the engine's Tauri `Storage` adds `.bin` to binary values (`<appData>/cache/<key>.bin`). */
export const CAPTURE_STORAGE_EXTENSION = `${CAPTURE_EXTENSION}.bin`;

/** What a file name says it is: a capture, a take, or neither (null). */
const fileKind = (name: string): "capture" | "take" | null => {
  const n = name.toLowerCase();
  if (n.endsWith(CAPTURE_EXTENSION) || n.endsWith(CAPTURE_STORAGE_EXTENSION)) return "capture";
  if (n.endsWith(TAKE_EXTENSION) || n.endsWith(`${TAKE_EXTENSION}.bin`)) return "take";
  return null;
};

/** The refusal texts (the tests assert them). */
export const OPEN_REFUSALS = {
  notCapture: (name: string): string => `${name} is not a capture file; the Profiler opens ${CAPTURE_EXTENSION} files recorded by Audio.capture and ${TAKE_EXTENSION} takes.`,
  tooBig: (name: string, size: number): string => `${name} is ${size} B, more than any capture this build can open (${CAPTURE_MAX_FILE_BYTES} B).`,
  takeTooBig: (name: string, size: number): string => `${name} is ${size} B, more than any take this build can open (${TAKE_MAX_FILE_BYTES} B).`,
} as const;

/** Opens `file` through the controller, or refuses it with a banner. Resolves true when a capture is now open. */
async function routeCaptureFile(controller: CaptureOpener, file: CaptureFileLike): Promise<boolean> {
  const kind = fileKind(file.name);
  if (kind === null) {
    controller.refuseFile(file.name, "notCapture", OPEN_REFUSALS.notCapture(file.name));
    return false;
  }
  const max = kind === "take" ? TAKE_MAX_FILE_BYTES : CAPTURE_MAX_FILE_BYTES;
  if (file.size !== undefined && file.size > max) {
    controller.refuseFile(file.name, "tooLarge", (kind === "take" ? OPEN_REFUSALS.takeTooBig : OPEN_REFUSALS.tooBig)(file.name, file.size));
    return false;
  }
  return controller.openBlob(file);
}

/**
 * Fills the panel's drop slot (and so the Open button, which shares it) with the route. Returns the undo. `mix/index.ts`'s
 * `loadProfiler` calls it with the loaded panel module's `profilerSlots`.
 */
export function installOpenCapture(slots: Pick<ProfilerSlots, "onDropFile">): () => void {
  const previous = slots.onDropFile;
  slots.onDropFile = (controller, file) => void routeCaptureFile(controller, file);
  return () => {
    slots.onDropFile = previous;
  };
}
