// The project's audio in the editor (ADR 0330, decision D2): `audio.json` at the project root holds the mix, and the
// editor's legacy audio panels (Project Settings > Audio, the Mixer) keep editing it through the old section shape.
//
// - `settingsWithAudio`: what `EditorProject.settings` serves: `project.json`'s values with `audio` set to `audio.json`'s
//   runtime view (`toRuntimeSettings`), the old section shape the panels, the settings draft and Play read.
// - The settings section's `audio` key is saved to `audio.json`, not `project.json` (`fileOfKey`): `audioFileText`
//   merges the edited old-shape value into what `audio.json` holds (`mergeLegacyIntoProject`, which keeps what the old
//   shape can't express), and `sectionValueJson` compares `audio` values by what they mean, not how they're written.
// - `migrateLegacyAudio`: a project whose `project.json` still has an `audio` section is migrated when it opens:
//   `audio.json` is written, the section leaves `project.json`, and the old `project.json` is kept in `.myco/migrated/`.
import type { ProjectSettingsInput } from "../engine";
import { audioSection } from "../engine/audio/audioSection";
import { audioProjectToJson, defaultAudioProject, parseAudioProject } from "../engine/audio/project/format";
import { fromLegacySection, mergeLegacyIntoProject } from "../engine/audio/project/legacy";
import { hasLegacyAudio, projectWithAudio } from "../engine/audio/project/load";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../engine/audio/project/types";
import type { FileSystem } from "../engine/platform/FileSystem";
import { withMember } from "./jsonMember";
import { PROJECT_FILE, joinPath } from "./projectPaths";

/** The settings key the audio panels edit: saved to `audio.json`. */
export const AUDIO_KEY = "audio";
/** Where `migrateLegacyAudio` keeps the `project.json` it migrated. */
export const MIGRATED_FOLDER = ".myco/migrated";

/** The file a project-settings key is saved in. */
export const fileOfKey = (key: string): string => (key === AUDIO_KEY ? AUDIO_PROJECT_FILE : PROJECT_FILE);

/**
 * `project.json`'s values (parsed) with `audio` from `audio.json` (parsed, or undefined): its runtime view. Without
 * `audio.json`, `project.json` as it is (a project not migrated yet, such as a read-only one, keeps its old section).
 */
export function settingsWithAudio(projectJson: unknown, audioJson: unknown): ProjectSettingsInput {
  if (audioJson === undefined) return (projectJson ?? {}) as ProjectSettingsInput;
  return projectWithAudio(projectJson, audioJson).project;
}

/** A settings value as JSON for comparing: `audio` by its parse (so a value and the view it saves to compare equal), others as written. */
export function sectionValueJson(key: string, value: unknown): string {
  return (key === AUDIO_KEY ? JSON.stringify(audioSection(value).settings) : JSON.stringify(value)) ?? "";
}

/** `audio.json`'s text for `project`: the editor's JSON layout, one top-level key per line. */
export function audioProjectText(project: AudioProject): string {
  const json = audioProjectToJson(project);
  return Object.keys(json).reduce((text, key) => withMember(text, key, json[key]), "{\n}\n");
}

/** What a project's files hold of its audio (enough to read the mix: `assets` and the parsed `settings`). */
export interface AudioFiles {
  readonly assets: { has(path: string): boolean; get(path: string): unknown };
  readonly settings: ProjectSettingsInput;
}

/** The mix the project holds now: `audio.json`, else the old section of a project not migrated yet, else the default. */
export function currentAudioProject(files: AudioFiles): AudioProject {
  if (files.assets.has(AUDIO_PROJECT_FILE)) return parseAudioProject(files.assets.get(AUDIO_PROJECT_FILE)).project;
  const legacy = (files.settings as { audio?: unknown }).audio;
  return legacy !== undefined ? fromLegacySection(legacy) : defaultAudioProject();
}

/** `audio.json`'s text once the old-shape `legacy` value (the settings draft's `audio`) is written into the mix (decision D2). */
export function audioFileText(files: AudioFiles, legacy: unknown): string {
  return audioProjectText(mergeLegacyIntoProject(currentAudioProject(files), legacy));
}

/** The texts of the files the settings sections write, together: a change to either is a change to the sections' files. */
export const sectionFilesText = (textOf: (path: string) => string | undefined): string | undefined => {
  const project = textOf(PROJECT_FILE), audio = textOf(AUDIO_PROJECT_FILE);
  return project === undefined && audio === undefined ? undefined : `${project ?? ""}\u0000${audio ?? ""}`;
};

/**
 * `project.json`'s text migrated (ADR 0330): `audio.json`'s text from its `audio` section, and `project.json`'s text
 * without it; null when it has no section (or isn't JSON). `problems` are the old section's parse problems.
 */
export function migrateProjectText(projectText: string): { projectText: string; audioText: string; problems: string[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(projectText);
  } catch {
    return null;
  }
  if (!hasLegacyAudio(value)) return null;
  const problems: string[] = [];
  const project = fromLegacySection((value as { audio: unknown }).audio, problems);
  return { projectText: withMember(projectText, AUDIO_KEY, undefined), audioText: audioProjectText(project), problems };
}

/**
 * Migrate the project folder at `root` if its `project.json` still has an `audio` section: keep the old `project.json`
 * in `.myco/migrated/`, write `audio.json` from the section (unless the project already has one, which wins), and
 * take the section out of `project.json`. Returns whether it migrated; a folder that can't be written is left alone.
 */
export async function migrateLegacyAudio(fs: FileSystem, root: string, log: (line: string) => void = (line) => console.info(line)): Promise<boolean> {
  if (!fs.canWrite) return false;
  const projectPath = joinPath(root, PROJECT_FILE);
  const text = await fs.readText(projectPath);
  const migrated = migrateProjectText(text);
  if (!migrated) return false;
  await fs.mkdir(joinPath(root, MIGRATED_FOLDER));
  let backup = `${MIGRATED_FOLDER}/${PROJECT_FILE}`;
  for (let n = 2; await fs.exists(joinPath(root, backup)); n++) backup = `${MIGRATED_FOLDER}/project.${n}.json`;
  await fs.writeText(joinPath(root, backup), text);
  const audioPath = joinPath(root, AUDIO_PROJECT_FILE);
  const kept = await fs.exists(audioPath);
  if (!kept) await fs.writeText(audioPath, migrated.audioText);
  await fs.writeText(projectPath, migrated.projectText);
  log(
    `[editor] ADR 0330: moved project.json's audio section ${kept ? `out (the project's ${AUDIO_PROJECT_FILE} already holds the mix)` : `to ${AUDIO_PROJECT_FILE}`}; the old project.json is in ${backup}.` +
      (migrated.problems.length > 0 ? ` The old section had problems: ${migrated.problems.join(" ")}` : ""),
  );
  return true;
}
