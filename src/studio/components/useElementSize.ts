// An element's content box (width and height), followed with a ResizeObserver ({0, 0} until laid out): for components
// that draw to their size, such as the waveform's canvas, which must redraw when only its height changes. The element
// may appear later (a view that first draws a placeholder): each render checks it is the one observed.
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export function useElementSize(ref: { readonly current: Element | null }): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const watched = useRef<{ el: Element; ro: ResizeObserver | null } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (watched.current?.el === el) return;
    watched.current?.ro?.disconnect();
    watched.current = null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const c = entries[0]?.contentRect;
            if (c) setSize((s) => (s.width === c.width && s.height === c.height ? s : { width: c.width, height: c.height }));
          });
    ro?.observe(el);
    watched.current = { el, ro };
  });
  useLayoutEffect(() => () => watched.current?.ro?.disconnect(), []);
  return size;
}
