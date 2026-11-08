// The Spinner plugin's editor half (ADR 0139): only the editor loads this folder. It may import the
// runtime half and "myco/editor".
import type { EditorPluginContext } from "myco/editor";
import { Spinner } from "../runtime/index";

export function activate(context: EditorPluginContext): void {
  const speed = new Spinner().speed;
  context.registerComponentNote({ id: "acme.spinner.note", note: (type) => (type === "acme.Spinner" ? `spins at ${speed}°/s` : null) });
}
