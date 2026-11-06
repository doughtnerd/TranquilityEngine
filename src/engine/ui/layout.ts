/**
 * Layout helpers for the UI core (ADR 0076): loading Yoga, reading length fields, the canvas scale,
 * and text measuring. No renderer is involved, so all of it runs in Node. Nothing here is public API.
 */
import type { Yoga } from "yoga-layout/load";
import type { UILength } from "./components";
import type { TextMeasureRequest } from "./uiCoreTypes";

let yogaPromise: Promise<Yoga> | null = null;
let yogaLoaded: Yoga | null = null;

/** Yoga, if it has loaded already (a core made after that lays out from its first sync). */
export function loadedYoga(): Yoga | null {
  return yogaLoaded;
}

/**
 * Load Yoga's WebAssembly once. `yoga-layout/load` is the async entry (the default entry uses top-level
 * await, which not every bundle target allows); the module is only fetched when the first UI needs it.
 */
export function loadYogaOnce(): Promise<Yoga> {
  yogaPromise ??= import("yoga-layout/load")
    .then((m) => m.loadYoga())
    .then((yoga) => (yogaLoaded = yoga));
  return yogaPromise;
}

/**
 * Canvas CSS pixels per UI pixel for a screen canvas, like Unity's Canvas Scaler in "scale with
 * screen size" mode: the width and height ratios blended in log space by `matchHeight` (0: width).
 */
export function canvasScale(canvasWidth: number, canvasHeight: number, refWidth: number, refHeight: number, matchHeight: number): number {
  if (!(canvasWidth > 0 && canvasHeight > 0 && refWidth > 0 && refHeight > 0)) return 1;
  const m = Math.min(Math.max(matchHeight, 0), 1);
  const lw = Math.log2(canvasWidth / refWidth), lh = Math.log2(canvasHeight / refHeight);
  return 2 ** (lw + (lh - lw) * m);
}

/** A length field as Yoga takes it: pixels, a percentage, `"auto"`, or undefined when empty or unreadable. */
export function uiLength(v: UILength | null | undefined): number | `${number}%` | "auto" | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (s === "auto") return "auto";
  if (/^-?\d+(\.\d+)?%$/.test(s)) return s as `${number}%`;
  const px = s.replace(/px$/, "");
  const n = Number(px);
  return px !== "" && Number.isFinite(n) ? n : undefined;
}

/** CSS font weight for a `fontWeight` field value. */
export function cssFontWeight(w: string): string {
  switch (w) {
    case "light": return "300";
    case "normal": return "400";
    case "medium": return "500";
    case "semi-bold": return "600";
    case "bold": return "700";
    default: return /^[1-9]00$/.test(w) ? w : "400";
  }
}

export { UI_FONT_FAMILY } from "./fonts";
export const UI_LINE_HEIGHT = 1.2;

/** The Node fallback: 0.55 em per character, greedy wrapping at spaces (a longer word overflows). */
export function estimateText(req: TextMeasureRequest): { width: number; height: number } {
  const charW = 0.55 * req.fontSize;
  const lineH = req.fontSize * req.lineHeight;
  let lines = 0, widest = 0;
  for (const paragraph of req.text.split("\n")) {
    const words = paragraph.split(" ");
    let current = 0, any = false;
    for (const word of words) {
      const w = word.length * charW;
      if (!any) {
        current = w;
        any = true;
      } else if (current + charW + w <= req.maxWidth) current += charW + w;
      else {
        widest = Math.max(widest, current);
        lines++;
        current = w;
      }
    }
    widest = Math.max(widest, current);
    lines++;
  }
  return { width: widest, height: lines * lineH };
}
