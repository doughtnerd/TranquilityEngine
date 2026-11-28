// The first-party catalogue (ADR 0275): one entry per plugin folder, and both halves' lists carry the
// catalogue's manifests, so every host plans against the plugins it activates.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMenuTree } from "../editor/componentCategories";
import { componentCatalog } from "../editor/componentEdits";
import { getComponentClass } from "../engine/core/registry";
import * as myco from "../myco";
import { FIRST_PARTY, FIRST_PARTY_MANIFESTS } from "./catalogue";
import { EDITOR_PLUGINS } from "./editor";
import { RUNTIME_PLUGINS } from "./runtime";
import { pluginOfComponent } from "./runtimeContext";

/** Each plugin's public runtime surface (ADR 0447), by path. */
const PUBLIC_MODULES = import.meta.glob<Record<string, unknown>>("./*/runtime/public.ts", { eager: true });
/** Navigation code is frozen (CLAUDE.md): `myco.ts` lists its names itself until it has a public module. */
const FROZEN = new Set(["navigation"]);

describe("the first-party catalogue", () => {
  it("has an entry for every plugin folder, keyed by the folder, named after it", () => {
    const folders = readdirSync(__dirname).filter((d) => {
      try {
        return statSync(join(__dirname, d, "manifest.ts")).isFile();
      } catch {
        return false;
      }
    });
    expect(Object.keys(FIRST_PARTY).sort()).toEqual(folders.sort());
    for (const [folder, manifest] of Object.entries(FIRST_PARTY)) expect(manifest.name).toBe(`myco.${folder}`);
  });

  it("gives every entry its runtime half, in catalogue order, and editor halves only for its entries", () => {
    expect(RUNTIME_PLUGINS.map((p) => p.manifest)).toEqual(FIRST_PARTY_MANIFESTS);
    RUNTIME_PLUGINS.forEach((p, i) => expect(p.manifest).toBe(FIRST_PARTY_MANIFESTS[i]));
    for (const p of EDITOR_PLUGINS) expect(FIRST_PARTY_MANIFESTS).toContain(p.manifest);
    expect(new Set(EDITOR_PLUGINS.map((p) => p.manifest.name)).size).toBe(EDITOR_PLUGINS.length);
  });
});

// Adding a plugin is its catalogue entry plus what lives in its own folder (ADR 0447): this walk is what catches a
// Component left out of the Add Component menu's categories or a plugin whose public names never reach `myco`.
describe("every first-party plugin, walked from the catalogue", () => {
  const catalog = componentCatalog();
  const mycoNames = myco as Record<string, unknown>;
  const mycoValues = new Set(Object.values(mycoNames));
  for (const [folder, manifest] of Object.entries(FIRST_PARTY)) {
    it(`${folder}: its Components have Add Component categories, and its public names and Components reach myco`, () => {
      const claimed = catalog.filter((t) => pluginOfComponent(t.id) === manifest.name);
      expect(claimed.filter((t) => buildMenuTree([t], new Map())[0]!.label === "Other").map((t) => t.id)).toEqual([]);
      // The manifest names only Components the plugin registers (a typo or a rename shows here).
      expect(Object.values(manifest.componentCategories ?? {}).flat().filter((id) => pluginOfComponent(id) !== manifest.name)).toEqual([]);

      const pub = PUBLIC_MODULES[`./${folder}/runtime/public.ts`];
      if (claimed.length > 0 && !FROZEN.has(folder)) expect(pub, `${folder} registers Components but has no runtime/public.ts`).toBeDefined();
      for (const [name, value] of Object.entries(pub ?? {})) expect(mycoNames[name], `myco.${name}`).toBe(value);
      expect(claimed.filter((t) => !mycoValues.has(getComponentClass(t.id))).map((t) => t.id)).toEqual([]);
    });
  }

  it("leaves no public module outside the catalogue", () => {
    const folders = Object.keys(PUBLIC_MODULES).map((p) => p.split("/")[1]!);
    expect(folders.filter((f) => !(f in FIRST_PARTY))).toEqual([]);
    expect(folders.length).toBeGreaterThan(10);
  });
});
