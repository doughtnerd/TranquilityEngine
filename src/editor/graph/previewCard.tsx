// A graph panel's live preview as a card docked in the canvas's bottom-right corner (first the
// Particle Graph's, ADR 0060; the Shader Graph's too): a "Preview" head with a fold, the panel's own
// controls and a close button, and a body resized from its top-left corner. The card is outside the
// graph for the pane's gestures: a pointer press doesn't start a box select or pan, and the wheel
// (`NO_WHEEL`) is the preview's own (it zooms the preview's camera), never the graph's.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { px, startPointerDrag } from "./canvas";
import { NO_PAN, NO_WHEEL } from "./xyflow";

export interface PreviewCardSize {
  w: number;
  h: number;
}

/** The smallest body a resize leaves. */
const MIN = { w: 200, h: 140 };

/** Each card's size this session, by key (a panel's), so reopening the panel keeps it. */
const sizes = new Map<string, PreviewCardSize>();

/** A preview card's body size, kept for the session under `key`; set it with the card's `onResize`. */
export function usePreviewCardSize(key: string, initial: PreviewCardSize): [PreviewCardSize, (size: PreviewCardSize) => void] {
  const [size, setSize] = useState(() => sizes.get(key) ?? initial);
  return [
    size,
    (next) => {
      sizes.set(key, next);
      setSize(next);
    },
  ];
}

export interface GraphPreviewCardProps {
  /** The card's accessible name ("Effect preview"). */
  label: string;
  /** The body's size (from `usePreviewCardSize`) and its change, from dragging the corner. */
  size: PreviewCardSize;
  onResize(size: PreviewCardSize): void;
  /** Hide the card (the panel's toolbar shows it again). */
  onClose(): void;
  /** The panel's controls in the head, after the title (a mesh picker). */
  controls?: ComponentChildren;
  /** The preview itself, filling the body. */
  children: ComponentChildren;
}

/** The live preview docked in the canvas's bottom-right corner: collapse it, close it, or resize it from its top-left corner. */
export function GraphPreviewCard(props: GraphPreviewCardProps) {
  const [open, setOpen] = useState(true);
  const { size } = props;
  const resize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const start = { ...size };
    startPointerDrag(e, {
      zoom: () => 1,
      onMove: (dx, dy) => props.onResize({ w: Math.max(MIN.w, start.w - dx), h: Math.max(MIN.h, start.h - dy) }),
      onEnd: () => undefined,
    });
  };
  return (
    <div class={`sg-previewcard ${NO_PAN} ${NO_WHEEL}`} aria-label={props.label} onPointerDown={(e) => e.stopPropagation()}>
      {open && <div class="sg-previewcard-resize" title="Drag to resize" onPointerDown={resize} />}
      <div class="sg-previewcard-head">
        <button type="button" class="sg-previewcard-fold" aria-label={open ? "Collapse the preview" : "Expand the preview"} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <span>Preview</span>
        <span class="sg-spacer" />
        {props.controls}
        <button type="button" class="sg-previewcard-close" aria-label="Hide the preview" title="Hide the preview (Preview in the toolbar shows it again)" onClick={props.onClose}>
          ×
        </button>
      </div>
      {/* Folded, the body stays (hidden) so the preview keeps its renderer and camera. */}
      <div class="sg-previewcard-body" hidden={!open} style={{ width: px(size.w), height: px(size.h) }}>
        {props.children}
      </div>
    </div>
  );
}
