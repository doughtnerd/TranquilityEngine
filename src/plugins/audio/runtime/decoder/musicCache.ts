// The decoder worker's encoded cache for music (ADR 0166 R16; api-and-models §4.6; architecture §4.2; contract C8).
//
// Owners (M4 waves plan, H3): **D1a** wrote this skeleton and the calls into it from `musicGroups.ts`'s open path;
// **D1c** (W3) fills it (leaf L-D1ca: refcount by path, the per-preset budget, eviction of non-candidates; pure, no wasm).
//
// What it holds: the encoded bytes of every file a music instance opened a member stream over, so a re-prime of the
// same segment moves nothing through main. `musicGroups.ts` calls:
// - `lookup(instance, path)` for a member that came without `bytes`: the held bytes, or null (a miss: Q0's rule, the
//   worker answers `needBytes` and main resends the member with `bytes`; the worker never fetches);
// - `hold(instance, path, bytes?)` once a member stream opened over `path` (`bytes` when main sent them, to keep);
// - `release(instance, path)` when that member stream closed (cancel, main's `streamClose` at the voice's end);
// - `protect(instance, paths)` with each `primeGroup.protect` and each `protectMusic`;
// - `releaseInstance(instance)` on `releaseMusic` (the instance ended: drop its references);
// - `setBudget(bytes)` with each `primeGroup.budgetBytes`.
//
// The rules D1c fills (C8, architecture §4.2):
// - refcounted by path for the instance's lifetime: an open member stream is a reference; a path whose references all
//   closed is "closed" and stays held until the instance is released or the budget evicts it;
// - protected paths (playing, primed, candidate successors; `protect`) are never evicted;
// - above the budget, unprotected closed paths go, least recently closed first; if protected files alone exceed the
//   budget nothing protected goes and `warn` fires once per instance (`encodedOverBudget`).
//
// The wasm copies a file into its own memory when a stream opens over it (`DecoderWasm.open`), so the buffers kept here
// are never transferred or detached by an open.
import { MUSIC_ENCODED_BUDGET_MIB } from "./protocol";

/** The default preset's budget, bytes, until main sends one (`primeGroup.budgetBytes`). */
export const DEFAULT_MUSIC_BUDGET_BYTES = MUSIC_ENCODED_BUDGET_MIB.default * 1024 * 1024;

export interface MusicCacheOptions {
  /** The budget in bytes; default `DEFAULT_MUSIC_BUDGET_BYTES`. */
  readonly budgetBytes?: number;
  /** Called once per instance whose protected files alone exceed the budget (`encodedOverBudget`). */
  readonly warn?: (instance: number, message: string) => void;
}

/** One held file: its bytes, the open member streams over it, and its close order once it has none. */
interface HeldFile {
  bytes: ArrayBuffer;
  /** Open member streams over the path; zero means closed. */
  refs: number;
  /** The close counter's value when the last reference dropped; null while open. */
  closedAt: number | null;
}

/** The worker's music encoded cache (see the header). One per worker. */
export class MusicCache {
  /** Held files per instance, keyed by path. */
  private readonly held = new Map<number, Map<string, HeldFile>>();
  /** Each instance's protected paths (replaced by `protect`). */
  private readonly protectedPaths = new Map<number, ReadonlySet<string>>();
  /** Instances already warned as over budget (cleared when the instance is released). */
  private readonly warned = new Set<number>();
  private closeCounter = 0;
  private budget: number;

  constructor(readonly options: MusicCacheOptions = {}) {
    this.budget = options.budgetBytes ?? DEFAULT_MUSIC_BUDGET_BYTES;
  }

  /** The bytes held for `path` in `instance`, or null (a miss). Lookup does not change eviction order. */
  lookup(instance: number, path: string): ArrayBuffer | null {
    return this.held.get(instance)?.get(path)?.bytes ?? null;
  }

  /** A member stream of `instance` opened over `path`: one more reference; `bytes` (main sent them) are kept. */
  hold(instance: number, path: string, bytes?: ArrayBuffer): void {
    let paths = this.held.get(instance);
    const file = paths?.get(path);
    if (file) {
      file.refs += 1;
      file.closedAt = null;
      if (bytes) file.bytes = bytes;
    } else {
      if (!bytes) return; // a path not held keeps nothing without bytes: the caller sends them
      if (!paths) this.held.set(instance, (paths = new Map()));
      paths.set(path, { bytes, refs: 1, closedAt: null });
    }
    this.enforce();
  }

  /** A member stream of `instance` over `path` closed: one reference less (the bytes stay until evicted or released). */
  release(instance: number, path: string): void {
    const file = this.held.get(instance)?.get(path);
    if (!file || file.refs === 0) return;
    file.refs -= 1;
    if (file.refs === 0) file.closedAt = ++this.closeCounter;
    this.enforce();
  }

  /** Replace `instance`'s protected paths (never evicted). */
  protect(instance: number, paths: readonly string[]): void {
    this.protectedPaths.set(instance, new Set(paths));
    this.enforce();
  }

  /** The instance ended: forget its references and bytes (another instance's references to the same file stay). */
  releaseInstance(instance: number): void {
    this.held.delete(instance);
    this.protectedPaths.delete(instance);
    this.warned.delete(instance);
  }

  /** A new budget in bytes (the preset's, from `primeGroup.budgetBytes`); may evict at once. */
  setBudget(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.budget = bytes;
    this.enforce();
  }

  /** Bytes held now (for tests and the over-budget check). */
  get bytesHeld(): number {
    let n = 0;
    for (const paths of this.held.values()) for (const f of paths.values()) n += f.bytes.byteLength;
    return n;
  }

  /** Evicts unprotected closed files, least recently closed first, while over budget; then warns if still over. */
  private enforce(): void {
    if (this.bytesHeld > this.budget) {
      const candidates: [number, string, HeldFile][] = [];
      for (const [instance, paths] of this.held) {
        const protectedSet = this.protectedPaths.get(instance);
        for (const [path, file] of paths) {
          if (file.refs === 0 && !protectedSet?.has(path)) candidates.push([instance, path, file]);
        }
      }
      candidates.sort((a, b) => (a[2].closedAt ?? 0) - (b[2].closedAt ?? 0));
      let total = this.bytesHeld;
      for (const [instance, path, file] of candidates) {
        if (total <= this.budget) break;
        this.held.get(instance)?.delete(path);
        total -= file.bytes.byteLength;
      }
      for (const [instance, paths] of this.held) if (paths.size === 0) this.held.delete(instance);
    }
    if (this.bytesHeld > this.budget) this.warnOverBudget();
  }

  /** Warns once per instance that holds files which cannot be evicted (protected or open) while over budget. */
  private warnOverBudget(): void {
    const warn = this.options.warn;
    for (const [instance, paths] of this.held) {
      if (this.warned.has(instance)) continue;
      const protectedSet = this.protectedPaths.get(instance);
      const pinned = [...paths].some(([path, file]) => file.refs > 0 || protectedSet?.has(path));
      if (!pinned) continue;
      this.warned.add(instance);
      warn?.(
        instance,
        `protected or open music files (${this.bytesHeld} bytes held in all) exceed the ${this.budget}-byte encoded budget`,
      );
    }
  }

  /** The budget in bytes. */
  get budgetBytes(): number {
    return this.budget;
  }
}
