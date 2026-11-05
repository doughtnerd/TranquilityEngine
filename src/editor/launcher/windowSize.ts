export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** Logical pixels left free around the window inside the work area (shadow, a margin from the taskbar and screen edges). */
export const WORK_AREA_MARGIN = 16;
/** The smallest height the window shrinks to on a tiny screen. */
const MIN_HEIGHT = 200;

/**
 * The Projects window's size for its content: the content's size, with the height capped to
 * `maxHeight` (logical px). When capped, the page scrolls, so the width grows by the scrollbar's so
 * the scrollbar never covers the card (or its Close button).
 */
export function windowSizeFor(content: Size, maxHeight: number, scrollbarWidth = 0): Size {
  const cap = Math.floor(Math.max(MIN_HEIGHT, maxHeight));
  const height = Math.ceil(content.height);
  const scrolls = height > cap;
  return { width: Math.ceil(content.width) + (scrolls ? Math.ceil(scrollbarWidth) : 0), height: Math.min(height, cap) };
}

/**
 * Sizes and places the window on the monitor it is on. `workArea` is that monitor's usable area in
 * physical pixels (the screen minus the taskbar or dock), `scale` its scale factor. The content's
 * size is kept where it fits and capped to the work area (less a margin) where it doesn't, in which
 * case the page scrolls. The result's `size` is in logical pixels and `position` (the window's
 * top-left) in physical pixels. With no `current` position the window is centred in the work area;
 * with one it stays where the user put it, nudged only as far as needed to lie inside the work area.
 */
export function fitWindowToWorkArea(
  content: Size,
  workArea: Rect,
  scale: number,
  scrollbarWidth = 0,
  current?: Point,
): { size: Size; position: Point } {
  const s = scale > 0 ? scale : 1;
  const maxWidth = Math.floor(Math.max(1, workArea.width / s - WORK_AREA_MARGIN));
  const maxHeight = Math.floor(Math.max(1, workArea.height / s - WORK_AREA_MARGIN));
  const sized = windowSizeFor(content, maxHeight, scrollbarWidth);
  // windowSizeFor keeps a usable minimum height; the work area still wins on a tiny screen.
  const size = { width: Math.min(sized.width, maxWidth), height: Math.min(sized.height, maxHeight) };
  const physical = { width: Math.round(size.width * s), height: Math.round(size.height * s) };
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const position = current
    ? {
        x: clamp(current.x, workArea.x, workArea.x + workArea.width - physical.width),
        y: clamp(current.y, workArea.y, workArea.y + workArea.height - physical.height),
      }
    : {
        x: Math.round(workArea.x + (workArea.width - physical.width) / 2),
        y: Math.round(workArea.y + (workArea.height - physical.height) / 2),
      };
  return { size, position };
}

/** The width of a classic (space-taking) scrollbar in this page: 0 for overlay scrollbars. */
export function measureScrollbar(doc: Document): number {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll";
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}
