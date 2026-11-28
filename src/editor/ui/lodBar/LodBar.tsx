// The LOD bar (ADR 0446 §7): a segment per level of an LODGroup, widths from its transition heights, draggable dividers
// between them. Presentational: the section (`LodGroupSection.tsx`) gives it the heights and writes what it commits.
import { useRef, useState } from "preact/hooks";
import "./lodBar.css";
import { dragDivider, fractionToHeight, layoutBar, percentLabel, segmentColor, segmentLabel } from "./lodBarLogic";

export interface LodBarProps {
  /** The heights the group draws by: its `levels`, or the automatic ones. */
  heights: readonly number[];
  /** Whether `levels` is empty, so `heights` are derived. */
  automatic: boolean;
  /** Triangles per level summed over the group's meshes (null: not known yet), index for index with `heights`. */
  triangles: readonly (number | null)[];
  /** `LODGroup.forceLevel`: -1 chooses automatically. */
  forceLevel: number;
  /** Why the heights can't be edited (play mode, a read-only project), or null. */
  readOnly: string | null;
  /** Whether there is more than one level to divide (a model without generated levels has one). */
  editable: boolean;
  /** Called once per drag (or key press) with the new heights. */
  onCommit(heights: number[]): void;
  /** Set `levels` to [] again. */
  onReset(): void;
}

const KEY_STEP = 0.01;

export function LodBar(props: LodBarProps) {
  const { automatic, forceLevel, readOnly, editable } = props;
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ index: number; heights: number[] } | null>(null);
  const heights = drag?.heights ?? props.heights;
  const layout = layoutBar(heights);
  const locked = !editable || !!readOnly;
  const why = !editable ? "Only one level: the model has no generated LODs (turn on Generate LODs in its import settings)" : readOnly;

  const heightAt = (e: PointerEvent): number => {
    const rect = bar.current!.getBoundingClientRect();
    return fractionToHeight(rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0);
  };
  const start = (index: number) => (e: PointerEvent) => {
    if (locked || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ index, heights: [...props.heights] });
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (drag) setDrag({ index: drag.index, heights: dragDivider(props.heights, drag.index, heightAt(e)) });
  };
  const end = (cancel: boolean) => () => {
    if (!drag) return;
    const next = drag.heights;
    setDrag(null);
    // A click that moved nothing writes nothing, so it doesn't turn automatic heights into explicit ones.
    if (!cancel && next.some((h, i) => h !== props.heights[i])) props.onCommit(next);
  };
  const key = (index: number) => (e: KeyboardEvent) => {
    if (locked) return;
    const by = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (!by) return;
    e.preventDefault();
    const next = dragDivider(props.heights, index, props.heights[index] + by);
    if (next[index] !== props.heights[index]) props.onCommit(next);
  };

  return (
    <div class="lod-bar-section" aria-label="LOD bar">
      <div class="lod-bar-head">
        <span class="lod-bar-title">{automatic ? "Transition heights (automatic)" : "Transition heights"}</span>
        {forceLevel !== -1 && (
          <span class="lod-bar-badge" role="status" title="forceLevel overrides the automatic choice: set it to -1 to choose by distance">
            Forced to LOD{forceLevel}
          </span>
        )}
        <button class="lod-bar-reset" disabled={automatic || !!readOnly} title={readOnly ?? (automatic ? "Already automatic" : "Derive the heights from the meshes' measured error again")} onClick={props.onReset}>
          Reset to automatic
        </button>
      </div>
      <div class="lod-bar" ref={bar} data-locked={locked || undefined} title={locked ? (why ?? undefined) : "Drag a divider to change where a level stops drawing"}>
        {layout.segments.map((s) => {
          const label = segmentLabel(s, heights, s.level < 0 ? null : (props.triangles[s.level] ?? null));
          return (
            <div
              key={s.level}
              class={`lod-bar-segment${s.level === forceLevel ? " forced" : ""}`}
              style={{ left: `${s.left * 100}%`, width: `${s.width * 100}%`, background: segmentColor(s.level) }}
              title={[label.name, label.height, label.triangles].filter(Boolean).join(", ")}
              aria-label={[label.name, label.height, label.triangles].filter(Boolean).join(", ")}
            >
              <span class="lod-bar-name">{label.name}</span>
              <span class="lod-bar-height">{label.height}</span>
              {label.triangles && <span class="lod-bar-tris">{label.triangles}</span>}
            </div>
          );
        })}
        {layout.dividers.map((d) => (
          <div
            key={d.index}
            class={`lod-bar-divider${drag?.index === d.index ? " dragging" : ""}`}
            style={{ left: `${d.left * 100}%` }}
            role="slider"
            tabIndex={locked ? -1 : 0}
            aria-label={d.index === layout.dividers.length - 1 ? "Cull height" : `LOD${d.index} to LOD${d.index + 1} height`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(d.height * 1000) / 10}
            aria-valuetext={percentLabel(d.height)}
            aria-disabled={locked}
            onPointerDown={start(d.index)}
            onPointerMove={move}
            onPointerUp={end(false)}
            onPointerCancel={end(true)}
            onKeyDown={key(d.index)}
          />
        ))}
      </div>
      <div class="lod-bar-axis" aria-hidden="true">
        <span>100%</span>
        <span>screen height</span>
        <span>0%</span>
      </div>
    </div>
  );
}
