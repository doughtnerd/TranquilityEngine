import { describe, expect, it } from "vitest";
import { RUNTIME_SETTINGS, projectKeyOwner, projectSettingsIssues, projectSettingsKeys, sectionKeyConflict, type ProjectSettingsDraft, type SettingsSectionKeys } from "../core/settings";
import { buildSettingsProblems } from "../core/buildSettings";

// ADR 0446: the engine's settings module says which project.json keys exist, who owns each, and what's wrong with a
// whole draft of them, by field.

const problems = (draft: ProjectSettingsDraft, sections: readonly SettingsSectionKeys[] = [], files?: string[]) => projectSettingsIssues(draft, { sections, files }).problems;
const fields = (draft: ProjectSettingsDraft, sections: readonly SettingsSectionKeys[] = [], files?: string[]) => problems(draft, sections, files).map((p) => p.field);

/** A section that claims the keys and checks nothing itself, as a careless plugin's might. */
const claims = (id: string, keys: string[]): SettingsSectionKeys => ({ id, keys });

describe("project.json keys and their owners", () => {
  it("own every runtime key, build and bootstrap, and nothing else without a section", () => {
    for (const key of Object.keys(RUNTIME_SETTINGS)) expect(projectKeyOwner(key), key).toBeDefined();
    expect(["name", "display", "time", "render", "input", "autoload", "graphics", "plugins"].map((k) => projectKeyOwner(k))).toEqual(Array(8).fill("runtime"));
    expect(projectKeyOwner("build")).toBe("editor");
    expect(["physics", "lighting2D", "navigation", "languages", "subtitles"].map((k) => projectKeyOwner(k))).toEqual(Array(5).fill("section"));
    expect([projectKeyOwner("bootstrap"), projectKeyOwner("audio")]).toEqual(["reserved", "reserved"]);
    expect(projectKeyOwner("acme")).toBeUndefined();
    expect(projectKeyOwner("acme", [claims("acme", ["acme"])])).toBe("section");
  });

  it("list the Project panel's keys: its own, then the sections', never a reserved one or one twice", () => {
    expect(projectSettingsKeys()).toEqual(["name", "display", "time", "render", "input", "autoload", "graphics", "plugins", "build"]);
    expect(projectSettingsKeys([claims("physics", ["physics"]), claims("odd", ["audio", "bootstrap", "acme", "physics"])]).slice(9)).toEqual(["physics", "acme"]);
  });

  it("refuse a section that claims a key the panel, a reserved owner or another section has", () => {
    const acme = claims("acme", ["acme"]);
    expect(sectionKeyConflict(claims("x", ["display"]))).toMatch(/editor owns/);
    expect(sectionKeyConflict(claims("x", ["build"]))).toMatch(/editor owns/);
    expect(sectionKeyConflict(claims("x", ["bootstrap"]))).toMatch(/editor owns/);
    expect(sectionKeyConflict(claims("x", ["audio"]))).toMatch(/audio\.json/);
    expect(sectionKeyConflict(claims("x", ["acme"]), [acme])).toMatch(/section "acme" owns it/);
    expect(sectionKeyConflict(acme, [acme])).toBeUndefined();
    expect(sectionKeyConflict(claims("physics", ["physics"]))).toBeUndefined();
  });
});

describe("a draft's problems", () => {
  it("report a bad value in every key the panel edits, on that key's field, even when its section checks nothing itself", () => {
    const sections = (["physics", "lighting2D", "navigation", "languages", "subtitles", "acme"] as const).map((k) => claims(k, [k]));
    sections[5] = { id: "acme", keys: ["acme"], problems: (d) => (d.acme === 42 ? [{ field: "acme", message: "acme is wrong." }] : []) };
    const keys = projectSettingsKeys(sections);
    expect(keys).toHaveLength(15);
    for (const key of keys) {
      const found = fields({ [key]: 42 }, sections);
      expect(found.length, `a bad ${key}`).toBeGreaterThan(0);
      expect(found.every((f) => f === key || f.startsWith(`${key}.`)), `${key}: ${found.join(", ")}`).toBe(true);
    }
    expect(problems({}, sections)).toEqual([]);
  });

  it("check input by field: the join policy, max players and each action set file", () => {
    const input = { join: "everyone", maxPlayers: 0, actionSets: ["a.actions.json", "b.json", "a.actions.json"] };
    expect(fields({ input } as never)).toEqual(["input.join", "input.maxPlayers", "input.actionSets.1", "input.actionSets.2"]);
    expect(problems({ input: { join: "pressToJoin", maxPlayers: 2, actionSets: ["a.actions.json"] } })).toEqual([]);
  });

  it("check build with the exporter's rules, and the icon against the project's files", () => {
    expect(fields({ build: { identifier: "game", version: "1.0", icon: "icon.jpg" } })).toEqual(["build.identifier", "build.version", "build.icon"]);
    expect(problems({ build: { identifier: "com.example.game", version: "1.0.0", icon: "icon.png" } }, [], ["icon.png"])).toEqual([]);
    expect(problems({ build: { icon: "gone.png" } }, [], ["icon.png"])).toEqual([{ field: "build.icon", message: "gone.png isn't in the project." }]);
    expect(problems({ build: { icon: "./icon.png" } }, [], ["icon.png"])).toEqual([]);
    expect(buildSettingsProblems(undefined)).toEqual([]);
  });

  it("check autoloads against the project's files only when given them", () => {
    expect(fields({ autoload: ["a.prefab.json"] }, [], [])).toEqual(["autoload.0"]);
    expect(fields({ autoload: ["a.prefab.json"] })).toEqual([]);
  });

  it("leave a key no section owns unchecked, and give a section's problem the runtime section also gave once", () => {
    expect(problems({ physics: 42 } as never)).toEqual([]);
    const physics: SettingsSectionKeys = { id: "physics", keys: ["physics"], problems: (d) => RUNTIME_SETTINGS.physics.parse(d.physics).problems };
    expect(fields({ physics: { gravity: "down" } } as never, [physics])).toEqual(["physics.gravity"]);
  });

  it("warn about unknown plugins and a missing Default sorting layer without blocking a save", () => {
    const { problems: p, warnings } = projectSettingsIssues({ plugins: { disabled: ["gone"] }, render: { sortingLayers: ["Back"] } }, { knownPlugins: ["myco.sky"] });
    expect(p).toEqual([]);
    expect(warnings.map((w) => w.field).sort()).toEqual(["plugins", "render.sortingLayers"]);
  });
});
