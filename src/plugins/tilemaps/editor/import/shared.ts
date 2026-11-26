/**
 * Small helpers the Tiled and LDtk parsers share (ADR 0422): resolving the paths a file names, colours in CSS order,
 * and a grid image's tile rectangles.
 */

import type { ImportRect } from "./model";

/** The folder part of a `/`-separated path ("" for a bare file name). */
export function dirOf(path: string): string {
  const i = path.replace(/\\/g, "/").lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** A path's file name without its extension. */
export function baseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * `rel` as named inside the file at `from`, resolved to the same space as `from`: `.` and `..` segments folded,
 * backslashes made `/`. An absolute `rel` (leading `/` or a drive letter) is returned normalised but unresolved.
 */
export function resolvePath(from: string, rel: string): string {
  const r = rel.replace(/\\/g, "/");
  const absolute = r.startsWith("/") || /^[A-Za-z]:\//.test(r);
  const joined = absolute ? r : dirOf(from) ? `${dirOf(from).replace(/\\/g, "/")}/${r}` : r;
  const lead = joined.startsWith("/") ? "/" : "";
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (seg === ".." && lead) continue;
    else out.push(seg);
  }
  return lead + out.join("/");
}

/**
 * A colour as `"#rrggbb"`, or `"#rrggbbaa"` when not opaque, from Tiled's `#rrggbb` / `#aarrggbb` (with or without the
 * `#`) or LDtk's `#rrggbb`. Null for anything else (including Tiled's empty colour).
 */
export function cssColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 8) {
    const a = hex.slice(0, 2);
    return a === "ff" ? `#${hex.slice(2)}` : `#${hex.slice(2)}${a}`;
  }
  return null;
}

/** Tile `index`'s rectangle in a grid image, row by row from the top-left, honouring margin and spacing. */
export function gridTileRect(index: number, columns: number, tileWidth: number, tileHeight: number, margin: number, spacing: number): ImportRect {
  const cols = Math.max(1, columns);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: margin + col * (tileWidth + spacing), y: margin + row * (tileHeight + spacing), w: tileWidth, h: tileHeight };
}
