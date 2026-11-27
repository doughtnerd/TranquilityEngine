// "Why it played" as a flow chart (spec §4.6.5; the prototype's .wg/.wn/.wge/.wgz, workflows P5 and P6): typed nodes
// (GAME, PLAYLIST · SW…, SAMPLE, BUS) with a warning or error state, joined by arrows, in a row when there is room or a
// column when not, on a dot grid you can pan (drag, the wheel, the arrow keys) and zoom (Ctrl+wheel at the pointer, + and
// −, 1 for 100%, 0 to fit, the toolbar). It fits itself to a new voice and to a resize until you pan or zoom. A node
// whose asset has a screen is a link to it; a node's detail (the game step's trigger and source, ADR 0435) is its tooltip. A view over props (`whyGraphModel.ts` has the geometry).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ScreenId } from "../../shell/screens";
import { Icon } from "../../components/Icon";
import { useElementSize } from "../../components/useElementSize";
import type { WhyStep } from "./whyModel";
import { chooseLayout, contentSize, fitView, LINK, MIN_ZOOM, NODE_H, NODE_W, OPEN_MIN, ZOOM_STEP, zoomAt, type View } from "./whyGraphModel";

export interface WhyGraphProps {
  readonly steps: readonly WhyStep[];
  /** Changes when another voice is shown (the chart fits itself again). */
  readonly id: string;
  /** The chart's accessible name. */
  readonly label: string;
  onOpen?(screen: ScreenId, target: string): void;
}

const SCREEN_WORD: Partial<Record<ScreenId, string>> = { playlists: "Playlists", samples: "Samples", mixer: "the Mixer" };

export function WhyGraph(props: WhyGraphProps) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box);
  const n = props.steps.length;
  const layout = chooseLayout(n, { w: size.width, h: size.height });
  const content = contentSize(n, layout);
  const [view, setView] = useState<View>({ scale: 1, x: 16, y: 16 });
  const moved = useRef(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; far: boolean } | null>(null);
  const suppress = useRef(false);

  const fit = (min = OPEN_MIN) => setView(fitView({ w: size.width, h: size.height }, content, min));
  useEffect(() => {
    moved.current = false;
  }, [props.id]);
  useLayoutEffect(() => {
    if (!moved.current && size.width > 0) fit();
  }, [props.id, size.width, size.height, layout, n]);

  const user = (v: View) => {
    moved.current = true;
    setView(v);
  };
  const centre = () => ({ x: size.width / 2, y: size.height / 2 });
  const zoomBy = (f: number) => user(zoomAt(view, f, centre().x, centre().y));

  return (
    <div class="pf-wg-wrap">
      <div
        ref={box}
        class={`pf-wg${drag.current?.far ? " panning" : ""}`}
        role="group"
        tabIndex={0}
        aria-label={`${props.label}. Drag or arrow keys to pan, Ctrl+scroll or plus and minus to zoom, 0 to fit`}
        title="Drag to pan · scroll to pan · Ctrl+scroll to zoom · 0 fits · 1 is 100%"
        style={{ backgroundSize: `${14 * view.scale}px ${14 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, far: false };
          suppress.current = false;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.far && Math.hypot(dx, dy) < 4) return;
          d.far = true;
          suppress.current = true;
          user({ ...view, x: d.vx + dx, y: d.vy + dy });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onWheel={(e) => {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          if (e.ctrlKey || e.metaKey) user(zoomAt(view, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX - r.left, e.clientY - r.top));
          else if (e.shiftKey) user({ ...view, x: view.x - (e.deltaX || e.deltaY) });
          else user({ ...view, x: view.x - e.deltaX, y: view.y - e.deltaY });
        }}
        onKeyDown={(e) => {
          const pan: Record<string, [number, number]> = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] };
          if (pan[e.key]) {
            e.preventDefault();
            user({ ...view, x: view.x + pan[e.key]![0], y: view.y + pan[e.key]![1] });
          } else if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            zoomBy(ZOOM_STEP);
          } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            zoomBy(1 / ZOOM_STEP);
          } else if (e.key === "0") {
            e.preventDefault();
            moved.current = true;
            fit(MIN_ZOOM);
          } else if (e.key === "1") {
            e.preventDefault();
            user({ scale: 1, x: view.x, y: view.y });
          }
        }}
      >
        <ol
          class={`pf-wg-chart ${layout}`}
          aria-label={props.label}
          style={{ width: `${content.w}px`, height: `${content.h}px`, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {props.steps.map((s, i) => {
            const link = s.screen && s.target && props.onOpen;
            const body = (
              <>
                <span class="pf-wn-kind">{s.label}</span>
                <span class="pf-wn-name">{s.name}</span>
                {s.why && <span class="pf-wn-why">{s.why}</span>}
                {s.detail && <span class="kit-sr-only">{s.detail}</span>}
              </>
            );
            return (
              <li key={i} class="pf-wn-item" style={{ width: `${NODE_W}px`, height: `${NODE_H}px`, margin: i === 0 ? 0 : layout === "row" ? `0 0 0 ${LINK}px` : `${LINK}px 0 0 0` }}>
                {i > 0 && <span class="pf-wge" aria-hidden="true" />}
                {link ? (
                  <button
                    type="button"
                    class={`pf-wn link${s.severity === "warning" ? " bad" : s.severity === "error" ? " err" : ""}`}
                    data-kind={s.kind}
                    title={`Open this ${s.kind === "playlist" ? "playlist" : s.kind} in ${SCREEN_WORD[s.screen!] ?? s.screen}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      if (!suppress.current) props.onOpen!(s.screen!, s.target!);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div class={`pf-wn${s.severity === "warning" ? " bad" : s.severity === "error" ? " err" : ""}`} data-kind={s.kind} title={s.detail ?? (s.kind === "game" ? "Game trigger" : undefined)}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <div class="pf-wgz" role="toolbar" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Icon name="minus" size={14} />
          </button>
          <button type="button" class="pf-wgz-pct" title="Reset to 100% (1)" onClick={() => user({ scale: 1, x: view.x, y: view.y })}>
            {Math.round(view.scale * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(ZOOM_STEP)}>
            <Icon name="plus" size={14} />
          </button>
          <button
            type="button"
            aria-label="Fit to view"
            title="Fit to view (0)"
            onClick={() => {
              moved.current = true;
              fit(MIN_ZOOM);
            }}
          >
            <Icon name="fit" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
