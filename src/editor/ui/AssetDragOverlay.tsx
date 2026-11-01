import { assetDrag, dropDescription } from "../assetDrag";
import { openScene } from "../state";

/** The label following a dragged asset, saying what releasing will do (or why it can't). */
export function AssetDragGhost() {
  const drag = assetDrag.value;
  if (!drag) return null;
  const ok = !!drag.target;
  return (
    <div class={`asset-drag-ghost${ok ? "" : " invalid"}`} style={{ left: `${drag.x + 14}px`, top: `${drag.y + 14}px` }} role="status">
      {dropDescription(drag, openScene.value?.doc ?? null)}
    </div>
  );
}

/** Highlights the viewport while it's a valid drop target for a dragged asset. */
export function ViewportDropHighlight() {
  const t = assetDrag.value?.target;
  return t?.kind === "viewport" ? <div class="viewport-drop-highlight" /> : null;
}
