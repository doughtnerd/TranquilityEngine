/**
 * Hashes the clip compile pipeline names things by (T19): a SHA-256 content key over length-prefixed parts (as the
 * thumbnail cache's, ADR 0061), and FNV-1a for short, stable names. Generic and pure. Internal: not public API.
 */

const enc = new TextEncoder();

/**
 * @internal The first `hexChars` hex characters of a SHA-256 over `parts`, each prefixed with its length (big-endian
 * u32), so `["ab", "c"]` and `["a", "bc"]` differ. WebCrypto, so it runs in pages, workers and Node alike.
 */
export async function contentHash(parts: readonly (Uint8Array | string)[], hexChars = 20): Promise<string> {
  const bytes = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  let total = 0;
  for (const p of bytes) total += 4 + p.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let at = 0;
  for (const p of bytes) {
    view.setUint32(at, p.length);
    buf.set(p, at + 4);
    at += 4 + p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, hexChars);
}

/** @internal FNV-1a (32 bits) over bytes, or a string's UTF-8 bytes, as eight hex digits. */
export function fnv1aHex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
