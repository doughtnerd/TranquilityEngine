// ADR 0336: a fade shape picker: a select of the shapes (the Wwise set) with a glyph of the chosen one's fade in or out,
// drawn from the engine's shape function in the theme's accent. A view over props; each pick is one commit.
import type { FadeShape } from "../../../engine/audio/playlist/types";
import { SelectBox } from "./fields";
import { FADE_SHAPE_OPTIONS, fadeShapePath } from "./fadeShapeModel";

export interface FadeShapeSelectProps {
  readonly value: FadeShape;
  /** A fade out (the glyph falls) rather than a fade in. */
  readonly out?: boolean;
  readonly label: string;
  readonly disabled?: boolean;
  onValue(v: FadeShape): void;
}

export function FadeShapeSelect(props: FadeShapeSelectProps) {
  return (
    <span class="pl-inline pl-shape">
      <svg class="pl-shape-glyph" width="24" height="12" viewBox="-1 -1 26 14" aria-hidden="true">
        <path d={fadeShapePath(props.value, !!props.out)} />
      </svg>
      <SelectBox label={props.label} value={props.value} disabled={props.disabled} options={FADE_SHAPE_OPTIONS} onValue={props.onValue} />
    </span>
  );
}
