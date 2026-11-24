// The 2D Lighting settings section's model (ADR 0399): `project.json`'s `lighting2D` key, which the Lights 2D plugin's
// settings category owns, as pure edits of the Project panel's draft. Reading it and its problems are the engine's
// runtime section's (`RUNTIME_SETTINGS.lighting2D`, ADR 0272), so the panel and the Engine's start-up warnings agree.
import { RUNTIME_SETTINGS } from "../../../engine/core/settings";
import { uniqueName } from "../../../engine/core/uniqueName";
import { MAX_BLEND_STYLES, type BlendStyleMask, type LightBlendStyle } from "../../../engine/render/lights2D/settings";
import { settingsSection, type NamedList, type NameReferencesContribution, type SettingsDraft } from "../../../editor/sdk";

const LIGHTING_2D = RUNTIME_SETTINGS.lighting2D;

/** `project.json`'s `lighting2D` key in the settings draft, read and checked as the engine reads it. */
export const lighting2DSettings = settingsSection({
  key: "lighting2D",
  parse: (written) => ({ settings: LIGHTING_2D.parse(written).value }),
  edits: "written",
  problems: (draft) => LIGHTING_2D.parse(draft.lighting2D).problems,
});

/** The blend styles now (the default one when unset). */
export const blendStylesOf = (d: SettingsDraft): LightBlendStyle[] => lighting2DSettings.read(d).blendStyles;

const withStyles = (d: SettingsDraft, styles: LightBlendStyle[]): SettingsDraft => lighting2DSettings.set(d, "blendStyles", styles);

/** Add a blend style (Additive-like: adds the light), up to the limit. */
export function addBlendStyle(d: SettingsDraft): SettingsDraft {
  const styles = blendStylesOf(d);
  if (styles.length >= MAX_BLEND_STYLES) return d;
  return withStyles(d, [...styles, { name: uniqueName("Style", styles.map((s) => s.name)), mask: "none", multiply: 0, add: 1 }]);
}

/** Remove a blend style (never the last). Lights that named it light through the first. */
export function removeBlendStyle(d: SettingsDraft, index: number): SettingsDraft {
  const styles = blendStylesOf(d);
  if (styles.length <= 1 || !styles[index]) return d;
  return withStyles(d, styles.filter((_, i) => i !== index));
}

/** Rename a blend style. (The Light2Ds naming it are renamed by the shell's settings names module, from `blendStyleNames`, ADR 0262.) */
export function renameBlendStyle(d: SettingsDraft, index: number, name: string): SettingsDraft {
  const styles = blendStylesOf(d);
  if (!styles[index] || !name.trim() || styles.some((s, i) => i !== index && s.name === name)) return d;
  return withStyles(d, styles.map((s, i) => (i === index ? { ...s, name } : s)));
}

/** Set a blend style's mask channel or a weight (weights clamped to 0–4). */
export function setBlendStyle(d: SettingsDraft, index: number, change: { mask?: BlendStyleMask; multiply?: number; add?: number }): SettingsDraft {
  const styles = blendStylesOf(d);
  const s = styles[index];
  if (!s) return d;
  const w = (v: number | undefined, was: number) => (v === undefined || !Number.isFinite(v) ? was : Math.min(4, Math.max(0, v)));
  return withStyles(d, styles.map((x, i) => (i === index ? { ...x, mask: change.mask ?? x.mask, multiply: w(change.multiply, x.multiply), add: w(change.add, x.add) } : x)));
}

/** Move a blend style up or down (its index is only display order: lights name styles). */
export function moveBlendStyle(d: SettingsDraft, index: number, by: number): SettingsDraft {
  const styles = [...blendStylesOf(d)];
  const to = index + by;
  if (!styles[index] || to < 0 || to >= styles.length) return d;
  [styles[index], styles[to]] = [styles[to]!, styles[index]!];
  return withStyles(d, styles);
}

/** The blend styles as a named list (ADR 0262): renaming one renames every Light2D's `blendStyle` that names it. */
export const blendStyleNames: NamedList = {
  id: "lighting2D.blendStyles",
  noun: "blend style",
  names: (d) => blendStylesOf(d).map((s) => s.name),
  fields: [{ component: "engine.Light2D", field: "blendStyle" }],
};

/** The sorting layers 2D lights and shadow casters target (ADR 0262): renamed with the layer. */
export const lights2DSortingLayers: NameReferencesContribution = {
  id: "lights2d.sortingLayers",
  list: "render.sortingLayers",
  fields: [{ component: ["engine.Light2D", "engine.ShadowCaster2D"], field: "targetSortingLayers.*" }],
};
