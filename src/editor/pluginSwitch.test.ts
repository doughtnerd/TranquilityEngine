import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultHistoryPlatform } from "./historyPersistence";
import type { PluginManifest } from "../plugins/manifest";
import { openTypes } from "./layout/model";
import { applyDefaultLayout, refreshSavedLayouts, saveLayoutAs, savedLayouts } from "./layout/savedStore";
import { layout } from "./layout/store";
import { switchPlugin, type PluginSwitchAnswer, type PluginSwitchQuestion } from "./pluginSwitch";
import type { SettingsDraft } from "./projectSettingsModel";
import { closeTestProject, openTestProject, useBuiltinPanels } from "./testing";

useBuiltinPanels();

const m = (name: string, title: string, ...deps: string[]): PluginManifest => ({ name, title, version: "1.0.0", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) });
// Tools <- Graph <- Graph Extras, and an unrelated Sky.
const manifests = [m("acme.tools", "Tools"), m("acme.graph", "Graph", "acme.tools"), m("acme.extras", "Graph Extras", "acme.graph"), m("acme.sky", "Sky")];

/** Show a panel of `plugin` in the working layout, remembered as that plugin's (as a layout saved while it was on). */
function showPluginPanel(type: string, plugin: string) {
  const l = structuredClone(layout.value);
  const id = crypto.randomUUID();
  l.instances[id] = { type };
  l.docks[0]!.groups[0]!.panels.push(id);
  l.panelInfo[type] = { title: type, plugin, pluginTitle: plugin };
  layout.value = l;
}

/** Run a switch with scripted answers; returns what it asked, what it edited and whether it went through. */
async function run(draft: SettingsDraft, name: string, on: boolean, answers: PluginSwitchAnswer[] = []) {
  const asked: PluginSwitchQuestion[] = [];
  const edits: { label: string; next: SettingsDraft }[] = [];
  const done = await switchPlugin({
    manifests,
    draft,
    name,
    on,
    ask: async (q) => (asked.push(q), answers.shift() ?? { proceed: false }),
    edit: (label, next) => edits.push({ label, next }),
  });
  return { done, asked, edits };
}

beforeEach(async () => {
  const storage = (await defaultHistoryPlatform()).userStorage; // the editor's own: in-memory under Node
  for (const key of await storage.list("settings")) await storage.delete("settings", key);
  await refreshSavedLayouts(null);
  applyDefaultLayout();
});
afterEach(() => {
  closeTestProject();
  applyDefaultLayout();
});

describe("switchPlugin (ADR 0133, 0174)", () => {
  it("turns a plugin on with what it needs, without asking, in one edit", async () => {
    const r = await run({ plugins: { disabled: ["acme.tools", "acme.graph", "acme.sky"] } }, "acme.graph", true);
    expect(r.done).toBe(true);
    expect(r.asked).toEqual([]);
    expect(r.edits).toEqual([{ label: "Enable plugin Graph and Tools", next: { plugins: { disabled: ["acme.sky"] } } }]);
  });

  it("turns off a plugin nothing needs and no layout shows without asking; the last one off clears the section on", async () => {
    expect((await run({}, "acme.sky", false)).edits).toEqual([{ label: "Disable plugin Sky", next: { plugins: { disabled: ["acme.sky"] } } }]);
    const back = await run({ plugins: { disabled: ["acme.sky"] } }, "acme.sky", true);
    expect(back.edits).toEqual([{ label: "Enable plugin Sky", next: { plugins: undefined } }]);
  });

  it("asks before turning off the enabled plugins that need it, and turns them off too", async () => {
    const r = await run({ plugins: { disabled: ["acme.extras"] } }, "acme.tools", false, [{ proceed: true }]);
    expect(r.asked).toEqual([{ kind: "dependents", plugin: "acme.tools", dependents: ["acme.graph"] }]); // Extras is already off
    expect(r.edits).toEqual([{ label: "Disable plugin Tools", next: { plugins: { disabled: ["acme.extras", "acme.tools", "acme.graph"] } } }]);
  });

  it("changes nothing when the dependents question is cancelled", async () => {
    showPluginPanel("acme.graphView", "acme.graph");
    const r = await run({}, "acme.tools", false, [{ proceed: false }]);
    expect(r).toMatchObject({ done: false, edits: [] });
    expect(r.asked.map((q) => q.kind)).toEqual(["dependents"]);
    expect(openTypes(layout.value)).toContain("acme.graphView");
  });

  it("asks about the layouts showing panels of every plugin turning off; kept, the panels stay", async () => {
    showPluginPanel("acme.graphView", "acme.graph");
    const r = await run({}, "acme.tools", false, [{ proceed: true }, { proceed: true, removePanels: false }]);
    expect(r.asked[1]).toEqual({
      kind: "layouts",
      plugin: "acme.tools",
      turningOff: ["acme.tools", "acme.graph", "acme.extras"],
      layouts: [{ file: null, name: "Current layout", types: ["acme.graphView"], writable: true }],
    });
    expect(r.edits.map((e) => e.label)).toEqual(["Disable plugin Tools"]);
    expect(openTypes(layout.value)).toContain("acme.graphView");
  });

  it("removes the panels from the working layout and saves layouts as a new version when asked", async () => {
    await openTestProject();
    showPluginPanel("acme.graphView", "acme.graph");
    const file = (await saveLayoutAs("Graphing", ["project"]))!;
    const r = await run({}, "acme.graph", false, [{ proceed: true }, { proceed: true, removePanels: true }]);
    expect(r.asked.map((q) => (q.kind === "layouts" ? q.layouts.map((l) => l.name) : q.dependents))).toEqual([["acme.extras"], ["Current layout", "Graphing"]]);
    expect(r.edits).toEqual([{ label: "Disable plugin Graph", next: { plugins: { disabled: ["acme.graph", "acme.extras"] } } }]);
    expect(openTypes(layout.value)).not.toContain("acme.graphView");
    const saved = savedLayouts.value.find((s) => s.file === file)!;
    expect(saved.newest.versions.at(-1)!.label).toBe("Removed Graph, Graph Extras panels");
  });

  it("changes nothing, layouts included, when the layouts question is cancelled", async () => {
    showPluginPanel("acme.skyView", "acme.sky");
    const r = await run({}, "acme.sky", false, [{ proceed: false }]);
    expect(r).toMatchObject({ done: false, edits: [] });
    expect(r.asked.map((q) => q.kind)).toEqual(["layouts"]);
    expect(openTypes(layout.value)).toContain("acme.skyView");
  });

  it("reads old names of renamed plugins as the new ones", async () => {
    const physics = [m("myco.physics", "Physics")];
    const edits: string[][] = [];
    await switchPlugin({ manifests: physics, draft: { plugins: { disabled: ["myco.physics2d"] } }, name: "myco.physics", on: true, ask: async () => ({ proceed: false }), edit: (_l, next) => edits.push(next.plugins?.disabled ?? []) });
    expect(edits).toEqual([[]]);
  });
});
