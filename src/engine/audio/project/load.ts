/**
 * Internal (ADR 0330): the Engine's project settings from a project's files. `project.json` holds no audio any more:
 * the `audio` settings the Engine runs with are `audio.json`'s runtime view (`toRuntimeSettings`). The player, the
 * dedicated server and the exporter read a project through this; the editor's projects compose the same view
 * (`src/editor/projects.ts`). A `project.json` that still has an `audio` section is refused here (`legacyAudio`): the
 * editor migrates it when the project opens.
 *
 * Pure; no plugin, no DOM.
 */
import type { ProjectSettingsInput } from "../../core/settings";
import type { AudioParseOptions } from "../settings";
import { parseAudioProject, toRuntimeSettings } from "./format";
import { AUDIO_PROJECT_FILE } from "./types";

/** What a runtime or an export says of a `project.json` that still has the old `audio` section. */
export const LEGACY_AUDIO_MESSAGE =
  `project.json still has an "audio" section, which moved to ${AUDIO_PROJECT_FILE} (ADR 0330). Open the project in the editor once: it migrates the section (keeping a copy of the old project.json in .myco/migrated/).`;

/** True when `projectJson` (parsed) still has the old `audio` section. */
export const hasLegacyAudio = (projectJson: unknown): boolean =>
  typeof projectJson === "object" && projectJson !== null && Object.prototype.hasOwnProperty.call(projectJson, "audio");

export interface ProjectWithAudio {
  /** `project.json`'s values with `audio` set to `audio.json`'s runtime view (absent without `audio.json`: the default mix). */
  readonly project: ProjectSettingsInput;
  /** `project.json` still has the old section: it was left out, and the host refuses the project (`LEGACY_AUDIO_MESSAGE`). */
  readonly legacyAudio: boolean;
  /** `audio.json`'s parse problems, each a sentence. */
  readonly problems: readonly string[];
  /** What the runtime can't play of the mix yet (`toRuntimeSettings`' warnings). */
  readonly warnings: readonly string[];
}

/** The Engine's settings from `project.json` (parsed) and `audio.json` (parsed, or undefined when the project has none). */
export function projectWithAudio(projectJson: unknown, audioJson: unknown, options: AudioParseOptions = {}): ProjectWithAudio {
  const legacyAudio = hasLegacyAudio(projectJson);
  const rest: Record<string, unknown> = typeof projectJson === "object" && projectJson !== null && !Array.isArray(projectJson) ? { ...(projectJson as Record<string, unknown>) } : {};
  delete rest.audio;
  if (audioJson === undefined) return { project: rest as ProjectSettingsInput, legacyAudio, problems: [], warnings: [] };
  const { project, problems } = parseAudioProject(audioJson, options);
  const warnings: string[] = [];
  const audio = toRuntimeSettings(project, warnings) as unknown as Record<string, unknown>;
  return { project: { ...rest, audio } as ProjectSettingsInput, legacyAudio, problems, warnings };
}
