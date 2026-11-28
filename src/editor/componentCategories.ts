// How the Add Component menu groups types into submenus. A plugin's Components go where its manifest's
// `componentCategories` says (ADR 0447); the core's few built-in Components are categorised by the table below;
// scripts are grouped by their folder under scripts/; data components share one "Data" submenu.
import type { ComponentTypeInfo } from "../engine/editor";
import { pluginOfComponent, runtimePluginManifest } from "../plugins/runtimeContext";

const OTHER_CATEGORY = "Other";

/** Engine categories in menu order. Empty ones are left out of the menu; a plugin's own label comes after them, before Other. */
const ENGINE_CATEGORIES = ["Rendering", "Physics 2D", "Physics 3D", "Navigation", "Audio", "UI", "Animation", "Networking", "Input"] as const;

/** The category of each Component the core registers (no plugin claims it), by type id. */
const CORE: Readonly<Record<string, string>> = {
  "engine.Camera": "Rendering",
  "engine.LODGroup": "Rendering", // ADR 0446
  "engine.Light": "Rendering",
  "engine.Fog": "Rendering",
  "engine.ReflectionProbe": "Rendering",
  "engine.InputContext": "Input",
};

/** The category the manifest of the plugin that registers `id` gives it, if any. */
function pluginCategory(id: string): string | null {
  const plugin = pluginOfComponent(id);
  const categories = plugin === undefined ? undefined : runtimePluginManifest(plugin)?.componentCategories;
  for (const [category, ids] of Object.entries(categories ?? {})) if (ids.includes(id)) return category;
  // The Navigation plugin's code is frozen (CLAUDE.md), so its manifest can't list its Components yet: they go by
  // their `Nav` prefix until it does.
  if (plugin === "myco.navigation" && id.startsWith("engine.Nav")) return "Navigation";
  return null;
}

/** An item's category from its plugin's manifest or the core table, or null (scripts and data go by group). */
const declaredCategory = (id: string): string | null => pluginCategory(id) ?? CORE[id] ?? null;


/**
 * The folders under `scripts/` of the script that defines each id, found by looking for the id as
 * a string literal (`@behavior("game.Bird")`, `defineComponent("game.Scroller", …)`) in the
 * project's sources. Ids not found, or whose file is directly in scripts/, get no folders.
 */
function scriptFolders(ids: readonly string[], scripts: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    for (const [path, source] of scripts) {
      if (!source.includes(`"${id}"`) && !source.includes(`'${id}'`) && !source.includes(`\`${id}\``)) continue;
      const parts = path.replace(/^scripts\//, "").split("/");
      out.set(id, parts.slice(0, -1));
      break;
    }
  }
  return out;
}


/** A submenu: its label, the path of labels from the top, nested submenus and its types. */
export interface MenuNode<T extends ComponentTypeInfo = ComponentTypeInfo> {
  readonly label: string;
  readonly path: readonly string[];
  readonly children: MenuNode<T>[];
  readonly items: T[];
}

const node = <T extends ComponentTypeInfo>(label: string, parent: readonly string[]): MenuNode<T> => ({ label, path: [...parent, label], children: [], items: [] });

/**
 * The menu tree: one submenu per non-empty engine category (then plugins' own labels, then Other), then Scripts
 * (nested by folder, scripts directly in scripts/ beside the folders) and Data. A Component a plugin's manifest
 * categorises goes there whatever its group (a third-party plugin's `acme.Spinner` too). Items keep the catalog's
 * (name) order.
 */
export function buildMenuTree<T extends ComponentTypeInfo>(items: readonly T[], scripts: ReadonlyMap<string, string>): MenuNode<T>[] {
  const engine = new Map<string, MenuNode<T>>(ENGINE_CATEGORIES.map((c) => [c, node<T>(c, [])]));
  const other = node<T>(OTHER_CATEGORY, []);
  const scriptRoot = node<T>("Scripts", []);
  const data = node<T>("Data", []);
  const categories = new Map(items.map((i) => [i.id, declaredCategory(i.id)]));
  const folders = scriptFolders(
    items.filter((i) => i.group === "Scripts" && categories.get(i.id) === null).map((i) => i.id),
    scripts,
  );
  for (const item of items) {
    const category = categories.get(item.id) ?? null;
    if (category !== null) {
      // A declared label that names a fixed submenu (Other, Scripts, Data) joins it rather than making a second one.
      const fixed = category === OTHER_CATEGORY ? other : category === "Scripts" ? scriptRoot : category === "Data" ? data : null;
      let submenu = fixed ?? engine.get(category);
      if (!submenu) engine.set(category, (submenu = node<T>(category, [])));
      submenu.items.push(item);
    } else if (item.group === "Engine") other.items.push(item);
    else if (item.group === "Data") data.items.push(item);
    else {
      let at = scriptRoot;
      for (const folder of folders.get(item.id) ?? []) {
        let next = at.children.find((c) => c.label === folder);
        if (!next) {
          next = node<T>(folder, at.path);
          at.children.push(next);
        }
        at = next;
      }
      at.items.push(item);
    }
  }
  const sortFolders = (n: MenuNode<T>) => {
    n.children.sort((a, b) => a.label.localeCompare(b.label));
    n.children.forEach(sortFolders);
  };
  sortFolders(scriptRoot);
  return [...engine.values(), other, scriptRoot, data].filter((n) => n.items.length > 0 || n.children.length > 0);
}
