// A drag on an Inspector control (a slider, a curve) as one field drag (ADR 0257): the drag opens on the press,
// through the edit gate, and closes on release or cancel, so every write made meanwhile is one undo step. The drag is
// held by the control's component across its re-renders (the writes re-render it mid-drag) and closed if it unmounts.
import { useEffect, useRef } from "preact/hooks";
import { beginFieldDrag, type ComponentPlace, type FieldDrag } from "../componentField";

/** Pointer handlers to spread on the control. */
export interface FieldDragHandlers {
  onPointerDownCapture(): void;
  onPointerUp(): void;
  onPointerCancel(): void;
}

/** Make a pointer drag on a control one drag named `label` on the component at `place` (its `fields` for a live node). */
export function useFieldDrag(place: ComponentPlace, label: string, fields?: readonly string[]): FieldDragHandlers {
  const drag = useRef<FieldDrag | null>(null);
  const end = () => {
    const open = drag.current;
    drag.current = null;
    open?.end();
  };
  useEffect(() => end, []);
  return {
    onPointerDownCapture() {
      if (drag.current?.open) return;
      drag.current = beginFieldDrag(place, label, fields);
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}
