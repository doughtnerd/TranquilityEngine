// The scene view's occlusion debug view (ADR 0460 §6), without the DOM: the core's buffer as a grey image, culled
// groups' boxes as overlay lines, and the readout's rows. Pure: the inset (`ui/VisibilityDebugInset.tsx`) and the
// overlay (`visibilityDebug.ts`) draw what these return.
import type { EditorOverlay } from "../engine/editor";

/** An occlusion buffer as the engine gives it: 1/w per pixel (0 where nothing was drawn), row by row from the top. */
export interface DepthBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** Grey for the farthest drawn pixel; the nearest is white, empty pixels black. */
const FAR_GREY = 48;

/**
 * The buffer as RGBA bytes for an `ImageData`: empty pixels black, drawn ones grey, brighter the nearer (1/w scaled by
 * the buffer's largest), so occluders read as light shapes. Fills `out` when it is the right size.
 */
export function depthImage(depth: DepthBuffer, out?: Uint8ClampedArray): Uint8ClampedArray {
  const n = depth.width * depth.height;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  let max = 0;
  for (let i = 0; i < n; i++) if (depth.data[i] > max) max = depth.data[i];
  for (let i = 0; i < n; i++) {
    const v = depth.data[i];
    const grey = v > 0 && max > 0 ? FAR_GREY + Math.round((255 - FAR_GREY) * Math.min(1, v / max)) : 0;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = grey;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** World boxes (6 floats each: min xyz, max xyz) as overlay polylines in `color` (0xRRGGBB): bottom, top, four sides. */
export function boxLines(boxes: Float32Array, color: number): EditorOverlay["lines"] {
  const lines: EditorOverlay["lines"] = [];
  for (let o = 0; o + 6 <= boxes.length; o += 6) {
    const [x0, y0, z0, x1, y1, z1] = [boxes[o], boxes[o + 1], boxes[o + 2], boxes[o + 3], boxes[o + 4], boxes[o + 5]];
    lines.push({ points: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], closed: true, color });
    lines.push({ points: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], closed: true, color });
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) lines.push({ points: [[x, y0, z], [x, y1, z]], closed: false, color });
  }
  return lines;
}

/** One occlusion run's numbers (`VisibilityStats.occlusion`). */
export interface OcclusionNumbers {
  readonly occluders: number;
  readonly triangles: number;
  readonly tested: number;
  readonly culled: number;
  readonly ms: number;
}

/** The readout's rows: occluders and triangles rasterised, occludees tested, culled, and milliseconds. */
export function occlusionReadout(s: OcclusionNumbers): { label: string; value: string }[] {
  const int = (n: number) => Math.round(n).toLocaleString("en-US");
  return [
    { label: "Occluders", value: int(s.occluders) },
    { label: "Triangles", value: int(s.triangles) },
    { label: "Tested", value: int(s.tested) },
    { label: "Culled", value: int(s.culled) },
    { label: "Time", value: `${s.ms.toFixed(2)} ms` },
  ];
}

/** Which view the readout is about: the scene view's own run, or the main camera's (the scene view's toggle is off). */
export function readoutSource(kind: string): string {
  return kind === "sceneView" ? "Scene view" : "Main camera";
}
