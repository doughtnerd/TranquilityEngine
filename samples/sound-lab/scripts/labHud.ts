import { UIView, type GameObject } from "myco";

/**
 * Sets the `key` prop of the UIView on the `hud` node (ADR 0423): each page's readouts are lines of one
 * component (ui/<Page>.svelte), and the page's scripts each pass their own prop.
 * Without a view (a scene that doesn't have one) it does nothing.
 */
export function setHud(hud: GameObject | null, key: string, value: string): void {
  const ui = hud?.getBehavior(UIView);
  if (ui) ui.props[key] = value;
}
