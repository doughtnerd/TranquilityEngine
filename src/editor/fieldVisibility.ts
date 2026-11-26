// Which of a component's fields the Inspector shows (ADR 0131): not those another editor owns (`hidden`), and not
// those whose `shownWhen` condition fails for the component's current values, such as a Tilemap's hexagon side on
// a square grid. With several nodes selected, a conditional field shows if its condition holds on any of them.
import type { ComponentInfo, FieldValue } from "../engine/editor";
import { isHiddenField } from "./assetFieldKinds";

/** A component's field values by name, what a field's `shownWhen` is given. */
const valuesOf = (info: ComponentInfo): Record<string, unknown> => Object.fromEntries(info.fields.map((f) => [f.name, f.value]));

/** Whether a field's `shownWhen` holds for any of the components (true without one). A throwing condition shows the field. */
export function isFieldShown(field: FieldValue, components: readonly ComponentInfo[]): boolean {
  const when = field.options?.shownWhen;
  if (!when) return true;
  return components.some((c) => {
    try {
      return when(valuesOf(c));
    } catch {
      return true;
    }
  });
}

/** The fields the Inspector shows for a component across the selected nodes' copies of it (the last one's fields, in order). */
export function inspectorFields(components: readonly ComponentInfo[]): FieldValue[] {
  const info = components[components.length - 1];
  if (!info) return [];
  return info.fields.filter((f) => !isHiddenField(f) && isFieldShown(f, components));
}
