// Render into a detached panel window (ADR 0174): a portal from the main window's tree into the
// child's container, so the content shares the main window's signals, context and lifetime.
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import type { ChildWindowHandle } from "./childWindow";

export function ChildWindowPortal(props: { handle: ChildWindowHandle; children: ComponentChildren }) {
  return props.handle.closed.value ? null : createPortal(<>{props.children}</>, props.handle.container);
}
