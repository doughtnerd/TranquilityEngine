import { useRef, useState } from "preact/hooks";
import { evalGradient, type ParticleGradient } from "../../../engine/scene/particles";
import { addAlphaKey, addColorKey, moveAlphaKey, moveColorKey, removeAlphaKey, removeColorKey, setColorKey } from "../../particles/curveEdit";
import { NumField } from "./valueInputs";
import "./particles.css";

/** A CSS `linear-gradient` of the gradient, with alpha (shown over a checkerboard by `.gradient-bar`). */
export function gradientCss(g: ParticleGradient): string {
  const stops = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    const [r, gr, b, a] = evalGradient(g, t);
    return `rgb(${Math.round(r * 255)} ${Math.round(gr * 255)} ${Math.round(b * 255)} / ${+a.toFixed(3)}) ${(t * 100).toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** A read-only strip of a gradient, for when it is collapsed. */
export function GradientPreview(props: { gradient: ParticleGradient }) {
  return <span class="gradient-preview gradient-bar" aria-hidden="true" style={{ "--gradient": gradientCss(props.gradient) } as never} />;
}

type Selection = { kind: "color" | "alpha"; index: number };

/**
 * A particle gradient (ADR 0057): colour stops under the bar, alpha stops above it. Click the bar's
 * lower half to add a colour stop, its upper half for an alpha stop; drag stops to move them, drag
 * one away from the bar (or press Delete, or use Remove) to remove it. A gradient keeps at least one
 * colour stop.
 */
export function GradientEditor(props: { gradient: ParticleGradient; onChange: (g: ParticleGradient) => void; label: string; readOnly?: boolean }) {
  const { gradient, onChange, label, readOnly } = props;
  const [selected, setSelected] = useState<Selection | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<Selection | null>(null);
  const sel = selected && selected.index < (selected.kind === "color" ? gradient.colors.length : gradient.alphas.length) ? selected : null;

  const tAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 1000) / 1000;
  };
  const remove = (s: Selection) => {
    if (readOnly) return;
    if (s.kind === "color") {
      if (gradient.colors.length <= 1) return;
      onChange(removeColorKey(gradient, s.index));
    } else onChange(removeAlphaKey(gradient, s.index));
    setSelected(null);
  };
  const stop = (kind: "color" | "alpha", index: number, t: number, css: string) => {
    const isSel = sel?.kind === kind && sel.index === index;
    return (
      <button
        type="button"
        key={`${kind}${index}`}
        class={`gradient-stop ${kind}${isSel ? " selected" : ""}`}
        data-stop={`${kind}-${index}`}
        aria-label={`${label} ${kind} stop ${index + 1}`}
        aria-pressed={isSel}
        disabled={readOnly}
        style={{ left: `${t * 100}%`, "--stop": css } as never}
        onPointerDown={(e) => {
          e.stopPropagation();
          setSelected({ kind, index });
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { kind, index };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.kind !== kind || d.index !== index) return;
          onChange(kind === "color" ? moveColorKey(gradient, index, tAt(e.clientX)) : moveAlphaKey(gradient, index, tAt(e.clientX)));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          // Dragged well away from the bar: remove it.
          const r = bar.current!.getBoundingClientRect();
          if (Math.abs(e.clientY - (r.top + r.height / 2)) > 40) remove(d);
        }}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            remove({ kind, index });
          }
        }}
      />
    );
  };

  return (
    <div class="gradient-editor" aria-label={label}>
      <div class="gradient-stops alpha-stops">{gradient.alphas.map(([t, a], i) => stop("alpha", i, t, `rgb(${Math.round(a * 255)} ${Math.round(a * 255)} ${Math.round(a * 255)})`))}</div>
      <div
        ref={bar}
        class="gradient-bar gradient-main"
        role="img"
        aria-label={`${label} gradient`}
        style={{ "--gradient": gradientCss(gradient) } as never}
        onClick={(e) => {
          if (readOnly) return;
          const r = e.currentTarget.getBoundingClientRect();
          const t = tAt(e.clientX);
          if (e.clientY < r.top + r.height / 2) {
            const added = addAlphaKey(gradient, t);
            onChange(added.gradient);
            setSelected({ kind: "alpha", index: added.index });
          } else {
            const added = addColorKey(gradient, t);
            onChange(added.gradient);
            setSelected({ kind: "color", index: added.index });
          }
        }}
      />
      <div class="gradient-stops color-stops">{gradient.colors.map(([t, c], i) => stop("color", i, t, c))}</div>
      <div class="gradient-readout">
        {sel ? (
          <>
            {sel.kind === "color" ? (
              <input
                type="color"
                class="pe-color"
                aria-label={`${label} stop colour`}
                disabled={readOnly}
                value={gradient.colors[sel.index][1]}
                onInput={(e) => onChange(setColorKey(gradient, sel.index, (e.currentTarget as HTMLInputElement).value))}
              />
            ) : (
              <label>
                <em>alpha</em>
                <NumField
                  value={gradient.alphas[sel.index][1]}
                  label={`${label} stop alpha`}
                  disabled={readOnly}
                  onCommit={(a) => onChange(moveAlphaKey(gradient, sel.index, gradient.alphas[sel.index][0], Math.min(1, Math.max(0, a))))}
                />
              </label>
            )}
            <label>
              <em>t</em>
              <NumField
                value={(sel.kind === "color" ? gradient.colors : gradient.alphas)[sel.index][0]}
                label={`${label} stop position`}
                disabled={readOnly}
                onCommit={(t) => onChange(sel.kind === "color" ? moveColorKey(gradient, sel.index, t) : moveAlphaKey(gradient, sel.index, t))}
              />
            </label>
            <button type="button" class="pe-mini" aria-label={`${label} remove stop`} disabled={readOnly || (sel.kind === "color" && gradient.colors.length <= 1)} onClick={() => remove(sel)}>
              Remove
            </button>
          </>
        ) : (
          <span class="curve-hint">Click the bar to add a stop</span>
        )}
      </div>
    </div>
  );
}
