// The first-party catalogue (ADR 0275): one entry per plugin folder, and both halves' lists carry the
// catalogue's manifests, so every host plans against the plugins it activates.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_PARTY, FIRST_PARTY_MANIFESTS } from "./catalogue";
import { EDITOR_PLUGINS } from "./editor";
import { RUNTIME_PLUGINS } from "./runtime";

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
