/**
 * `.cube` colour lookup tables (Adobe / DaVinci Resolve 3D LUTs) for LUT colour grading
 * (ADR 0051). Pure: parsing and layout only, no renderer types.
 *
 * Layout of a 3D table of `size` entries per axis, as a 2D strip ({@link lutStripRGBA8}): `size`
 * slices (one per blue value) side by side, so width = size * size and height = size. Entry
 * (r, g, b) sits at pixel x = r + b * size, y = g. A shader samples it as:
 *
 *   slice = b * (size - 1)                       // two neighbouring slices, floor and ceil, blended by fract
 *   u = (r * (size - 1) + 0.5 + slice * size) / (size * size)
 *   v = (g * (size - 1) + 0.5) / size
 *
 * with r, g, b in 0..1 (already normalised through the LUT's domain).
 */

export interface CubeLut {
  /** Entries per axis (2..256). */
  size: number;
  /** size³ RGB triples, red changing fastest, normalised into 0..1 through the domain. */
  data: Float32Array;
  title: string;
  /** The file's DOMAIN_MIN (default 0,0,0); `data` is already normalised, kept for reference. */
  domainMin: [number, number, number];
  /** The file's DOMAIN_MAX (default 1,1,1). */
  domainMax: [number, number, number];
  /** Non-fatal oddities (unknown keywords, empty domain...). */
  problems: string[];
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function triple(parts: string[], line: number, what: string, where: string): [number, number, number] {
  if (parts.length !== 3 || !parts.every((p) => NUM.test(p))) throw new Error(`${where}: line ${line}: ${what} needs three numbers.`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Parse the text of a `.cube` file. Throws an Error prefixed with `where` for unsupported or malformed files. */
export function parseCubeLut(text: string, where = "LUT"): CubeLut {
  const problems: string[] = [];
  let size = 0;
  let title = "";
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    let line = lines[i];
    const titleMatch = /^\s*TITLE\s+(.*)$/.exec(line);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^"(.*)"$/, "$1");
      continue;
    }
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];
    if (key === "LUT_1D_SIZE") throw new Error(`${where}: 1D LUTs (LUT_1D_SIZE) aren't supported; use a 3D LUT (LUT_3D_SIZE).`);
    if (key === "LUT_3D_SIZE") {
      const s = Number(parts[1]);
      if (parts.length !== 2 || !Number.isInteger(s) || s < 2 || s > 256) throw new Error(`${where}: line ${n}: LUT_3D_SIZE must be an integer from 2 to 256.`);
      size = s;
    } else if (key === "DOMAIN_MIN") domainMin = triple(parts.slice(1), n, "DOMAIN_MIN", where);
    else if (key === "DOMAIN_MAX") domainMax = triple(parts.slice(1), n, "DOMAIN_MAX", where);
    else if (/^[A-Z_]+\d*$/.test(key) && !NUM.test(key)) problems.push(`${where}: line ${n}: unknown keyword ${key} ignored.`);
    else {
      const t = triple(parts, n, "a data row", where);
      values.push(t[0], t[1], t[2]);
    }
  }
  if (!size) throw new Error(`${where}: missing LUT_3D_SIZE.`);
  const expected = size * size * size;
  if (values.length !== expected * 3) throw new Error(`${where}: expected ${expected} entries for size ${size}, found ${values.length / 3}.`);
  const data = new Float32Array(values);
  const same = domainMin.every((v, c) => v === 0 && domainMax[c] === 1);
  if (!same) {
    for (let c = 0; c < 3; c++) {
      const span = domainMax[c] - domainMin[c];
      if (!(span > 0)) {
        problems.push(`${where}: DOMAIN_MAX must exceed DOMAIN_MIN; the domain was ignored.`);
        domainMin = [0, 0, 0];
        domainMax = [1, 1, 1];
        break;
      }
    }
    if (domainMin.some((v) => v !== 0) || domainMax.some((v) => v !== 1)) {
      for (let i = 0; i < data.length; i++) data[i] = (data[i] - domainMin[i % 3]) / (domainMax[i % 3] - domainMin[i % 3]);
    }
  }
  return { size, data, title, domainMin, domainMax, problems };
}

/** The 3D table as a 2D RGBA8 strip (see the layout above); values clamped to 0..1 and rounded, alpha 255. */
export function lutStripRGBA8(lut: Pick<CubeLut, "size" | "data">): { width: number; height: number; pixels: Uint8Array } {
  const { size, data } = lut;
  const pixels = new Uint8Array(size * size * size * 4);
  const { width, height } = { width: size * size, height: size };
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const src = (r + size * (g + size * b)) * 3;
        const dst = (g * width + r + b * size) * 4;
        for (let c = 0; c < 3; c++) pixels[dst + c] = Math.round(Math.min(1, Math.max(0, data[src + c])) * 255);
        pixels[dst + 3] = 255;
      }
  return { width, height, pixels };
}

/** The same strip as Float32 RGBA (unclamped, alpha 1). */
export function lutStripRGBAFloat(lut: Pick<CubeLut, "size" | "data">): { width: number; height: number; pixels: Float32Array } {
  const { size, data } = lut;
  const width = size * size;
  const pixels = new Float32Array(size * size * size * 4);
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const src = (r + size * (g + size * b)) * 3;
        const dst = (g * width + r + b * size) * 4;
        pixels[dst] = data[src];
        pixels[dst + 1] = data[src + 1];
        pixels[dst + 2] = data[src + 2];
        pixels[dst + 3] = 1;
      }
  return { width, height: size, pixels };
}

/** A neutral LUT: every colour maps to itself. */
export function identityLut(size = 2): CubeLut {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        data[i++] = r / (size - 1);
        data[i++] = g / (size - 1);
        data[i++] = b / (size - 1);
      }
  return { size, data, title: "", domainMin: [0, 0, 0], domainMax: [1, 1, 1], problems: [] };
}
