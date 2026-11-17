import sharp from "sharp";
import type { Locator, Page } from "@playwright/test";

// What a view draws, read from captures as a user would see it: a screenshot of the view's pixels, how many of them
// changed since an earlier one, and how many moved towards a colour. Debug drawing (the navigation overlay) is
// checked by toggling it and comparing; its colours are the theme's tokens, read from the page's CSS.

type Rgb = [number, number, number];

/** A capture of `view`: its pixels as raw RGB(A) bytes. */
export interface ViewCapture {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

export async function captureView(view: Locator): Promise<ViewCapture> {
  return decode(await view.screenshot());
}

/** A capture of an area of the page (CSS pixels), such as where an element was before it went away. */
export async function captureArea(page: Page, area: { x: number; y: number; width: number; height: number }): Promise<ViewCapture> {
  return decode(await page.screenshot({ clip: area }));
}

/** Wait until two captures of `view` in a row barely differ (the view has loaded and stopped changing), and return the last. */
export async function steadyView(view: Locator, { tolerance = 30, timeout = 30_000 } = {}): Promise<ViewCapture> {
  const until = Date.now() + timeout;
  let last = await captureView(view);
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const next = await captureView(view);
    if (pixelsChanged(last, next) <= tolerance) return next;
    if (Date.now() > until) throw new Error("the view kept changing");
    last = next;
  }
}

async function decode(png: Buffer): Promise<ViewCapture> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const sameSize = (a: ViewCapture, b: ViewCapture) => a.width === b.width && a.height === b.height && a.channels === b.channels;

/** How many pixels differ between two captures of the same view by more than `tolerance` in some channel. */
export function pixelsChanged(a: ViewCapture, b: ViewCapture, tolerance = 24): number {
  if (!sameSize(a, b)) return a.width * a.height;
  let n = 0;
  for (let i = 0; i < a.data.length; i += a.channels) {
    if (Math.abs(a.data[i] - b.data[i]) > tolerance || Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance || Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance) n++;
  }
  return n;
}

/**
 * How many pixels of a capture are within `within` (RGB distance) of `color`: how much is drawn in that colour, even
 * while the rest of the view moves. Antialiased or blended lines never quite reach the colour, so it isn't matched exactly.
 */
export function pixelsNear(capture: ViewCapture, color: Rgb, within = 60): number {
  const d = capture.data;
  let n = 0;
  for (let i = 0; i < d.length; i += capture.channels) if (Math.hypot(d[i] - color[0], d[i + 1] - color[1], d[i + 2] - color[2]) < within) n++;
  return n;
}

/** A theme token's colour (`--success` → its #rrggbb value from the editor's stylesheet). */
export async function themeColor(page: Page, token: string): Promise<Rgb> {
  const value = await page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) throw new Error(`${token} is "${value}", not a #rrggbb colour`);
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
