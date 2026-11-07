// A project's own theme (ADR 0116): `.myco/theme.json` in the project folder, in the same format as
// an exported theme file. While the project is open it replaces the user's theme (unless the user
// chose to keep their own); the user's settings aren't touched. Reading is best-effort: a missing,
// unreadable or invalid file means "no project theme".
import { effect } from "@preact/signals";
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projectPaths";
import { currentProject } from "./state";
import { projectTheme, type ThemePreset } from "./theme";
import { parseThemeFile, PROJECT_THEME_PATH, serializeThemeFile, toThemeFile } from "./themeFile";

interface ThemeFolder {
  root: string | null;
  fileSystem: FileSystem | null;
}

/** The project's theme from its folder (null: none, or unreadable). */
export async function readProjectTheme(project: ThemeFolder): Promise<ThemePreset | null> {
  const { root, fileSystem: fs } = project;
  if (!root || !fs) return null;
  try {
    const path = joinPath(root, PROJECT_THEME_PATH);
    if (!(await fs.exists(path))) return null;
    return parseThemeFile(await fs.readText(path)).theme;
  } catch {
    return null;
  }
}

/** Make `preset` (with the user's overrides applied) the project's theme, writing `.myco/theme.json`. */
export async function writeProjectTheme(project: ThemeFolder, preset: ThemePreset, overrides?: Partial<Record<string, unknown>> | null): Promise<ThemePreset> {
  const { root, fileSystem: fs } = project;
  if (!root || !fs) throw new Error("This project has no folder to keep a theme in.");
  await fs.mkdir(joinPath(root, ".myco"));
  const file = toThemeFile(preset, overrides);
  await fs.writeText(joinPath(root, PROJECT_THEME_PATH), serializeThemeFile(file));
  const read = parseThemeFile(serializeThemeFile(file)).theme!;
  projectTheme.value = read;
  return read;
}

/** Delete the project's theme file. */
export async function removeProjectTheme(project: ThemeFolder): Promise<void> {
  const { root, fileSystem: fs } = project;
  projectTheme.value = null;
  if (!root || !fs) return;
  const path = joinPath(root, PROJECT_THEME_PATH);
  if (await fs.exists(path)) await fs.remove(path);
}

/** Load the open project's theme whenever the project changes. Returns a function that stops. */
export function installProjectTheme(): () => void {
  let token = 0;
  return effect(() => {
    const project = currentProject.value;
    const mine = ++token;
    projectTheme.value = null;
    if (!project) return;
    void readProjectTheme(project).then((t) => {
      if (mine === token) projectTheme.value = t;
    });
  });
}
