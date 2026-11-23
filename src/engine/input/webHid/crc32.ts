/**
 * CRC-32 as zlib computes it (IEEE 802.3, reflected polynomial 0xEDB88320). Pass a previous
 * result as `crc` to continue a checksum over several pieces.
 */

let table: Uint32Array | null = null;

function makeTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

export function crc32(bytes: ArrayLike<number>, crc = 0): number {
  const t = (table ??= makeTable());
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
