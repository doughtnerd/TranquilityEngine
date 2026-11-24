// ADR 0348: a take's pictures (`FRAME` records): a small JPEG of the game view about once a second, so the Take screen
// shows what was on screen when each request was made. Off the hot path: a grab is offered once per audio frame and
// taken at most once a second; the canvas is snapshotted after the frame has rendered (the audio system runs in late
// update, before the render, so the snapshot waits for the end of the task), then scaled and encoded asynchronously
// (`createImageBitmap` and an `OffscreenCanvas` where the browser has them). While one picture is still encoding the next
// offer is skipped, never queued, so a slow encoder costs pictures, not frames. Without a canvas (headless) nothing is
// grabbed and nothing fails.
//
// Part of the take recorder's lazy chunk.
import { TAKE_FRAME_MAX_BYTES, TAKE_FRAME_MAX_SIDE } from "../../../../engine/audio/take/records";
import { TAKE_PICTURE_DEFAULT_WIDTH, TAKE_PICTURE_MAX_WIDTH, TAKE_PICTURE_MIN_WIDTH, type TakeFrame } from "../../../../engine/audio/take/types";
import type { TakePictureSource } from "./takeTap";

export type { TakePictureSource };

/** A picture's width, pixels, unless the take asks for another (`TakeFrameGrabberOptions.width`); its height keeps the view's aspect. */
export const TAKE_FRAME_WIDTH = TAKE_PICTURE_DEFAULT_WIDTH;
/** JPEG quality, 0..1. */
export const TAKE_FRAME_QUALITY = 0.6;
/** Seconds between pictures, at least. */
export const TAKE_FRAME_INTERVAL = 1;
/** Encodes that fail in a row before the take stops asking for pictures (a browser that can't encode one). */
const MAX_FAILURES = 3;

/** Scales `source` to `width` x `height` and encodes it as a JPEG; null when the platform can't. Must snapshot `source` synchronously. */
export type EncodeTakeFrame = (source: TakePictureSource, width: number, height: number) => Promise<Uint8Array | null>;

/** What a picture past `TAKE_FRAME_MAX_BYTES` scales the next ones' width by (a busy view at a large width). */
const OVERSIZE_STEP = 0.75;

/** The size a picture of a `w` x `h` view is taken at: `maxWidth` wide (never wider than the view), the aspect kept. Null for an empty view. */
function takeFrameSize(w: number, h: number, maxWidth: number): { width: number; height: number } | null {
  if (!(w >= 1 && h >= 1) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const width = Math.min(maxWidth, Math.round(w));
  const height = Math.min(TAKE_FRAME_MAX_SIDE, Math.max(1, Math.round((h * width) / w)));
  return { width, height };
}

const bytesOf = async (blob: Blob | null): Promise<Uint8Array | null> => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);

/** The browser's encoder: `createImageBitmap` (snapshot and scale) and an `OffscreenCanvas` JPEG, else a canvas element's `toBlob`. */
export const encodeTakeFrame: EncodeTakeFrame = async (source, width, height) => {
  const g = globalThis as { createImageBitmap?: typeof createImageBitmap; OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  const image = source as unknown as CanvasImageSource;
  if (typeof g.createImageBitmap === "function" && typeof g.OffscreenCanvas === "function") {
    const bitmap = await g.createImageBitmap(image as ImageBitmapSource, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" });
    try {
      const canvas = new g.OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      return await bytesOf(await canvas.convertToBlob({ type: "image/jpeg", quality: TAKE_FRAME_QUALITY }));
    } finally {
      bitmap.close();
    }
  }
  if (!g.document) return null;
  const canvas = g.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  return bytesOf(await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", TAKE_FRAME_QUALITY)));
};

export interface TakeFrameGrabberOptions {
  /**
   * The pictures' width, pixels (`TAKE_PICTURE_MIN_WIDTH`..`TAKE_PICTURE_MAX_WIDTH`, clamped); default `TAKE_FRAME_WIDTH`.
   * A picture that encodes past `TAKE_FRAME_MAX_BYTES` is dropped and the next ones are taken narrower (a busy view at a
   * large width), down to the minimum.
   */
  width?: number;
  /** The encoder (tests pass a fake); default the browser's. */
  encode?: EncodeTakeFrame;
  /** Runs the grab once the frame has rendered; default `queueMicrotask` (the end of the current task, before the page is composited). */
  defer?: (fn: () => void) => void;
}

/** Takes the take's pictures: `offer` each audio frame, `write` gets each encoded one. */
export class TakeFrameGrabber {
  private readonly encode: EncodeTakeFrame;
  private readonly defer: (fn: () => void) => void;
  private last = -Infinity;
  private busy = false;
  private failures = 0;
  private written = 0;
  private width: number;

  constructor(private readonly write: (frame: TakeFrame) => void, opts: TakeFrameGrabberOptions = {}) {
    const width = opts.width ?? TAKE_FRAME_WIDTH;
    this.width = Number.isFinite(width) ? Math.max(TAKE_PICTURE_MIN_WIDTH, Math.min(TAKE_PICTURE_MAX_WIDTH, Math.round(width))) : TAKE_FRAME_WIDTH;
    this.encode = opts.encode ?? encodeTakeFrame;
    this.defer = opts.defer ?? ((fn) => queueMicrotask(fn));
  }

  /** Pictures written so far. */
  get count(): number {
    return this.written;
  }

  /** An audio frame at take time `t`: a picture of `source` when a second has passed and none is encoding. */
  offer(source: TakePictureSource | null, t: number): void {
    if (!source || this.busy || this.failures >= MAX_FAILURES || t - this.last < TAKE_FRAME_INTERVAL) return;
    const size = takeFrameSize(source.width, source.height, this.width);
    if (!size) return;
    this.busy = true;
    this.last = t;
    this.defer(() => {
      let pending: Promise<Uint8Array | null>;
      try {
        pending = this.encode(source, size.width, size.height);
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.then(
        (jpeg) => {
          this.busy = false;
          if (jpeg && jpeg.byteLength > TAKE_FRAME_MAX_BYTES && size.width > TAKE_PICTURE_MIN_WIDTH) {
            // Too big for a FRAME record: not the encoder's failure, the width's. Take the next ones narrower.
            this.width = Math.max(TAKE_PICTURE_MIN_WIDTH, Math.floor(size.width * OVERSIZE_STEP));
            return;
          }
          if (!jpeg || jpeg.byteLength === 0 || jpeg.byteLength > TAKE_FRAME_MAX_BYTES) {
            this.failures++;
            return;
          }
          this.failures = 0;
          this.written++;
          this.write({ t, width: size.width, height: size.height, jpeg });
        },
        () => {
          this.busy = false;
          this.failures++;
        },
      );
    });
  }
}
