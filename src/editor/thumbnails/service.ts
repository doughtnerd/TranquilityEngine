// The thumbnail service (ADR 0061): finds an asset's thumbnail in memory, then in the store, and
// otherwise renders it (through the frame queue) and stores it. Keys are content hashes, worked
// out lazily and remembered while the files behind them are unchanged.
import { type AudioSummary, decodeSummary, encodeSummary } from "./audio";
import { contentKey, keyOfFile, previewDependencies, previewKind, type PreviewKind } from "./keys";
import { FrameQueue } from "./queue";
import type { ThumbnailExt, ThumbnailStore } from "./store";

/** The project, as the service sees it. */
export interface ThumbnailProject {
  readonly files: readonly string[];
  /** A text file's text (JSON, .obj, .mtl), or undefined. */
  text(path: string): string | undefined;
  /** A file's bytes. */
  bytes(path: string): Promise<Uint8Array>;
  /** Something that changes whenever the file does (its text, or URL and size), or undefined if it's gone. */
  stamp(path: string): string | undefined;
}

/** How thumbnails are made: the engine's renderer and the audio decoder. */
export interface ThumbnailMaker {
  /** A still image of the asset, or null if it can't be previewed (missing, broken). */
  render(kind: Exclude<PreviewKind, "audio">, path: string): Promise<Blob | null>;
  decodeAudio(bytes: Uint8Array): Promise<AudioSummary>;
}

export interface Thumbnail {
  /**
   * An object URL for the image. It's revoked when the service is disposed, or when the asset is
   * edited and no asset uses the old image any more, but never while something holds it (`hold`).
   */
  url: string;
}

/** A thumbnail being made or made, shared by everyone asking for its key. */
interface ImageEntry {
  image: Promise<Thumbnail | null>;
  /** Drops the render once every caller that can go away has (see `thumbnailFor`). */
  controller: AbortController;
  /** Callers waiting that passed no signal (so it's never dropped), and ones whose signal hasn't fired. */
  steady: number;
  waiting: number;
  settled: boolean;
  /** The image's object URL once made, so it can be revoked when no asset uses the key any more. */
  url?: string;
}

interface KeyEntry {
  /** The stamps of the asset and its dependencies when the key was worked out. */
  stamps: string;
  key: Promise<string | null>;
}

export class ThumbnailService {
  private readonly keys = new Map<string, KeyEntry>();
  /** Images by key, and requests in flight. */
  private readonly images = new Map<string, ImageEntry>();
  private readonly summaries = new Map<string, Promise<AudioSummary | null>>();
  private readonly urls = new Set<string>();
  /** The key each asset's thumbnail was last asked for under, so an edited asset lets its old image go. */
  private readonly pathKeys = new Map<string, string>();
  /** How many holders show each URL (see `hold`), and the let-go URLs waiting for their last holder. */
  private readonly holds = new Map<string, number>();
  private readonly retired = new Set<string>();
  private disposed = false;

  constructor(
    private readonly project: ThumbnailProject,
    readonly store: ThumbnailStore,
    private readonly maker: ThumbnailMaker,
    private readonly queue = new FrameQueue(2),
  ) {}

  /** The asset's thumbnail key, or null when it has no preview or its file is gone. */
  async keyFor(path: string): Promise<string | null> {
    const kind = previewKind(path);
    if (!kind || this.project.stamp(path) === undefined) return null;
    const deps = await this.dependencies(path);
    const stamps = [path, ...deps].map((p) => `${p}\u0000${this.project.stamp(p) ?? ""}`).join("\u0001");
    const have = this.keys.get(path);
    if (have && have.stamps === stamps) return have.key;
    const key = (async () => {
      try {
        const [asset, ...rest] = await Promise.all([path, ...deps].map((p) => this.project.bytes(p)));
        return await contentKey(kind, asset, rest);
      } catch {
        return null;
      }
    })();
    this.keys.set(path, { stamps, key });
    return key;
  }

  /** Texts of .obj and .mtl files (which the project serves as URLs, not text), by path and stamp. */
  private readonly wavefront = new Map<string, { stamp: string; text: string }>();

  /** The preview's dependencies, reading the .obj and .mtl files on the way (their texts name more files). */
  private async dependencies(path: string): Promise<string[]> {
    const source = {
      files: this.project.files,
      text: (p: string) => this.project.text(p) ?? this.wavefront.get(p)?.text,
    };
    for (let round = 0; round < 8; round++) {
      const deps = previewDependencies(path, source);
      const missing = [path, ...deps].filter((p) => /\.(obj|mtl)$/i.test(p) && this.project.text(p) === undefined && this.wavefront.get(p)?.stamp !== this.project.stamp(p));
      if (!missing.length) return deps;
      for (const p of missing) {
        const stamp = this.project.stamp(p) ?? "";
        const text = await this.project.bytes(p).then((b) => new TextDecoder().decode(b), () => "");
        this.wavefront.set(p, { stamp, text });
      }
    }
    return previewDependencies(path, source);
  }

  /**
   * The asset's thumbnail: from memory, the store, or rendered now (queued). `signal` says the
   * caller may go away (a tile scrolled out of view): the render is dropped only once every caller
   * waiting for it has gone, so a tile leaving never cancels the Inspector's request for the same
   * asset. Null for assets without one, and for ones that fail or are dropped.
   */
  async thumbnailFor(path: string, signal?: AbortSignal): Promise<Thumbnail | null> {
    const kind = previewKind(path);
    if (!kind || kind === "audio") return null;
    const key = await this.keyFor(path);
    if (!key || this.disposed || signal?.aborted) return null;
    const previous = this.pathKeys.get(path);
    this.pathKeys.set(path, key);
    let entry = this.images.get(key);
    if (!entry) {
      const controller = new AbortController();
      const made: ImageEntry = { image: this.loadOrRender(kind, path, key, controller.signal), controller, steady: 0, waiting: 0, settled: false };
      entry = made;
      this.images.set(key, made);
      const settle = (t: Thumbnail | null) => {
        made.settled = true;
        made.url = t?.url;
        // A dropped or failed request isn't remembered, so the next one tries again.
        if (!t && this.images.get(key) === made) this.images.delete(key);
      };
      void made.image.then(settle, () => settle(null));
    }
    if (!entry.settled) this.join(entry, signal);
    // The asset changed: once its new image is ready (so nothing shows a revoked picture meanwhile),
    // let the old one go unless another asset still uses that key.
    if (previous && previous !== key) void entry.image.finally(() => this.release(previous)).catch(() => undefined);
    return entry.image;
  }

  /** Revoke the image for `key` and forget it, unless an asset's thumbnail still uses that key. */
  private release(key: string): void {
    if (this.disposed) return;
    for (const k of this.pathKeys.values()) if (k === key) return;
    const entry = this.images.get(key);
    if (!entry?.settled) return; // still being made for someone
    this.images.delete(key);
    if (!entry.url) return;
    // An <img> may still show (or be loading) it: revoking now would fail its fetch.
    if (this.holds.has(entry.url)) this.retired.add(entry.url);
    else this.revoke(entry.url);
  }

  private revoke(url: string): void {
    URL.revokeObjectURL(url);
    this.urls.delete(url);
    this.retired.delete(url);
  }

  /**
   * Keep `url` alive while it's shown: an edited asset's old image is revoked only once every
   * holder has let go. Hold it before showing it and let go after the replacement is shown.
   * Returns the release (calling it again does nothing).
   */
  hold(url: string): () => void {
    if (this.disposed || !this.urls.has(url)) return () => undefined;
    this.holds.set(url, (this.holds.get(url) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const n = (this.holds.get(url) ?? 1) - 1;
      if (n > 0) return void this.holds.set(url, n);
      this.holds.delete(url);
      if (this.retired.has(url) && !this.disposed) this.revoke(url);
    };
  }

  /** How many images the service holds (tests: edited assets don't pile up). */
  get imageCount(): number {
    return this.images.size;
  }

  /** Count a caller waiting for `entry`; when every one that can go away has, drop the render. */
  private join(entry: ImageEntry, signal?: AbortSignal): void {
    if (!signal) {
      entry.steady++;
      void entry.image.finally(() => entry.steady--).catch(() => undefined);
      return;
    }
    entry.waiting++;
    const leave = () => {
      entry.waiting--;
      if (!entry.settled && entry.waiting === 0 && entry.steady === 0) entry.controller.abort();
    };
    signal.addEventListener("abort", leave, { once: true });
    void entry.image.finally(() => signal.removeEventListener("abort", leave)).catch(() => undefined);
  }

  private async loadOrRender(kind: Exclude<PreviewKind, "audio">, path: string, key: string, signal?: AbortSignal): Promise<Thumbnail | null> {
    for (const ext of ["webp", "png"] as const) {
      const bytes = await this.store.read(key, ext);
      if (this.disposed) return null;
      if (bytes) return this.toUrl(bytes, ext);
    }
    let blob: Blob | null;
    try {
      blob = await this.queue.run(() => this.maker.render(kind, path), signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.warn(`[myco] couldn't make a thumbnail for ${path}:`, err);
      return null;
    }
    if (!blob || this.disposed) return null;
    const ext: ThumbnailExt = blob.type === "image/webp" ? "webp" : "png";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The render read the files as they were when it ran. If they changed after the key was worked
    // out, the image may not match the key: show it, but don't store it under that key.
    if ((await this.keyFor(path)) === key) {
      await this.store.write(key, ext, bytes).catch((err) => console.warn(`[myco] couldn't save a thumbnail in ${this.store.where}:`, err));
    }
    return this.disposed ? null : this.toUrl(bytes, ext);
  }

  private toUrl(bytes: Uint8Array, ext: "webp" | "png"): Thumbnail {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${ext}` }));
    this.urls.add(url);
    return { url };
  }

  /** An audio clip's waveform peaks, length, channels and sample rate (cached like thumbnails), or null. */
  async audioSummaryFor(path: string): Promise<AudioSummary | null> {
    if (previewKind(path) !== "audio") return null;
    const key = await this.keyFor(path);
    if (!key || this.disposed) return null;
    let summary = this.summaries.get(key);
    if (!summary) {
      summary = (async () => {
        const stored = await this.store.read(key, "peaks.json");
        const parsed = stored && decodeSummary(stored);
        if (parsed) return parsed;
        try {
          const made = await this.maker.decodeAudio(await this.project.bytes(path));
          await this.store.write(key, "peaks.json", encodeSummary(made)).catch(() => undefined);
          return made;
        } catch (err) {
          console.warn(`[myco] couldn't read the audio in ${path}:`, err);
          return null;
        }
      })();
      this.summaries.set(key, summary);
      void summary.then((s) => s ?? this.summaries.delete(key));
    }
    return summary;
  }

  /**
   * Delete stored thumbnails no asset uses (renamed-away versions, deleted assets). Works out
   * every previewed asset's key first; if any asset couldn't be read (a file locked or mid-write),
   * its key is unknown, so nothing is deleted this time rather than risk deleting its thumbnail.
   * Returns how many files were removed.
   */
  async prune(): Promise<number> {
    const live = new Set<string>();
    for (const path of this.project.files) {
      if (this.disposed) return 0;
      const key = await this.keyFor(path);
      if (key) live.add(key);
      else if (previewKind(path) && this.project.stamp(path) !== undefined) return 0; // couldn't be read
    }
    if (this.disposed) return 0;
    let removed = 0;
    for (const name of await this.store.list()) {
      const key = keyOfFile(name);
      if (!key || live.has(key)) continue;
      await this.store.remove(name).then(() => removed++, () => undefined);
    }
    return removed;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.holds.clear();
    this.retired.clear();
    this.images.clear();
    this.summaries.clear();
    this.keys.clear();
    this.pathKeys.clear();
  }
}
