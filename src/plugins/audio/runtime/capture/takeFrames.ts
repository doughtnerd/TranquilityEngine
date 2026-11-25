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
/** JPEG quality, 0..1: the first of `QUALITIES`. */
export const TAKE_FRAME_QUALITY = 0.6;
/** Seconds between pictures, at least. */
export const TAKE_FRAME_INTERVAL = 1;
/** Encodes that fail in a row before the take stops asking for pictures (a browser that can't encode one). */
const MAX_FAILURES = 3;

/** Scales `source` to `width` x `height` and encodes it as a JPEG at `quality` (0..1); null when the platform can't. Must snapshot `source` synchronously. */
export type EncodeTakeFrame = (source: TakePictureSource, width: number, height: number, quality: number) => Promise<Uint8Array | null>;

/**
 * The JPEG qualities a picture past `TAKE_FRAME_MAX_BYTES` (a busy view at a large width) steps down through, before
 * the width does: the picture stays as wide as asked for as long as a lower quality makes it fit.
 */
const QUALITIES = [TAKE_FRAME_QUALITY, 0.45, 0.3] as const;
/** What a picture past `TAKE_FRAME_MAX_BYTES` at the lowest quality scales the next ones' width by. */
const OVERSIZE_STEP = 0.75;
/** Pictures in a row that fit before a stepped-down take tries a step back up (towards the width and quality asked for). */
const GROW_AFTER = 5;
/** A step back up is tried only when the picture it predicts stays within this share of `TAKE_FRAME_MAX_BYTES`. */
const GROW_HEADROOM = 0.8;
/** About how much larger a picture gets one quality step up (0.3 to 0.45, 0.45 to 0.6). */
const QUALITY_GROWTH = 1.5;

/**
 * The size a picture of a `w` x `h` view is taken at: `width` wide whatever the view's own width (the width the Studio
 * asked for), the aspect kept; a view so tall its height would pass `TAKE_FRAME_MAX_SIDE` is taken narrower. Null for an
 * empty view.
 */
function takeFrameSize(w: number, h: number, width: number): { width: number; height: number } | null {
  if (!(w >= 1 && h >= 1) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const height = Math.max(1, Math.round((h * width) / w));
  if (height <= TAKE_FRAME_MAX_SIDE) return { width, height };
  return { width: Math.max(1, Math.round((w * TAKE_FRAME_MAX_SIDE) / h)), height: TAKE_FRAME_MAX_SIDE };
}

const bytesOf = async (blob: Blob | null): Promise<Uint8Array | null> => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);

/** The browser's encoder: `createImageBitmap` (snapshot and scale) and an `OffscreenCanvas` JPEG, else a canvas element's `toBlob`. */
export const encodeTakeFrame: EncodeTakeFrame = async (source, width, height, quality) => {
  const g = globalThis as { createImageBitmap?: typeof createImageBitmap; OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  const image = source as unknown as CanvasImageSource;
  if (typeof g.createImageBitmap === "function" && typeof g.OffscreenCanvas === "function") {
    const bitmap = await g.createImageBitmap(image as ImageBitmapSource, { resizeWidth: width, resizeHeight: height, resizeQuality: "low" });
    try {
      const canvas = new g.OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      return await bytesOf(await canvas.convertToBlob({ type: "image/jpeg", quality }));
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
  return bytesOf(await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)));
};

export interface TakeFrameGrabberOptions {
  /**
   * The pictures' width, pixels (`TAKE_PICTURE_MIN_WIDTH`..`TAKE_PICTURE_MAX_WIDTH`, clamped); default `TAKE_FRAME_WIDTH`.
   * Every picture is this wide, whatever the view's own width. A picture that encodes past `TAKE_FRAME_MAX_BYTES` (a busy
   * view at a large width) is dropped and the next ones are encoded at a lower JPEG quality, and only once the lowest
   * quality is still too large, narrower (down to the minimum). After a run of pictures that fit, the take steps back up
   * towards this width and the full quality.
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
  /** The width asked for. */
  private readonly target: number;
  /** The width pictures are taken at now: `target` unless pictures that size didn't fit. */
  private width: number;
  /** Index into `QUALITIES` pictures are encoded at now. */
  private quality = 0;
  /** Pictures in a row that fit since the width or quality last changed. */
  private fits = 0;

  constructor(private readonly write: (frame: TakeFrame) => void, opts: TakeFrameGrabberOptions = {}) {
    const width = opts.width ?? TAKE_FRAME_WIDTH;
    this.target = Number.isFinite(width) ? Math.max(TAKE_PICTURE_MIN_WIDTH, Math.min(TAKE_PICTURE_MAX_WIDTH, Math.round(width))) : TAKE_FRAME_WIDTH;
    this.width = this.target;
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
    const quality = this.quality;
    this.busy = true;
    this.last = t;
    this.defer(() => {
      let pending: Promise<Uint8Array | null>;
      try {
        pending = this.encode(source, size.width, size.height, QUALITIES[quality]!);
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.then(
        (jpeg) => {
          this.busy = false;
          if (jpeg && jpeg.byteLength > TAKE_FRAME_MAX_BYTES && this.shrink(size.width, quality)) return;
          if (!jpeg || jpeg.byteLength === 0 || jpeg.byteLength > TAKE_FRAME_MAX_BYTES) {
            this.failures++;
            return;
          }
          this.failures = 0;
          this.written++;
          this.write({ t, width: size.width, height: size.height, jpeg });
          this.grow(jpeg.byteLength, size.width, quality);
        },
        () => {
          this.busy = false;
          this.failures++;
        },
      );
    });
  }

  /**
   * A picture `width` wide at `quality` was too big for a FRAME record: not the encoder's failure, the size's. The next
   * ones take a lower quality, else a narrower width. False when neither can go lower.
   */
  private shrink(width: number, quality: number): boolean {
    this.fits = 0;
    if (quality + 1 < QUALITIES.length) {
      this.quality = Math.max(this.quality, quality + 1);
      return true;
    }
    if (width <= TAKE_PICTURE_MIN_WIDTH) return false;
    this.width = Math.min(this.width, Math.max(TAKE_PICTURE_MIN_WIDTH, Math.floor(width * OVERSIZE_STEP)));
    return true;
  }

  /**
   * A picture `width` wide at `quality` of `bytes` fit. After `GROW_AFTER` in a row, a take that stepped down steps back
   * up (the width first, then the quality: the reverse of `shrink`) when the picture that predicts stays well inside the cap.
   */
  private grow(bytes: number, width: number, quality: number): void {
    if (width !== this.width || quality !== this.quality) return; // the step changed while this one encoded
    if (++this.fits < GROW_AFTER) return;
    const room = TAKE_FRAME_MAX_BYTES * GROW_HEADROOM;
    if (this.width < this.target) {
      const wider = Math.min(this.target, Math.ceil(this.width / OVERSIZE_STEP));
      if (bytes * (wider / this.width) ** 2 <= room) {
        this.width = wider;
        this.fits = 0;
      }
    } else if (this.quality > 0 && bytes * QUALITY_GROWTH <= room) {
      this.quality--;
      this.fits = 0;
    }
  }
}
