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

/** The worker's music encoded cache (see the header). One per worker. */
export class MusicCache {
  /** STUB(L-D1ca): the skeleton keeps bytes per instance and path with no refcount, budget or eviction. */
  private readonly held = new Map<number, Map<string, ArrayBuffer>>();
  private budget: number;

  constructor(readonly options: MusicCacheOptions = {}) {
    this.budget = options.budgetBytes ?? DEFAULT_MUSIC_BUDGET_BYTES;
  }

  /** The bytes held for `path` in `instance`, or null (a miss). */
  lookup(instance: number, path: string): ArrayBuffer | null {
    return this.held.get(instance)?.get(path) ?? null; // STUB(L-D1ca): touch for eviction order
  }

  /** A member stream of `instance` opened over `path`: one more reference; `bytes` (main sent them) are kept. */
  hold(instance: number, path: string, bytes?: ArrayBuffer): void {
    if (!bytes) return; // STUB(L-D1ca): count the reference
    let paths = this.held.get(instance);
    if (!paths) this.held.set(instance, (paths = new Map()));
    paths.set(path, bytes); // STUB(L-D1ca): refcount, budget, evict
  }

  /** A member stream of `instance` over `path` closed: one reference less (the bytes stay until evicted or released). */
  release(instance: number, path: string): void {
    void instance;
    void path;
    // STUB(L-D1ca): drop a reference; at zero the path is closed (eviction order: least recently closed first)
  }

  /** Replace `instance`'s protected paths (never evicted). */
  protect(instance: number, paths: readonly string[]): void {
    void instance;
    void paths;
    // STUB(L-D1ca)
  }

  /** The instance ended: forget its references and bytes (another instance's references to the same file stay). */
  releaseInstance(instance: number): void {
    this.held.delete(instance); // STUB(L-D1ca)
  }

  /** A new budget in bytes (the preset's, from `primeGroup.budgetBytes`); may evict at once. */
  setBudget(bytes: number): void {
    if (Number.isFinite(bytes) && bytes >= 0) this.budget = bytes; // STUB(L-D1ca): evict down to it
  }

  /** Bytes held now (for tests and the over-budget check). */
  get bytesHeld(): number {
    let n = 0;
    for (const paths of this.held.values()) for (const b of paths.values()) n += b.byteLength;
    return n;
  }

  /** The budget in bytes. */
  get budgetBytes(): number {
    return this.budget;
  }
}
