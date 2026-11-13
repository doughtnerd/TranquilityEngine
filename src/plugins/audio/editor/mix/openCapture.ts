// ADR 0171 amended by 0172 (M5a, task X2; api-and-models §7, architecture §3.7): opening a capture from a file.
//
// One route for both ways in: a `.mycap` dropped on the Profiler panel and the bar's Open button (an `<input type=file>`,
// which is also the picker in the Tauri webview; the editor SDK has no File > Open contribution for plugins, so there is
// no menu hook to register and the ground rules forbid a menu entry) both call `profilerSlots.onDropFile`, which
// `installOpenCapture` fills with `routeCaptureFile`. That reads nothing it will refuse: a name that isn't `.mycap`, or a
// file too big to be a capture, is turned away with a banner before its bytes are read; everything else goes to the
// controller's `openBlob`, whose decode (the Worker, with the security caps in `capture/format.ts`) produces the banners
// for a truncated, foreign, bomb or other-wire file. Nothing here raises a decode cap.
import { CAPTURE_HEADER_BYTES, CAPTURE_MAX_UNCOMPRESSED_BYTES, CAPTURE_META_MAX_BYTES } from "../../runtime/capture/format";
import type { ProfilerController, ProfilerSlots } from "./ProfilerPanel";

/** The file extension a capture is saved with (`capture/save.ts`). */
export const CAPTURE_EXTENSION = ".mycap";

/**
 * The largest file the route reads: the header, a META chunk and an uncompressed payload at its cap, which a stored
 * (uncompressed) capture can reach and deflate output never exceeds by more than the same slack. Past it the file can't be
 * a capture the decoder would accept, so it is refused unread rather than loaded into memory first.
 */
export const OPEN_MAX_FILE_BYTES = CAPTURE_HEADER_BYTES + CAPTURE_META_MAX_BYTES + CAPTURE_MAX_UNCOMPRESSED_BYTES;

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

export const isCaptureFileName = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.endsWith(CAPTURE_EXTENSION) || n.endsWith(CAPTURE_STORAGE_EXTENSION);
};

/** The refusal texts (the tests assert them). */
export const OPEN_REFUSALS = {
  notCapture: (name: string): string => `${name} is not a capture file; the Profiler opens ${CAPTURE_EXTENSION} files recorded by Audio.capture.`,
  tooBig: (name: string, size: number): string => `${name} is ${size} B, more than any capture this build can open (${OPEN_MAX_FILE_BYTES} B).`,
} as const;

/** Opens `file` through the controller, or refuses it with a banner. Resolves true when a capture is now open. */
export async function routeCaptureFile(controller: CaptureOpener, file: CaptureFileLike): Promise<boolean> {
  if (!isCaptureFileName(file.name)) {
    controller.refuseFile(file.name, "notCapture", OPEN_REFUSALS.notCapture(file.name));
    return false;
  }
  if (file.size !== undefined && file.size > OPEN_MAX_FILE_BYTES) {
    controller.refuseFile(file.name, "tooLarge", OPEN_REFUSALS.tooBig(file.name, file.size));
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
