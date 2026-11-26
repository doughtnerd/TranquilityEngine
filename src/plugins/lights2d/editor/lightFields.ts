// Which Light2D fields apply to each light type (ADR 0399): the Inspector shows only those (`Light2DSection.tsx`).

const COMMON = ["type", "color", "intensity", "blendStyle", "overlap", "targetSortingLayers"];
const VOLUME = ["volumeIntensity"];
const NORMALS = ["normalMaps", "height"];
const SHADOWS = ["shadows", "shadowStrength", "shadowSoftness"];

/** The Light2D fields a light of `type` uses. */
export const LIGHT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  global: COMMON,
  point: [...COMMON, "innerRadius", "outerRadius", "innerAngle", "outerAngle", "falloff", ...VOLUME, ...NORMALS, ...SHADOWS],
  freeform: [...COMMON, "shape", "falloffSize", ...VOLUME, ...NORMALS, ...SHADOWS],
  sprite: [...COMMON, "sprite", ...VOLUME, ...NORMALS, ...SHADOWS],
};

/** The Light2D fields a light of `type` doesn't use (hidden in its card). */
export function hiddenLightFields(type: string, all: readonly string[]): string[] {
  const shown = LIGHT_FIELDS[type] ?? LIGHT_FIELDS.point!;
  return all.filter((f) => !shown.includes(f));
}
