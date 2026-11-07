/**
 * A canvas's CSS size (`clientWidth` x `clientHeight`), kept up to date without a layout read per
 * call. Reading `clientWidth` while the DOM is dirty forces a synchronous layout, and the camera's
 * maths asks for the size many times a frame (in the editor the DOM is often dirty), so the size is
 * read once when it may have changed: when a `ResizeObserver` on the canvas reports (layout has just
 * run, so the read is cheap) or after `invalidate()` (the surface changed the canvas's style).
 * Without `ResizeObserver` every call reads the canvas, as before.
 * @internal
 */
export class CanvasCssSize {
  private size: { readonly width: number; readonly height: number } = { width: 0, height: 0 };
  private stale = true;
  private observer: ResizeObserver | null;

  constructor(
    private readonly canvas: Pick<HTMLElement, "clientWidth" | "clientHeight">,
    Observer: typeof ResizeObserver | undefined = globalThis.ResizeObserver,
  ) {
    this.observer = Observer ? new Observer(() => this.read()) : null;
    this.observer?.observe(canvas as Element);
  }

  /** The canvas's CSS size in whole pixels, like `canvas.clientWidth` / `clientHeight`; zero when not laid out. */
  get(): { readonly width: number; readonly height: number } {
    if (this.stale) this.read();
    return this.size;
  }

  /** The canvas's size may have changed (its style was set): read it again on the next `get()`. */
  invalidate(): void {
    this.stale = true;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.stale = true;
  }

  private read(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (width !== this.size.width || height !== this.size.height) this.size = { width, height };
    this.stale = !this.observer;
  }
}
