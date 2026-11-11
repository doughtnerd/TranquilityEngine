// Converting inspector values to scene-file JSON (ADR 0013), the form `SetField` stores.
import { AssetRef, Color, GameObject, PlainObject, Quaternion, Vector2, Vector3 } from "../engine";
import { isListType, resolveChoices, type FieldChoice, type ScalarFieldType } from "../engine/core/registry";
import { resolveSettings, type ProjectSettingsInput } from "../engine/core/settings";
import type { FieldValue } from "../engine/editor";
import { rotationCodec, rotationFrom } from "./fields/rotationCodec";

/** How the inspector edits a field. */
export type FieldEditor =
  | "number"
  | "integer"
  | "boolean"
  | "string"
  | "asset"
  | "color"
  | "vector2"
  | "vector3"
  | "quaternion"
  | "node"
  | "object"
  | "choice"
  | "list"
  | "unknown";

export { quaternionJSON } from "./fields/rotationCodec";

/** Pick an editor from the declared type, falling back to the live value's shape. */
export function editorFor(field: FieldValue): FieldEditor {
  const t = field.type as unknown;
  if (isListType(t)) return "list";
  if (field.options?.choices !== undefined) return "choice";
  if (t === Quaternion) return "quaternion";
  if (t === Number) return "number";
  if (t === Boolean) return "boolean";
  if (t === String) return "string";
  if (t === AssetRef) return "asset";
  if (t === Color) return "color";
  if (t === Vector2) return "vector2";
  if (t === Vector3) return "vector3";
  if (t === GameObject) return "node";
  if (t === PlainObject) return "object";
  if (t && typeof t === "object" && "kind" in t) return (t as { kind: string }).kind === "f32" ? "number" : "integer"; // data component scalars
  const v = field.value;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  return "unknown";
}

/** A list field's item as a field of its own (`name[i]`), so the item editors can show it. */
export function itemField(field: FieldValue, index: number, value: unknown): FieldValue {
  const type = (isListType(field.type) ? field.type[0] : field.type) as ScalarFieldType;
  // The description belongs to the list, so an item's options drop it (ADR 0159).
  const { description: _description, ...options } = field.options ?? {};
  return Object.keys(options).length > 0 ? { name: `${field.name}[${index}]`, type, value, options } : { name: `${field.name}[${index}]`, type, value };
}

/** The tooltip for a field's label: its declared description (ADR 0159), else the field's name. Plain text, never markup. */
export function fieldTitle(field: FieldValue): string {
  return field.options?.description || field.name;
}

/** The editor for each item of a list field. */
export function itemEditorFor(field: FieldValue): FieldEditor {
  return editorFor(itemField(field, 0, undefined));
}

/** A value for an item added to an empty list. */
export function defaultItem(editor: FieldEditor, choices: readonly FieldChoice[] | null = null): unknown {
  switch (editor) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "string":
    case "asset":
      return "";
    case "color":
      return Color.white;
    case "vector2":
      return [0, 0];
    case "vector3":
      return [0, 0, 0];
    case "quaternion":
      return [0, 0, 0, 1];
    case "object":
      return {};
    case "choice":
      return choices?.[0]?.value ?? "";
    default:
      return null;
  }
}

/** A field's dropdown choices, with project-setting choices taken from `settings`; null without any. */
export function choicesFor(field: FieldValue, settings?: ProjectSettingsInput): FieldChoice[] | null {
  return resolveChoices(field.options?.choices, resolveSettings(settings ?? {}));
}

/** Scene-file JSON for a color: `#rrggbb`, or `#rrggbbaa` when not opaque. */
export function colorToJSON(c: Color): string {
  if (c.a >= 1) return c.toHex();
  return c.toHex() + Math.round(Math.min(Math.max(c.a, 0), 1) * 255).toString(16).padStart(2, "0");
}

/**
 * Scene-file JSON for an edited value.
 * - vectors → `[x, y(, z)]`; colors → hex; asset paths → `"asset:…"`; node refs → `{"$node": id}`
 *   (the caller resolves a node to its document id) or `null`.
 * - rotations (Transform `rotation`, `@field(Quaternion)`) → a quaternion `[x, y, z, w]` (ADR 0163), from a
 *   Quaternion, a raw `[x, y, z, w]` or Euler radians `[x, y, z]` (order ZXY, remembered for the Inspector),
 *   in the rotation codec's form (ADR 0165).
 */
export function toSceneJSON(
  editor: FieldEditor,
  value: unknown,
  options: { nodeId?: (node: GameObject) => string | null; previous?: unknown; field?: string; itemEditor?: FieldEditor } = {},
): unknown {
  switch (editor) {
    case "list": {
      // Each item in its own scene-file form (ADR 0042); the whole list is written at once.
      const items = Array.isArray(value) ? value : [];
      const item = options.itemEditor ?? "unknown";
      return items.map((v) => toSceneJSON(item, v, { nodeId: options.nodeId }));
    }
    case "quaternion": {
      if (value === null || value === undefined) return null;
      const q = rotationFrom(value);
      return q ? rotationCodec("radians").toJSON(q) : value;
    }
    case "choice":
      return value;
    case "vector2":
    case "vector3": {
      if (value === null || value === undefined) return null;
      return Array.isArray(value) ? [...value] : (value as { toArray(): number[] }).toArray();
    }
    case "color":
      if (value === null || value === undefined) return null;
      return colorToJSON(value instanceof Color ? value : Color.from(value as string));
    case "asset": {
      const path = String(value ?? "");
      return path === "" || path.startsWith("asset:") ? path : `asset:${path}`;
    }
    case "node": {
      if (value === null || value === undefined) return null;
      if (typeof value === "string") return { $node: value };
      const id = options.nodeId?.(value as GameObject) ?? null;
      return id === null ? null : { $node: id };
    }
    case "object":
      return structuredClone(value);
    case "integer":
      return Math.round(Number(value));
    case "number":
      return Number(value);
    case "boolean":
      return Boolean(value);
    default:
      return value;
  }
}

/** Parse number input text; null if it isn't a finite number. Accepts simple arithmetic like `2*3`. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // `pi` or `π` for radians (ADR 0165).
  const expr = trimmed.replace(/π|\bpi\b/gi, "(3.141592653589793)");
  if (/^[-+*/().\d\se]+$/i.test(expr)) {
    try {
      const n = Number(new Function(`return (${expr});`)());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}
