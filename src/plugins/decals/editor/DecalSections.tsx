// Under a DecalProjector's fields in the Inspector (ADR 0381): `texture` greyed while a material is set (the material's
// own textures draw then), with a note; and a note when the box is flat on an axis (it projects nowhere).
import { useLayoutEffect, useRef } from "preact/hooks";
import { sectionField, type InspectorSectionProps } from "../../../editor/sdk";
import "./decals.css";

/** Marks the card's rows for `fields` greyed (or clears them): the Inspector owns the rows, so this sets an attribute it never touches. */
function greyRows(card: Element | null, titles: readonly string[], greyed: boolean): void {
  if (!card) return;
  for (const label of card.querySelectorAll<HTMLElement>(".fields .label-cell > label")) {
    if (!titles.includes(label.title)) continue;
    for (const cell of [label.parentElement, label.parentElement?.nextElementSibling]) {
      if (!cell) continue;
      if (greyed) cell.setAttribute("data-decals-greyed", "");
      else cell.removeAttribute("data-decals-greyed");
    }
  }
}

const vec3 = (v: unknown): [number, number, number] => (Array.isArray(v) ? [Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)] : [1, 1, 1]);

export function DecalProjectorSection({ info }: InspectorSectionProps) {
  const root = useRef<HTMLDivElement>(null);
  const material = String(sectionField(info, "material") ?? "");
  const size = vec3(sectionField(info, "size"));
  const titles = info.fields.filter((f) => f.name === "texture").map((f) => f.options?.description || f.name);
  useLayoutEffect(() => {
    const card = root.current?.closest("section") ?? null;
    greyRows(card, titles, material !== "");
    return () => greyRows(card, titles, false);
  }, [material]);
  const flat = size.some((s) => Math.abs(s) < 1e-4);
  return (
    <div class="decals-section" ref={root} aria-label="Decal projector notes">
      {material !== "" && <p class="decals-note">The material's own textures draw: Texture (greyed) is for the built-in decal material.</p>}
      {flat && (
        <p class="decals-note decals-note-warning" role="status">
          The box is flat on an axis, so the decal covers nothing. Give Size some depth.
        </p>
      )}
    </div>
  );
}
