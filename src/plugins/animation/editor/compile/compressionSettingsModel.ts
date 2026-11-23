// Project Settings > Animation (T19): `project.json`'s `animation` key in the settings draft (its settings section
// handle, ADR 0253), and the project profile's compression edits, each refused or next (0313). Rules and platform
// overrides are read from the file and kept as written (`compile/settings.ts`); the view edits the project's values.
//
// Pure.
import {
  animationProjectSettingsToJson, COMPRESSION_LIMITS, parseAnimationProjectSettings, type AnimationProjectSettings, type CompressionKey,
} from "../../../../engine/animation/compile/settings";
import { accept, mapEdit, refuse, settingsSection, type EditResult, type SettingsDraft } from "../../../../editor/sdk";

/** The `animation` key of the draft: read leniently (the defaults when absent), written minimal (removed when all default). */
export const animationSettings = settingsSection<AnimationProjectSettings>({
  key: "animation",
  parse: (written) => parseAnimationProjectSettings(written),
  write: (draft, s) => ({ ...draft, animation: animationProjectSettingsToJson(s) }),
});

const LABELS: Record<CompressionKey, string> = { error: "the error bound", maxRate: "the highest sample rate", propertyError: "the property error bound" };

/** Sets (or, with undefined, clears so it inherits the built-in default) one of the project's compression values. */
export function setCompressionValue(draft: SettingsDraft, key: CompressionKey, value: number | undefined): EditResult<SettingsDraft> {
  const s = animationSettings.read(draft);
  if (value !== undefined) {
    const { min, max } = COMPRESSION_LIMITS[key];
    if (!(Number.isFinite(value) && value >= min && value <= max)) return refuse(`${LABELS[key]} is ${min} to ${max}`);
  }
  const compression = { ...s.compression, [key]: value };
  if (value === undefined) delete (compression as Record<string, unknown>)[key];
  return mapEdit(accept({ ...s, compression }), (next) => animationSettings.write(draft, next));
}
