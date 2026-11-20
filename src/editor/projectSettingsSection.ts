// The Project panel's project section (ADR 0038, 0151): the `project.json` keys the shell's categories and
// the registered settings sections own, as one draft with one undo history. Saves
// reload the graphics tiers, re-apply plugins turned on or off, and refresh the project's name; renaming an entry of a
// named list (a sorting layer, a section's physics layers or buses) renames what names it, and undo and redo move
// those references with it (ADR 0262).
import type { GraphicsSettings } from "../engine/core/graphics";
import { errorStatus } from "./messages";
import { createProjectSection, type ProjectSection } from "./projectSection";
import { disabledPluginsOf, graphicsOf, settingsKeys, settingsProblems, sortingLayersOf, type SettingsDraft, type SettingsProblem } from "./projectSettingsModel";
import { nameReferences, projectSettingsSections, type NamedList } from "./sdk/contributions";
import { settingsNames, withReferences } from "./settingsNames";
import { docVersion, status } from "./state";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

/** What a save changes outside `project.json`, given by the panel (the running editor's graphics and plugins). */
export interface ProjectSettingsHooks {
  /** The saved graphics tiers, for the running editor. */
  graphicsSaved?(graphics: GraphicsSettings): void;
  /** Plugins were turned on or off: they take effect live (ADR 0133). */
  pluginsChanged?(): void;
  /** Ask before renaming a list entry that files name (the editor's confirm dialog); resolves true to go ahead. Absent: go ahead. */
  confirm?(question: ConfirmOptions): Promise<boolean>;
}

/** The shell's own named list: sprites' (and any component's) `sortingLayer` names a sorting layer. */
const SORTING_LAYERS: NamedList = { id: "render.sortingLayers", noun: "sorting layer", names: sortingLayersOf, fields: [{ field: "sortingLayer" }] };

/** Every named list: the shell's and the registered sections', each with the references other plugins declare for it. */
function namedLists(): NamedList[] {
  const lists = [SORTING_LAYERS, ...projectSettingsSections.list().flatMap((s) => s.names ?? [])];
  const extra = nameReferences.list();
  return lists.map((list) => withReferences(list, extra.filter((r) => r.list === list.id)));
}

export function createProjectSettingsSection(hooks: ProjectSettingsHooks = {}): ProjectSection<SettingsDraft, SettingsProblem> {
  const names = settingsNames({ lists: namedLists, confirm: (q) => hooks.confirm?.(q) ?? Promise.resolve(true) });
  return createProjectSection<SettingsDraft, SettingsProblem>({
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
    editing: names.editing,
    moved(project, before, after) {
      void names.moved(project, before, after).then(
        (done) => {
          if (done.length === 0) return;
          docVersion.value++;
          status.value = { kind: "info", text: `Renamed references in ${done.length} file${done.length === 1 ? "" : "s"}.` };
        },
        (err) => void (status.value = errorStatus("Couldn't update the files that use the renamed entry", err)),
      );
    },
  });
}
