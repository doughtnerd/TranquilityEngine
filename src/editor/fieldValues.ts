// Converting inspector values to scene-file JSON (ADR 0013), the form `SetField` stores.
import { AssetRef, Color, GameObject, PlainObject, Quaternion, Vector2, Vector3 } from "../engine";
import { isListType, resolveChoices, type FieldChoice, type ScalarFieldType } from "../engine/core/registry";
import { resolveSettings, type ProjectSettingsInput } from "../engine/core/settings";
import type { FieldValue } from "../engine/editor";

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
  return field.options ? { name: `${field.name}[${index}]`, type, value, options: field.options } : { name: `${field.name}[${index}]`, type, value };
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
    case "quaternion":
      return [0, 0, 0];
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
 * - Transform `rotation` stays a single angle when the file already stores it that way (2D).
 */
export function toSceneJSON(
  editor: FieldEditor,
  value: unknown,
  options: { nodeId?: (node: GameObject) => string | null; previous?: unknown; field?: string; itemEditor?: FieldEditor } = {},
): unknown {
  switch (editor) {
    case "list": {
      // Each item in its own scene-file form (ADR 0038); the whole list is written at once.
      const items = Array.isArray(value) ? value : [];
      const item = options.itemEditor ?? "unknown";
      return items.map((v) => toSceneJSON(item, v, { nodeId: options.nodeId }));
    }
    case "quaternion":
      if (value === null || value === undefined) return null;
      // Euler degrees, rounded (and without -0) so the file reads as typed.
      return value instanceof Quaternion ? value.toEuler().toArray().map((n) => Math.round(n * 1e4) / 1e4 + 0) : Array.isArray(value) ? [...value] : value;
    case "choice":
      return value;
    case "vector2":
    case "vector3": {
      if (value === null || value === undefined) return null;
      const arr = Array.isArray(value) ? [...value] : (value as { toArray(): number[] }).toArray();
      if (options.field === "rotation" && typeof options.previous === "number" && arr[0] === 0 && arr[1] === 0) return arr[2];
      return arr;
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
  if (/^[-+*/().\d\se]+$/i.test(trimmed)) {
    try {
      const n = Number(new Function(`return (${trimmed});`)());
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}
