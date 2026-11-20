// Settings names (ADR 0262): renaming an entry of a named list (a physics layer, a sorting layer, a bus, an acoustic
// material, a parameter) renames what names it. Settings sections declare their lists as data (`NamedList`: where the
// names live in the draft, and the component fields, asset files and other settings that name them); this module does
// the rest for any list. It tells a rename from the drafts before and after an edit, undo or redo; finds the users in
// scenes, prefabs (overrides too), the open scene and asset files; asks first when there are any; puts the settings
// references into the draft that is pushed; and rewrites the files (on disk at once, the open scene as one undo step).
// The project section calls it through two hooks (`editing`, `moved`), so every edit route renames references.
import type { SceneFile } from "./document";
import { editProjectFiles, projectFileUsers, type ProjectFileEdit } from "./projectFileEdits";
import type { SettingsDraft } from "./projectSettingsModel";
import type { EditorProject } from "./projects";
import type { NamedList, NameField, NameReferences } from "./sdk/contributions";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

/** One entry of a named list renamed. */
export interface NameRename {
  readonly list: NamedList;
  readonly from: string;
  readonly to: string;
}

export interface SettingsNamesOptions {
  /** The named lists, each with every reference declared for it (`withReferences`). Asked on each use. */
  lists(): readonly NamedList[];
  /** Ask whether to go ahead (the editor's confirm dialog); resolves true to rename and update. */
  confirm(question: ConfirmOptions): Promise<boolean>;
}

export interface SettingsNames {
  /**
   * Before an edit moves the draft from `before` to `next`: the draft to push (`next` with the renamed entries' settings
   * references renamed too), or null when the user cancels. Asks first (a promise) only when files name a renamed entry.
   */
  editing(project: EditorProject, before: SettingsDraft, next: SettingsDraft): SettingsDraft | null | Promise<SettingsDraft | null>;
  /**
   * After an edit, undo or redo moved the draft from `before` to `after`: rewrite the files that name a renamed entry
   * (an undone rename renames them back). Resolves to the files updated (the open scene as "<path> (unsaved)").
   */
  moved(project: EditorProject, before: SettingsDraft, after: SettingsDraft): Promise<string[]>;
}

/** `list` with `extra` references added (another plugin's fields, files or settings that name its entries). */
export function withReferences(list: NamedList, extra: readonly NameReferences[]): NamedList {
  if (extra.length === 0) return list;
  const all = [list, ...extra];
  const settings = all.flatMap((r) => (r.settings ? [r.settings] : []));
  return {
    ...list,
    fields: all.flatMap((r) => r.fields ?? []),
    assets: all.flatMap((r) => r.assets ?? []),
    settings: settings.length > 0 ? (draft, from, to) => settings.reduce((d, rename) => rename(d, from, to), draft) : undefined,
  };
}

const unique = (names: readonly string[]) => names.every((n) => typeof n === "string" && n.trim() !== "") && new Set(names).size === names.length;

/**
 * The renames that turn `before` into `after`: for each list, one of the same length with exactly one name changed,
 * unique and non-empty on both sides. Adds, removes, reorders and duplicate names are not renames.
 */
function renamesBetween(lists: readonly NamedList[], before: SettingsDraft, after: SettingsDraft): NameRename[] {
  const out: NameRename[] = [];
  for (const list of lists) {
    const a = list.names(before), b = list.names(after);
    if (a === b || a.length !== b.length || !unique(a) || !unique(b)) continue;
    const changed = a.flatMap((name, i) => (name !== b[i] ? [i] : []));
    if (changed.length === 1) out.push({ list, from: a[changed[0]], to: b[changed[0]] });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` with `from` renamed `to` at `path` (`*` steps into every list item): the same value when nothing there is `from`. */
function renamedAt(value: unknown, path: readonly string[], from: string, to: string): unknown {
  if (path.length === 0) return value === from ? to : value;
  const [head, ...rest] = path;
  if (head === "*") {
    if (!Array.isArray(value)) return value;
    const next = value.map((item) => renamedAt(item, rest, from, to));
    return next.some((item, i) => item !== value[i]) ? next : value;
  }
  if (!isRecord(value) || !(head in value)) return value;
  const inner = renamedAt(value[head], rest, from, to);
  return inner === value[head] ? value : { ...value, [head]: inner };
}

const appliesTo = (field: NameField, type: unknown) =>
  typeof type === "string" && (field.component === undefined || (typeof field.component === "string" ? field.component === type : field.component.includes(type)));

/** A scene or prefab file (or the open scene's document) with the renames applied to the declared component fields and their prefab overrides; null when unchanged. */
function renamedScene(file: SceneFile, renames: readonly NameRename[]): SceneFile | null {
  const fields = renames.flatMap((r) => (r.list.fields ?? []).map((field) => ({ field, path: field.field.split("."), from: r.from, to: r.to })));
  if (fields.length === 0) return null;
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const next = v.map(walk);
      return next.some((x, i) => x !== v[i]) ? next : v;
    }
    if (!isRecord(v)) return v;
    let out = v;
    const set = (key: string, value: unknown) => {
      if (value === out[key]) return;
      if (out === v) out = { ...v };
      out[key] = value;
      changed = true;
    };
    for (const [k, x] of Object.entries(v)) set(k, walk(x));
    for (const { field, path, from, to } of fields) {
      // A component entry: { type, data }.
      if (isRecord(out.data) && appliesTo(field, out.type)) set("data", renamedAt(out.data, path, from, to));
      // A prefab override: { target, component, field, value }.
      if (out.field === path[0] && "value" in out && appliesTo(field, out.component)) set("value", renamedAt(out.value, path.slice(1), from, to));
    }
    return out;
  };
  const next = walk(file) as SceneFile;
  return changed ? next : null;
}

/** An asset file (by path) with the renames its format's declarations apply; null when unchanged. */
function renamedAsset(json: unknown, path: string, renames: readonly NameRename[]): unknown {
  const lower = path.toLowerCase();
  let value = json;
  for (const r of renames) for (const asset of r.list.assets ?? []) if (asset.extensions.some((e) => lower.endsWith(e))) value = asset.rename(value, r.from, r.to);
  return value === json ? null : value;
}

/** The project file edit that applies `renames` (project.json is the draft's, so it's left alone). */
const fileEdit = (renames: readonly NameRename[]): ProjectFileEdit => ({
  mentioned: (text) => renames.some((r) => text.includes(JSON.stringify(r.from))),
  scene: (file) => renamedScene(file, renames),
  settings: () => null,
  json: (json, path) => renamedAsset(json, path, renames),
});

const withSettingsReferences = (draft: SettingsDraft, renames: readonly NameRename[]): SettingsDraft =>
  renames.reduce((d, r) => (r.list.settings ? r.list.settings(d, r.from, r.to) : d), draft);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The confirm dialog for renames that files name (the physics layer rename's, ADR 0116). */
function question(renames: readonly NameRename[], users: readonly string[]): ConfirmOptions {
  const [first] = renames;
  const what = renames.length === 1 ? `the ${first.list.noun} "${first.from}" to "${first.to}"` : renames.map((r) => `the ${r.list.noun} "${r.from}" to "${r.to}"`).join(" and ");
  return {
    title: renames.length === 1 ? `Rename ${first.list.noun}` : "Rename",
    message: `Rename ${what}? ${plural(users.length, "A file uses it; it will be updated.", `${users.length} files use ${renames.length === 1 ? "it" : "them"}; they will be updated.`)}`,
    items: users.slice(0, 8).concat(users.length > 8 ? [`and ${users.length - 8} more`] : []),
    confirmLabel: "Rename and update",
    danger: false,
  };
}

export function settingsNames(options: SettingsNamesOptions): SettingsNames {
  return {
    editing(project, before, next) {
      const renames = renamesBetween(options.lists(), before, next);
      if (renames.length === 0) return next;
      const pushed = withSettingsReferences(next, renames);
      const users = projectFileUsers(project, fileEdit(renames));
      if (users.length === 0) return pushed;
      return options.confirm(question(renames, users)).then((ok) => (ok ? pushed : null));
    },
    moved(project, before, after) {
      const renames = renamesBetween(options.lists(), before, after);
      if (renames.length === 0) return Promise.resolve([]);
      const [r] = renames;
      return editProjectFiles(project, fileEdit(renames), renames.length === 1 ? `Rename ${r.list.noun} ${r.from} to ${r.to}` : "Rename settings names");
    },
  };
}
