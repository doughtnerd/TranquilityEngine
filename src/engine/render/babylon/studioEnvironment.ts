/**
 * The default environment a World without an Environment map reflects (ADR 0043, 0075): a soft
 * studio room, so metals and glossy surfaces don't draw black. It's made here as a small Radiance
 * `.hdr` image in memory (a grey room, brighter overhead, with a few soft box lights) and loaded
 * like a project's HDR map, so it's prefiltered the same way. No file or network request.
 */

/** Radiance at a direction (x, y, z unit vector, +Y up): the room's walls, ceiling glow and soft boxes. */
function studio(x: number, y: number, z: number): [number, number, number] {
  const up = Math.max(0, y);
  let v = 0.18 + 0.32 * up * up + 0.06 * Math.max(0, -y); // walls, a brighter ceiling, a faint floor bounce
  // Soft boxes: a key light above-front-right, a fill to the left and a rim behind.
  const boxes: [number, number, number, number, number][] = [
    [0.5, 0.75, 0.43, 6, 0.08],
    [-0.8, 0.35, 0.5, 2.5, 0.12],
    [0.1, 0.5, -0.86, 3, 0.1],
  ];
  for (const [bx, by, bz, power, width] of boxes) {
    const len = Math.hypot(bx, by, bz);
    const d = 1 - (x * bx + y * by + z * bz) / len; // 0 at the box's centre
    v += power * Math.exp(-d / width);
  }
  return [v, v, v * 0.97];
}

/** Encode linear RGB as RGBE (Radiance's shared-exponent format). */
function rgbe(r: number, g: number, b: number, out: Uint8Array, at: number): void {
  const max = Math.max(r, g, b);
  if (max < 1e-32) {
    out[at] = out[at + 1] = out[at + 2] = out[at + 3] = 0;
    return;
  }
  const e = Math.ceil(Math.log2(max) + 1e-9);
  const scale = 256 / Math.pow(2, e);
  out[at] = Math.min(255, Math.floor(r * scale));
  out[at + 1] = Math.min(255, Math.floor(g * scale));
  out[at + 2] = Math.min(255, Math.floor(b * scale));
  out[at + 3] = e + 128;
}

/** @internal The studio room as a Radiance `.hdr` file (equirectangular, `width` × `width / 2`). */
export function studioHdr(width = 256): Uint8Array {
  const height = width / 2;
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const out = new Uint8Array(header.length + width * height * 4);
  out.set(header);
  let at = header.length;
  for (let row = 0; row < height; row++) {
    const theta = ((row + 0.5) / height) * Math.PI; // 0 at the top
    const y = Math.cos(theta), r = Math.sin(theta);
    for (let col = 0; col < width; col++) {
      const phi = ((col + 0.5) / width) * Math.PI * 2;
      const [cr, cg, cb] = studio(r * Math.sin(phi), y, -r * Math.cos(phi));
      rgbe(cr, cg, cb, out, at);
      at += 4;
    }
  }
  return out;
}

let url: string | null = null;

/** @internal A blob URL for the studio room's `.hdr` file, made once per page. */
export function studioHdrUrl(): string {
  url ??= URL.createObjectURL(new Blob([studioHdr() as BlobPart], { type: "image/vnd.radiance" }));
  return url;
}
