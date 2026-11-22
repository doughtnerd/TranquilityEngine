// An element's content width, followed with a ResizeObserver (0 until laid out). For the timeline components.
import { useLayoutEffect, useState } from "preact/hooks";

export function useElementWidth(ref: { readonly current: Element | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
