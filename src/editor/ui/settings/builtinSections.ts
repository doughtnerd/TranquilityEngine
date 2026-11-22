// The Project panel's built-in Languages and Subtitles categories (ADR 0340 L7, 0342 T7, 0343 S5), registered through the
// same `ProjectSettingsSectionContribution` plugins use, as the built-in panels are (ADR 0182): they own `project.json`'s
// `languages` and `subtitles` keys, which the engine reads itself (`RUNTIME_SETTINGS`), so they are Core, never off.
// `corePanels.ts` registers them at start-up.
import { projectSettingsSections, type ProjectSettingsSectionContribution } from "../../sdk/contributions";
import { languagesProblems } from "./languagesSettingsModel";
import { subtitlesProblems } from "./subtitlesSettingsModel";

const BUILTIN_SECTIONS: readonly ProjectSettingsSectionContribution[] = [
  {
    id: "languages",
    title: "Languages",
    keys: ["languages"],
    problems: languagesProblems,
    view: () => import("./LanguagesSection").then((m) => m.LanguagesSettingsSection),
  },
  {
    id: "subtitles",
    title: "Subtitles",
    after: "Languages",
    keys: ["subtitles"],
    problems: subtitlesProblems,
    view: () => import("./SubtitlesSection").then((m) => m.SubtitlesSettingsSection),
  },
];

/** Register the built-in settings sections. Returns a function that removes them again (for tests). */
export function registerBuiltinSettingsSections(): () => void {
  const undo = BUILTIN_SECTIONS.map((s) => projectSettingsSections.register(s));
  return () => undo.forEach((u) => u());
}
