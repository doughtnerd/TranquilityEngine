// The Project panel's project section (ADR 0038, 0151): the `project.json` keys the shell's categories and
// the registered settings sections own, as one draft with one undo history. Saves
// reload the graphics tiers, re-apply plugins turned on or off, and refresh the project's name; undoing or
// redoing a layer rename moves the scenes' references with it.
import type { GraphicsSettings } from "../engine/core/graphics";
import { layerRenamesBetween } from "./layerRename";
import { updateLayerReferences } from "./layerRenameEdit";
import { createProjectSection, type ProjectSection } from "./projectSection";
import { disabledPluginsOf, graphicsOf, settingsKeys, settingsProblems, type SettingsDraft } from "./projectSettingsModel";
import { docVersion } from "./state";

/** What a save changes outside `project.json`, given by the panel (the running editor's graphics and plugins). */
export interface ProjectSettingsHooks {
  /** The saved graphics tiers, for the running editor. */
  graphicsSaved?(graphics: GraphicsSettings): void;
  /** Plugins were turned on or off: they take effect live (ADR 0133). */
  pluginsChanged?(): void;
}

export function createProjectSettingsSection(hooks: ProjectSettingsHooks = {}): ProjectSection<SettingsDraft> {
  return createProjectSection<SettingsDraft>({
    name: "Project Settings",
    what: "the project settings",
    keys: settingsKeys,
    read: (values) => ({ ...values }) as SettingsDraft,
    write: (draft) => draft,
    problems: (draft, project) => settingsProblems(draft, project.files),
    // A plugin turned on: its keys join every state, so undo never drops them from the file.
    adopt: (draft, added) => ({ ...draft, ...added }),
    saved(_project, draft, before) {
      hooks.graphicsSaved?.(graphicsOf(draft));
      if (JSON.stringify(disabledPluginsOf(draft)) !== JSON.stringify(disabledPluginsOf(before))) hooks.pluginsChanged?.();
      docVersion.value++; // the toolbar shows the project's name
    },
    stepped(project, before, after) {
      const renames = layerRenamesBetween(before, after);
      if (renames.length > 0) void updateLayerReferences(project, renames);
    },
  });
}
