/**
 * Six-image cubemap assets (ADR 0113): `*.cubemap.json` names one image per cube face, for skies and
 * environment lighting from the many skyboxes sold as six PNG or JPEG files.
 *
 * ```json
 * { "format": "myco.cubemap@1", "px": "skies/right.png", "nx": "skies/left.png",
 *   "py": "skies/up.png", "ny": "skies/down.png", "pz": "skies/front.png", "nz": "skies/back.png" }
 * ```
 *
 * Faces follow the usual OpenGL naming: px/nx are +X/-X, py/ny up/down, pz/nz +Z/-Z (the World's
 * east/west, up/down and north/south; +Z is forward, ADR 0164). Paths are project asset paths (an `asset:` prefix is allowed).
 */

export const CUBEMAP_FORMAT = "myco.cubemap@1";

export const CUBE_FACES = ["px", "py", "pz", "nx", "ny", "nz"] as const;
export type CubeFace = (typeof CUBE_FACES)[number];
export type CubemapFaces = Record<CubeFace, string>;

/** True for a six-image cubemap asset path. */
export const isCubemapPath = (path: string): boolean => /\.cubemap\.json$/i.test(path.split(/[?#]/)[0]!);

/** Read a cubemap asset; throws with a readable message when a face is missing. */
export function parseCubemap(raw: unknown, path = "cubemap"): CubemapFaces {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} isn't a cubemap (expected a JSON object).`);
  const r = raw as Record<string, unknown>;
  const faces = {} as CubemapFaces;
  const missing: string[] = [];
  for (const f of CUBE_FACES) {
    const v = r[f];
    if (typeof v === "string" && v.trim()) faces[f] = v.trim().replace(/^asset:/, "");
    else missing.push(f);
  }
  if (missing.length) throw new Error(`${path} has no image for ${missing.join(", ")}.`);
  return faces;
}

/** The file text for a cubemap asset. */
export function formatCubemap(faces: CubemapFaces): string {
  return `${JSON.stringify({ format: CUBEMAP_FORMAT, ...faces }, null, 2)}\n`;
}
