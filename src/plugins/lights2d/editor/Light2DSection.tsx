// Under a Light2D's fields in the Inspector (ADR 0399): only the fields its type uses are shown (the others' rows are
// hidden, `lightFields.ts`), with notes on what lights need to show: a global light for areas outside lights, Sprite
// Lit materials (the default) on what it should light, and the quality tier's limits on shadows and normal maps.
import { useLayoutEffect, useRef } from "preact/hooks";
import { sectionField, type InspectorSectionProps } from "../../../editor/sdk";
import { hiddenLightFields } from "./lightFields";
import "./lights2d.css";

/** Hides the card's rows for `names` (or shows them all again): the Inspector owns the rows, so this sets an attribute it never touches. */
function hideRows(card: Element | null, titles: ReadonlySet<string>): void {
  if (!card) return;
  for (const label of card.querySelectorAll<HTMLElement>(".fields .label-cell > label")) {
    const hide = titles.has(label.title) || titles.has(label.textContent ?? "");
    for (const cell of [label.parentElement, label.parentElement?.nextElementSibling]) {
      if (!cell) continue;
      if (hide) cell.setAttribute("data-lights2d-hidden", "");
      else cell.removeAttribute("data-lights2d-hidden");
    }
  }
}

export function Light2DSection({ info }: InspectorSectionProps) {
  const root = useRef<HTMLDivElement>(null);
  const type = String(sectionField(info, "type") ?? "point");
  const shadows = !!sectionField(info, "shadows");
  const hidden = hiddenLightFields(type, info.fields.map((f) => f.name));
  const titles = new Set(info.fields.filter((f) => hidden.includes(f.name)).flatMap((f) => [f.options?.description || f.name, f.name]));
  useLayoutEffect(() => {
    const card = root.current?.closest("section") ?? null;
    hideRows(card, titles);
    return () => hideRows(card, new Set());
  }, [type, info.fields.length]);
  return (
    <div class="lights2d-section" ref={root} aria-label="2D light notes">
      {type !== "global" && <p class="lights2d-note">Areas no light reaches are black, unless a Global Light 2D also lights these sorting layers.</p>}
      <p class="lights2d-note">It lights sprites, tiles, 2D decals and 2D lines whose material is Sprite Lit (the default). A sorting layer no 2D light targets draws unlit.</p>
      {shadows && <p class="lights2d-note">Shadows come from ShadowCaster2D components. The quality tier caps how many lights cast them (4 on Low).</p>}
    </div>
  );
}
