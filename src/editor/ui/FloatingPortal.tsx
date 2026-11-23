// A floating layer for popovers and dialogs (menus, the History popover, the Studio's device menu and calibration
// dialog). A `position: fixed` element is laid out against its nearest ancestor with layout containment, and a
// container-query element (`container-type: inline-size`, such as the Studio's header, player bar and toolbars) has
// it: a dialog drawn inside one is placed and clipped inside that bar instead of the window. So floating content is
// drawn here instead, at the page's floating root: the element marked `data-floating-root` (the Studio's page, so its
// own scoped rules still apply), else the document's body. Content keeps its component's signals and context.
import { createPortal, type ComponentChildren } from "preact";

/** The element floating content is drawn into on `doc`'s page. */
export function floatingRoot(doc: Document = document): HTMLElement {
  return doc.querySelector<HTMLElement>("[data-floating-root]") ?? doc.body;
}

export function FloatingPortal(props: { readonly children: ComponentChildren }) {
  if (typeof document === "undefined") return <>{props.children}</>;
  return createPortal(<>{props.children}</>, floatingRoot());
}
