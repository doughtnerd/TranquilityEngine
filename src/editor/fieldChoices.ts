// Contributed field choices (ADR 0152): a plugin supplies the choices for a Component field that
// depend on its other values or on files (the Meshes plugin: a MeshRenderer's material variants).
// The Inspector asks here which contribution applies, loads its choices, and lists them.
import type { FieldChoice } from "../engine/core/registry";
import type { ComponentInfo } from "../engine/editor";
import { fieldChoices, type FieldChoicesContribution } from "./sdk/contributions";

/** The contribution that supplies the choices of `field` on Component `type`, if one is registered. */
export function fieldChoicesFor(type: string, field: string): FieldChoicesContribution | undefined {
  fieldChoices.version.value; // follow plugins coming and going
  return fieldChoices.list().find((c) => c.type === type && c.field === field);
}

/** The contribution's choices for `info` (the active node's copy of the component); none when it fails. */
export async function loadFieldChoices(contribution: FieldChoicesContribution, info: ComponentInfo): Promise<readonly FieldChoice[]> {
  try {
    return await contribution.choices(info);
  } catch {
    return [];
  }
}

/**
 * What the Inspector's dropdown lists for a contributed field: `none` then the loaded choices; with no
 * choices, `none` alone while some selected node has a value (or they differ), else null (hide the row).
 */
export function listedChoices(contribution: FieldChoicesContribution, loaded: readonly FieldChoice[], value: unknown, mixed: boolean): readonly FieldChoice[] | null {
  const none = contribution.none ? [contribution.none] : [];
  if (loaded.length > 0) return [...none, ...loaded];
  const unset = value === undefined || value === null || value === "";
  return unset && !mixed ? null : none;
}
