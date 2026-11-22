// An element's content width, followed with a ResizeObserver (0 until laid out). For the timeline components. The
// element may appear later (a view that first draws a placeholder): each render checks it is the one observed.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export function useElementWidth(ref: { readonly current: Element | null }): number {
  const [width, setWidth] = useState(0);
  const watched = useRef<{ el: Element; ro: ResizeObserver | null } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (watched.current?.el === el) return;
    watched.current?.ro?.disconnect();
    watched.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro?.observe(el);
    watched.current = { el, ro };
  });
  useLayoutEffect(() => () => watched.current?.ro?.disconnect(), []);
  return width;
}
