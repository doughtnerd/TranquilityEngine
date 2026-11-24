// Under a LineRenderer's or TrailRenderer's fields in the Inspector (ADR 0396): the width curve drawn with the SDK's
// CurveField and the colour gradient with its GradientField (both fields are plain objects, so the card has no editor
// of its own for them), and the fields the ribbon's mode ignores greyed: in 2D the material, alignment and shadows, in
// 3D the sorting layer and order.
import { useLayoutEffect, useRef } from "preact/hooks";
import { isGradient, whiteGradient, type Gradient } from "../../../engine/core/gradient";
import type { Curve } from "../../../engine/core/curve";
import { CurveField, GradientField, editor, sectionField, useFieldDrag, type InspectorSectionProps } from "../../../editor/sdk";
import "./lines.css";

/** The fields each mode ignores. */
const IGNORED: Record<"2d" | "3d", readonly string[]> = {
  "2d": ["material", "alignment", "castShadows", "receiveShadows"],
  "3d": ["sortingLayer", "orderInLayer"],
};

/** Marks the card's rows for `fields` greyed (or clears them): the Inspector owns the rows, so this sets an attribute it never touches. */
function greyRows(card: Element | null, titles: readonly string[], greyed: boolean): void {
  if (!card) return;
  for (const label of card.querySelectorAll<HTMLElement>(".fields .label-cell > label")) {
    if (!titles.includes(label.title)) continue;
    for (const cell of [label.parentElement, label.parentElement?.nextElementSibling]) {
      if (!cell) continue;
      if (greyed) cell.setAttribute("data-lines-greyed", "");
      else cell.removeAttribute("data-lines-greyed");
    }
  }
}

/** A curve field's keys as `[x, y]` pairs, or a flat 1. */
function curveOf(v: unknown): [number, number][] {
  if (!Array.isArray(v) || v.length === 0) return [[0, 1], [1, 1]];
  return (v as Curve).map((k) => [Number(k[0]), Number(k[1])] as [number, number]);
}

export function RibbonSection({ scene, paths, info }: InspectorSectionProps) {
  const root = useRef<HTMLDivElement>(null);
  const mode = sectionField(info, "mode") === "2d" ? "2d" : "3d";
  const all = [...IGNORED["2d"], ...IGNORED["3d"]];
  const titleOf = (name: string): string => info.fields.find((f) => f.name === name)?.options?.description || name;
  useLayoutEffect(() => {
    const card = root.current?.closest("section") ?? null;
    greyRows(card, all.map(titleOf), false);
    greyRows(card, IGNORED[mode].map(titleOf), true);
    return () => greyRows(card, all.map(titleOf), false);
  }, [mode]);

  const place = { scene, path: paths[0]!, type: info.type, index: info.index };
  const curve = curveOf(sectionField(info, "widthCurve"));
  const top = Math.max(1, ...curve.map((k) => k[1])) * 1.25;
  const stored = sectionField(info, "colorGradient");
  const gradient: Gradient = isGradient(stored) ? stored : whiteGradient();
  const curveDrag = useFieldDrag(place, "Edit width curve");
  const gradientDrag = useFieldDrag(place, "Edit colour gradient");
  const along = info.type === "engine.TrailRenderer" ? "from the head (0) to the tail (1)" : "from the first point (0) to the last (1)";
  return (
    <div class="lines-section" ref={root} aria-label="Ribbon width and colour">
      <div class="lines-field" {...curveDrag}>
        <h4 title={`The width multiplier along the ribbon, ${along}; Width is the width where it's 1.`}>Width over length</h4>
        <CurveField curve={curve} xRange={[0, 1]} yRange={[0, top]} interpolation={false} label="Width curve" onChange={(c) => editor.scene.writeField(place, "widthCurve", c.map((k) => [k[0], k[1]]))} />
      </div>
      <div class="lines-field" {...gradientDrag}>
        <h4 title={`The colour and alpha along the ribbon, ${along}; Color multiplies it.`}>Colour over length</h4>
        <GradientField gradient={gradient} label="Colour gradient" onChange={(g) => editor.scene.writeField(place, "colorGradient", g)} />
      </div>
    </div>
  );
}
