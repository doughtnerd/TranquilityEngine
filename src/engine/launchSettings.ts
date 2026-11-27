// Launch settings (ADR 0435): the project settings a host launches a game with (`launchGame`'s `project`, ADR 0236),
// read from the project's files once for every host that runs a project's files as they are: the player (a build's
// files) and the dedicated server (a project folder). `project.json`'s values with `audio` set to `audio.json`'s runtime
// view (ADR 0344), the refusals a host stops on (a `project.json` that isn't an object, or still has the old `audio`
// section), and what audio.json says it can't do as notices the host may report.
//
// Hosts word a refusal for their surface (the player's page message, the server's `ServerError`), so it is returned,
// not thrown. Pure; no plugin, no DOM.
import type { ProjectSettingsInput } from "./core/settings";
import { LEGACY_AUDIO_MESSAGE, projectWithAudio } from "./audio/project/load";
import { AUDIO_PROJECT_FILE } from "./audio/project/types";

/** The project's settings file. */
const PROJECT_FILE = "project.json";

/** What a project's files give a launch. */
export type LaunchSettings =
  | {
      /** The Engine's project settings: `project.json`'s values with `audio` from `audio.json` (the default mix without one). */
      readonly project: ProjectSettingsInput;
      /** `audio.json`'s parse problems and what the runtime can't play of its mix, each a sentence naming the file. */
      readonly notices: readonly string[];
      readonly refusal?: undefined;
    }
  | {
      /** Why the project can't launch, a sentence about `project.json`; the host stops with it. */
      readonly refusal: string;
    };

/**
 * The launch settings from a project's files, by project path as asset values (ADR 0254: `project.json` and `audio.json`
 * parsed). A project without `project.json` launches with empty settings; one whose `project.json` isn't an object, or
 * still has an `audio` section (the editor migrates it, ADR 0344), is refused.
 */
export function launchSettings(files: { get(path: string): unknown }): LaunchSettings {
  const value = files.get(PROJECT_FILE);
  const projectJson = value === undefined ? {} : value;
  if (typeof projectJson !== "object" || projectJson === null || Array.isArray(projectJson)) return { refusal: `${PROJECT_FILE} must hold an object of project settings.` };
  const read = projectWithAudio(projectJson, files.get(AUDIO_PROJECT_FILE));
  if (read.legacyAudio) return { refusal: LEGACY_AUDIO_MESSAGE };
  return { project: read.project, notices: [...read.problems, ...read.warnings].map((line) => `${AUDIO_PROJECT_FILE}: ${line}`) };
}
