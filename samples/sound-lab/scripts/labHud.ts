import { UIDocument, type GameObject } from "myco";

/**
 * Sets the `{key}` binding of the UI document on the `hud` node (ADR 0077): each page's readouts are
 * lines of one document (ui/<page>.ui.xml), and the page's scripts each fill their own binding.
 * Without a document (a scene that doesn't have one) it does nothing.
 */
export function setHud(hud: GameObject | null, key: string, value: string): void {
  const ui = hud?.getBehavior(UIDocument);
  if (ui) ui.data[key] = value;
}
