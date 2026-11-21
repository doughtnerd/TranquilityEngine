// Inspector field helpers: a list item as a field of its own, a field's label tooltip and dropdown choices, and
// number-box parsing. What a field's value means (its scene-file form, sameness, blank value) is its kind's
// (`fields/kinds.ts`, ADR 0273).
import { isListType, resolveChoices, type FieldChoice, type ScalarFieldType } from "../engine/core/registry";
import { resolveSettings, type ProjectSettingsInput } from "../engine/core/settings";
import type { FieldValue } from "../engine/editor";

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

/** A field's dropdown choices, with project-setting choices taken from `settings`; null without any. */
export function choicesFor(field: FieldValue, settings?: ProjectSettingsInput): FieldChoice[] | null {
  return resolveChoices(field.options?.choices, resolveSettings(settings ?? {}));
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
