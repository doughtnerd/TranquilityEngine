// A1.3a-L2: the encoded-bytes cache (api-and-models section 3 "Clip registry", field `encoded`: the encoded file is
// kept, up to 32 MB in total, so a rebuild can re-decode and resend without refetching; past the cap the clip is
// simply not kept and a rebuild refetches it from the HTTP cache).

/** The default cap, 32 MB. */
export const ENCODED_CACHE_CAP_BYTES = 32 * 1024 * 1024;

/** Encoded asset bytes keyed by asset path. No eviction: an entry that doesn't fit is refused, not swapped in. */
export interface EncodedCache {
  /** Stores `bytes` under `path`. Returns false (and stores nothing, leaving any old entry for `path`) if the total would pass the cap after replacing the entry for `path`. */
  set(path: string, bytes: ArrayBuffer): boolean;
  /** The stored bytes (the same ArrayBuffer `set` was given; callers copy before `decodeAudioData`), or undefined. */
  get(path: string): ArrayBuffer | undefined;
  has(path: string): boolean;
  /** Removes `path`; returns whether it was there. */
  delete(path: string): boolean;
  /** Empties the cache. */
  clear(): void;
  /** Bytes held in total. */
  readonly bytes: number;
  /** Entries held. */
  readonly size: number;
}

export function createEncodedCache(_capBytes: number = ENCODED_CACHE_CAP_BYTES): EncodedCache {
  const entries = new Map<string, ArrayBuffer>();
  let total = 0;

  return {
    set(path: string, bytes: ArrayBuffer): boolean {
      const previous = entries.get(path);
      const newTotal = total - (previous ? previous.byteLength : 0) + bytes.byteLength;
      if (newTotal > _capBytes) return false;
      entries.set(path, bytes);
      total = newTotal;
      return true;
    },
    get(path: string): ArrayBuffer | undefined {
      return entries.get(path);
    },
    has(path: string): boolean {
      return entries.has(path);
    },
    delete(path: string): boolean {
      const previous = entries.get(path);
      if (previous === undefined) return false;
      entries.delete(path);
      total -= previous.byteLength;
      return true;
    },
    clear(): void {
      entries.clear();
      total = 0;
    },
    get bytes(): number {
      return total;
    },
    get size(): number {
      return entries.size;
    },
  };
}
