import type { ComponentChildren } from "preact";
import { useLayoutEffect } from "preact/hooks";
import { assetDrag, dropDescription } from "../assetDrag";
import { nodeDrag, nodeDropDescription } from "../nodeDrag";
import { openScene } from "../state";

/**
 * The label following the pointer while something is dragged, saying what releasing will do (or why
 * it can't). While it shows, the body carries `dragging` (and `drag-invalid` when releasing would do
 * nothing), which sets the cursor everywhere. A class rather than `body:has(.asset-drag-ghost)`: with a
 * `:has()` rule on the body, every change anywhere on the page restyled the whole editor, and the play
 * view's per-frame updates made that about 8 ms a frame.
 */
export function DragGhost(props: { x: number; y: number; invalid: boolean; children: ComponentChildren }) {
  const { invalid } = props;
  useLayoutEffect(() => {
    document.body.classList.add("dragging");
    return () => document.body.classList.remove("dragging");
  }, []);
  useLayoutEffect(() => {
    document.body.classList.toggle("drag-invalid", invalid);
    return () => document.body.classList.remove("drag-invalid");
  }, [invalid]);
  return (
    <div class={`asset-drag-ghost${invalid ? " invalid" : ""}`} style={{ left: `${props.x + 14}px`, top: `${props.y + 14}px` }} role="status">
      {props.children}
    </div>
  );
}

/** The label following a dragged asset or hierarchy node, saying what releasing will do (or why it can't). */
export function AssetDragGhost() {
  const doc = openScene.value?.doc ?? null;
  const asset = assetDrag.value, node = nodeDrag.value;
  const drag = asset ?? node;
  if (!drag) return null;
  const text = asset ? dropDescription(asset, doc) : nodeDropDescription(node!, doc);
  return (
    <DragGhost x={drag.x} y={drag.y} invalid={!drag.target}>
      {text}
    </DragGhost>
  );
}

/** Highlights the viewport while it's a valid drop target for a dragged asset. */
export function ViewportDropHighlight() {
  const t = assetDrag.value?.target;
  return t?.kind === "viewport" ? <div class="viewport-drop-highlight" /> : null;
}
