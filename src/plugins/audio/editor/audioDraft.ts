// `project.json`'s `audio` key (ADR 0097) as a settings section handle (ADR 0253): the one way the Audio settings
// section, the mixer and the inspectors read the key (`audioSection`'s parse, memoised per section object and frozen,
// ADR 0175) and write it back whole (`withSettings`: built-in occlusion materials pruned). Small on purpose: the mixer
// and the inspectors read it without loading the settings model. Its edits are `"canonical"` (ADR 0306): a value set by
// path (`audioSettings.set(d, "music.rings", 20)`) is stored as the parse makes it (16), so the scalar keys need no setter
// of their own and their limits live only in the parse's declaration (`AUDIO_NUMBERS`).
import { audioSection, withSettings } from "../../../engine/audio/audioSection";
import type { AudioSettings } from "../../../engine/audio/settings";
import { settingsSection } from "../../../editor/sdk";

export const audioSettings = settingsSection<AudioSettings>({ key: "audio", parse: audioSection, write: withSettings, edits: "canonical" });
