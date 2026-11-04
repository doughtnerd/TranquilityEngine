/**
 * The Projects window's size for its content: the content's size, with the height capped to the
 * screen. When capped, the page scrolls, so the width grows by the scrollbar's so the scrollbar
 * never covers the card (or its Close button).
 */
export function windowSizeFor(content: { width: number; height: number }, screenHeight: number, scrollbarWidth = 0): { width: number; height: number } {
  const maxHeight = Math.floor(Math.max(200, screenHeight - 48)); // leave room for the taskbar and a margin
  const height = Math.ceil(content.height);
  const scrolls = height > maxHeight;
  return { width: Math.ceil(content.width) + (scrolls ? Math.ceil(scrollbarWidth) : 0), height: Math.min(height, maxHeight) };
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
