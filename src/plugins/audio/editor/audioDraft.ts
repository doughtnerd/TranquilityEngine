// `project.json`'s `audio` key (ADR 0097) as a settings section handle (ADR 0253): the one way the Audio settings
// section, the mixer and the inspectors read the key (`audioSection`'s parse, memoised per section object and frozen,
// ADR 0175) and write it back whole (`withSettings`: built-in occlusion materials pruned). Small on purpose: the mixer
// and the inspectors read it without loading the settings model.
import { audioSection, withSettings } from "../../../engine/audio/audioSection";
import type { AudioSettings } from "../../../engine/audio/settings";
import { settingsSection } from "../../../editor/sdk";

export const audioSettings = settingsSection<AudioSettings>({ key: "audio", parse: audioSection, write: withSettings });
