// "Why it played" (ADR 0349 `CausalChain`): the steps from the game's request to the bus a voice played on, as cards
// joined by arrows on a dot grid. Drag or the wheel pans, Ctrl/⌘+wheel zooms about the pointer; focused, the arrows pan,
// + and − zoom, 0 fits and 1 is 100 %; the toolbar's Zoom out, 100 %, Zoom in and Fit buttons do the same by touch
// (ADR 0361). It fits itself when the chain changes and the panel resizes (until the user pans or zooms), and stacks
// top to bottom when the panel is too narrow to read it left to right. Clicking a step's name calls `onStep` (open that
// playlist, sample or bus); the view maths are `causalChainModel.ts`'s.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { KIND_TEXT, START_VIEW, chainKey, chainText, chainWheel, fitView, panBy, shouldStack, worstSeverity, zoomAt, ZOOM_STEP, type CausalStep, type ChainView } from "./causalChainModel";
import { Icon } from "./Icon";
import "./audioParts.css";
import { EmptyState } from "../../editor/ui/EmptyState";

export interface CausalChainProps {
  readonly steps: readonly CausalStep[];
  /** What the chain explains ("land_hard_04 at 0:21.4"). */
  readonly label?: string;
  onStep?(step: CausalStep): void;
}

export function CausalChain(props: CausalChainProps) {
  const { steps } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ChainView>(START_VIEW);
  const [stack, setStack] = useState(false);
  const user = useRef(false);
  const panning = useRef<{ x: number; y: number; from: ChainView; moved: boolean } | null>(null);

  const fit = (full: boolean) => {
    const vp = viewport.current, c = content.current;
    if (!vp || !c) return;
    setView(fitView({ width: vp.clientWidth, height: vp.clientHeight }, { width: c.offsetWidth, height: c.offsetHeight }, full));
  };
  const center = () => ({ x: (viewport.current?.clientWidth ?? 0) / 2, y: (viewport.current?.clientHeight ?? 0) / 2 });
  const userView = (v: ChainView) => {
    user.current = true;
    setView(v);
  };

  const shownSteps = useRef(steps);
  useLayoutEffect(() => {
    // A new chain: fit it again, whatever the user did to the last one.
    if (shownSteps.current !== steps) {
      shownSteps.current = steps;
      user.current = false;
    }
    const vp = viewport.current;
    if (!vp) return;
    const check = () => {
      const s = shouldStack(steps.length, vp.clientWidth);
      if (s !== stack) setStack(s);
      else if (!user.current) fit(false);
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [steps, stack]);
  // Wheel listener: not passive, so it can stop the page scrolling.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      setView((v) => chainWheel(v, { deltaX: e.deltaX, deltaY: e.deltaY, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, x: e.clientX - r.left, y: e.clientY - r.top }));
      user.current = true;
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [steps.length === 0]);

  if (steps.length === 0) return <EmptyState compact title="Select a voice to see why it played." />;
  const worst = worstSeverity(steps);
  return (
    <div class="studio-chainview">
      <div class="studio-chainview-tools" role="toolbar" aria-label="Zoom">
        <span class={`studio-chainview-status ${worst}`} role="status">{worst !== "ok" && <Icon name="warning" size={12} />} {worst === "error" ? "Error" : worst === "warning" ? "Warning" : "Played"}</span>
        <button type="button" class="studio-icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => userView(zoomAt(view, 1 / ZOOM_STEP, center().x, center().y))}>
          <Icon name="zoomOut" size={14} />
        </button>
        <button type="button" class="studio-chainview-zoom" title="Actual size (1)" onClick={() => userView(zoomAt(view, 1 / view.s, center().x, center().y))}>
          {Math.round(view.s * 100)}%
        </button>
        <button type="button" class="studio-icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => userView(zoomAt(view, ZOOM_STEP, center().x, center().y))}>
          <Icon name="zoomIn" size={14} />
        </button>
        <button type="button" class="studio-icon-button" aria-label="Fit" title="Fit (0)" onClick={() => {
          user.current = true;
          fit(true);
        }}>
          <Icon name="fit" size={14} />
        </button>
      </div>
      <div
        ref={viewport}
        class={`studio-chainview-grid${panning.current?.moved ? " panning" : ""}`}
        tabIndex={0}
        role="group"
        aria-label={props.label ? `Why it played: ${props.label}` : "Why it played"}
        aria-description={chainText(steps)}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${14 * view.s}px ${14 * view.s}px` }}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const next = chainKey(view, e.key, center());
          if (next === null) return;
          e.preventDefault();
          if (next === "fit") {
            user.current = true;
            fit(true);
          } else userView(next);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          panning.current = { x: e.clientX, y: e.clientY, from: view, moved: false };
        }}
        onPointerMove={(e) => {
          const p = panning.current;
          if (!p) return;
          const dx = e.clientX - p.x, dy = e.clientY - p.y;
          if (!p.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          p.moved = true;
          userView(panBy(p.from, dx, dy));
        }}
        onPointerUp={() => (panning.current = null)}
        onPointerCancel={() => (panning.current = null)}
      >
        <div ref={content} class={`studio-chainview-steps${stack ? " stack" : ""}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          {steps.map((step, i) => (
            <div key={i} class="studio-chainview-cell">
              {i > 0 && (
                <span class="studio-chainview-arrow" aria-hidden="true">
                  <Icon name={stack ? "chevronDown" : "chevronRight"} size={14} />
                </span>
              )}
              <div class={`studio-chainview-step ${step.severity} kind-${step.kind}`}>
                <span class="studio-chainview-kind">
                  {KIND_TEXT[step.kind]}
                  {step.tag && <span class="studio-chainview-tag"> · {step.tag}</span>}
                </span>
                {props.onStep && step.target != null ? (
                  <button type="button" class="studio-chainview-name link" title={`Open ${step.name}`} onClick={() => props.onStep!(step)}>
                    {step.name}
                  </button>
                ) : (
                  <span class="studio-chainview-name">{step.name}</span>
                )}
                {step.why && <span class="studio-chainview-why">{step.why}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
