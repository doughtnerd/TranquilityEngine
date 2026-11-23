// The editor's compiled-clip cache (ADR 0371 "Assets": compiled clips "made by the editor's worker into `.myco/anim/`,
// content-keyed like thumbnails (0061)"; T19). A compiled clip is `<key>.anim.bin`, its report `<key>.report.json`; the
// key covers everything the bytes depend on (`engine/animation/compile/keys.ts`), so a hit is always current.
//
// - **Lookup:** memory, then the store, then a compile through the runner (the compile worker, or in-thread where there
//   are no workers). Concurrent asks for one key share one compile.
// - **Index and pruning:** `index.json` maps each request (clip, skeleton, platform) to the key it last compiled to. A
//   request that compiles to a new key lets its old files go when no other request uses that key; `prune` removes files
//   no request names and requests whose clip is gone (as the thumbnail cache prunes keys no asset uses).
// - **Store:** `.myco/anim/` in a writable project folder, memory otherwise (the samples, a read-only browser project).
import type { FileSystem } from "../../../../engine/platform/FileSystem";
import { editor } from "../../../../editor/sdk";
import { keyOfCacheFile } from "../../../../engine/animation/compile/keys";
import type { ClipReport, CompileOutcome } from "./compiler";

/** @internal Where compiled clips are kept, by file name. */
export interface ClipStore {
  /** The folder (for messages), or null for memory. */
  readonly where: string | null;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/** @internal The compiled-clip folder in a project. */
export const CLIP_CACHE_FOLDER = ".myco/anim";

/** @internal The project folder's `.myco/anim/`. */
export function projectClipStore(fs: FileSystem, root: string): ClipStore {
  const dir = editor.project.joinPath(root, CLIP_CACHE_FOLDER);
  const file = (name: string) => editor.project.joinPath(dir, name);
  let made = false;
  return {
    where: dir,
    async read(name) {
      try {
        return (await fs.exists(file(name))) ? await fs.readBinary(file(name)) : null;
      } catch {
        return null;
      }
    },
    async write(name, bytes) {
      if (!made) {
        await fs.mkdir(dir);
        made = true;
      }
      await fs.writeBinary(file(name), bytes);
    },
    async list() {
      try {
        return (await fs.exists(dir)) ? (await fs.list(dir)).filter((e) => !e.isDirectory).map((e) => e.name) : [];
      } catch {
        return [];
      }
    },
    async remove(name) {
      await fs.remove(file(name));
    },
  };
}

/** @internal Compiled clips kept for this session only. */
export function memoryClipStore(): ClipStore {
  const files = new Map<string, Uint8Array>();
  return {
    where: null,
    read: async (name) => files.get(name) ?? null,
    write: async (name, bytes) => void files.set(name, bytes),
    list: async () => [...files.keys()],
    remove: async (name) => void files.delete(name),
  };
}

/** @internal Compiles one clip: the editor module's `compress_clip` (in the worker, or on this thread). */
export type ClipCompileRunner = (job: { readonly raw: Uint8Array; readonly skeleton: Uint8Array; readonly record: Float32Array }) => Promise<CompileOutcome>;

/** @internal A compiled clip. */
export interface CompiledClip {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly report: ClipReport;
}

/** @internal What the cache compiles: a job's inputs, its key, and the request it answers. */
export interface CacheJob {
  /** The request's identity (clip, skeleton and platform): what the index remembers a key for. */
  readonly request: string;
  readonly key: string;
  readonly raw: Uint8Array;
  readonly skeleton: Uint8Array;
  readonly record: Float32Array;
}

const INDEX = "index.json";
const enc = new TextEncoder();
const dec = new TextDecoder();
const binName = (key: string) => `${key}.anim.bin`;
const reportName = (key: string) => `${key}.report.json`;

export class ClipCompileCache {
  private readonly memory = new Map<string, CompiledClip>();
  private readonly pending = new Map<string, Promise<CompiledClip | null>>();
  private index: Map<string, string> | null = null;
  private indexLoad: Promise<Map<string, string>> | null = null;
  private indexWrite: Promise<void> = Promise.resolve();

  constructor(
    readonly store: ClipStore,
    private readonly runner: ClipCompileRunner,
  ) {}

  /** The compiled clip of `key` if it is in memory now. */
  peek(key: string): CompiledClip | null {
    return this.memory.get(key) ?? null;
  }

  /** The compiled clip of `key` from memory or the store, without compiling. */
  async cached(key: string): Promise<CompiledClip | null> {
    const have = this.memory.get(key);
    if (have) return have;
    const [bytes, report] = await Promise.all([this.store.read(binName(key)), this.store.read(reportName(key))]);
    if (!bytes || !report) return null;
    let parsed: ClipReport;
    try {
      parsed = JSON.parse(dec.decode(report)) as ClipReport;
    } catch {
      return null;
    }
    const clip = { key, bytes, report: parsed };
    this.memory.set(key, clip);
    return clip;
  }

  /** The compiled clip for `job`: cached, or compiled now (null when the compile failed: `onError` hears why). */
  async get(job: CacheJob, onError?: (message: string) => void): Promise<CompiledClip | null> {
    await this.remember(job.request, job.key);
    const have = this.memory.get(job.key);
    if (have) return have;
    let p = this.pending.get(job.key);
    if (!p) {
      p = (async () => {
        const stored = await this.cached(job.key);
        if (stored) return stored;
        const out = await this.runner({ raw: job.raw, skeleton: job.skeleton, record: job.record }).catch((err: unknown): CompileOutcome => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        if (!out.ok) {
          onError?.(out.error);
          return null;
        }
        const clip = { key: job.key, bytes: out.bytes, report: out.report };
        this.memory.set(job.key, clip);
        await Promise.all([this.store.write(binName(job.key), out.bytes), this.store.write(reportName(job.key), enc.encode(`${JSON.stringify(out.report)}\n`))]).catch(() => undefined);
        return clip;
      })().finally(() => this.pending.delete(job.key));
      this.pending.set(job.key, p);
    }
    return p;
  }

  /** The key a request last compiled to (this session or an earlier one), or null. */
  async keyOf(request: string): Promise<string | null> {
    return (await this.loadIndex()).get(request) ?? null;
  }

  private loadIndex(): Promise<Map<string, string>> {
    if (this.index) return Promise.resolve(this.index);
    this.indexLoad ??= this.store.read(INDEX).then((bytes) => {
      let entries: [string, string][] = [];
      try {
        const v = bytes ? (JSON.parse(dec.decode(bytes)) as { requests?: Record<string, string> }) : null;
        entries = Object.entries(v?.requests ?? {}).filter((e): e is [string, string] => typeof e[1] === "string" && keyOfCacheFile(`${e[1]}.anim.bin`) !== null);
      } catch {
        // a broken index is rebuilt as clips compile
      }
      this.index ??= new Map(entries);
      return this.index;
    });
    return this.indexLoad;
  }

  /** Records that `request` compiles to `key`; its old key's files go when nothing else names them. */
  private async remember(request: string, key: string): Promise<void> {
    const index = await this.loadIndex();
    const old = index.get(request);
    if (old === key) return;
    index.set(request, key);
    if (old && ![...index.values()].includes(old)) {
      this.memory.delete(old);
      await Promise.all([this.store.remove(binName(old)), this.store.remove(reportName(old))].map((p) => p.catch(() => undefined)));
    }
    await this.saveIndex();
  }

  private saveIndex(): Promise<void> {
    const index = this.index;
    if (!index) return Promise.resolve();
    const requests = Object.fromEntries([...index].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    this.indexWrite = this.indexWrite.then(() => this.store.write(INDEX, enc.encode(`${JSON.stringify({ requests }, null, 2)}\n`))).catch(() => undefined);
    return this.indexWrite;
  }

  /**
   * Removes requests whose clip `exists` says is gone, then every cached file no request names. Returns how many files
   * were removed.
   */
  async prune(exists: (request: string) => boolean): Promise<number> {
    const index = await this.loadIndex();
    for (const request of [...index.keys()]) if (!exists(request)) index.delete(request);
    await this.saveIndex();
    const live = new Set(index.values());
    let removed = 0;
    for (const name of await this.store.list()) {
      const key = keyOfCacheFile(name);
      if (!key || live.has(key)) continue;
      this.memory.delete(key);
      await this.store.remove(name).then(() => removed++, () => undefined);
    }
    return removed;
  }
}
