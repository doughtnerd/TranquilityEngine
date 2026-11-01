import { assetDrag, dropDescription } from "../assetDrag";
import { nodeDrag, nodeDropDescription } from "../nodeDrag";
import { openScene } from "../state";

/** The label following a dragged asset or hierarchy node, saying what releasing will do (or why it can't). */
export function AssetDragGhost() {
  const doc = openScene.value?.doc ?? null;
  const asset = assetDrag.value, node = nodeDrag.value;
  const drag = asset ?? node;
  if (!drag) return null;
  const text = asset ? dropDescription(asset, doc) : nodeDropDescription(node!, doc);
  return (
    <div class={`asset-drag-ghost${drag.target ? "" : " invalid"}`} style={{ left: `${drag.x + 14}px`, top: `${drag.y + 14}px` }} role="status">
      {text}
    </div>
  );
}

/** Highlights the viewport while it's a valid drop target for a dragged asset. */
export function ViewportDropHighlight() {
  const t = assetDrag.value?.target;
  return t?.kind === "viewport" ? <div class="viewport-drop-highlight" /> : null;
}
