// Third-party plugins (ADR 0139): manifests, SDK ranges, discovery in plugins/ and npm packages,
// checks and order, enabling, loading through the script loader, game builds and the server. All
// through the one plan every host runs (`planPluginCode`, ADR 0275).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../engine/core/registry";
import { loadScripts, loadedScriptModule } from "../editor/scriptLoader";
import { planWebBuild } from "../export/webBuild";
import { loadProjectCode as loadServerCode, readProject } from "../server/project";
import { FIRST_PARTY_MANIFESTS } from "./catalogue";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { isRuntimePluginActive, runtimeActivator } from "./runtimeContext";
import { SDK_VERSION, planPluginCode, satisfies, toRuntimePlugin, type PluginFiles, type ThirdPartyManifest } from "./thirdParty";

const FIXTURE = resolve(__dirname, "fixtures/spinner-project");

/** The fixture project as hosts read it: JSON texts and code (scripts and plugin sources) by project path. */
function readFixture(dir = FIXTURE): { json: Map<string, string>; code: Map<string, string>; files: string[] } {
  const json = new Map<string, string>();
  const code = new Map<string, string>();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const path = relative(dir, full).split(sep).join("/");
        files.push(path);
        if (path.endsWith(".json")) json.set(path, readFileSync(full, "utf8"));
        else if (path.endsWith(".ts")) code.set(path, readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return { json, code, files: files.sort() };
}

const manifest = (over: Partial<ThirdPartyManifest> & { name: string }): ThirdPartyManifest => ({ version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", ...over });
const entries = (folder: string) => [`plugins/${folder}/runtime/index.ts`, `plugins/${folder}/editor/index.ts`];
/** What the plan makes of a project plugin whose plugin.json holds `raw`: its manifest, or null and every problem. */
async function readManifest(raw: unknown): Promise<{ manifest: ThirdPartyManifest | null; problems: string[] }> {
  const plan = await planPluginCode({ json: new Map([["plugins/p/plugin.json", JSON.stringify(raw)]]), code: new Map(entries("p").map((e) => [e, ""])) }, { editor: true });
  return { manifest: plan.found[0]?.manifest ?? null, problems: plan.problems.flatMap((p) => p.message.split("; ")) };
}
/** A project holding these plugins, each in `plugins/<its name>/` with its entries, and these scripts. */
function projectOf(manifests: readonly ThirdPartyManifest[], scripts: readonly string[] = []): { json: Map<string, string>; code: Map<string, string> } {
  const json = new Map(manifests.map((m) => [`plugins/${m.name}/plugin.json`, JSON.stringify(m)]));
  const code = new Map([...scripts, ...manifests.flatMap((m) => entries(m.name))].map((path) => [path, ""]));
  return { json, code };
}

describe("SDK version ranges", () => {
  it("matches npm's range syntax", () => {
    expect(satisfies("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfies("1.9.3", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.3.1", "^0.3.0")).toBe(true);
    expect(satisfies("0.4.0", "^0.3.0")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("1.5.0", ">=1.2 <2")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2 <2")).toBe(false);
    expect(satisfies("3.1.0", "^1.0.0 || ^3.0.0")).toBe(true);
    expect(satisfies("1.4.0", "1.x")).toBe(true);
    expect(satisfies("7.0.0", "*")).toBe(true);
    expect(satisfies("1.5.0", "1.2.3 - 1.6.0")).toBe(true);
    expect(satisfies("1.0.0", "not a range")).toBe(null);
    expect(satisfies("1.0", "^1.0.0")).toBe(null);
  });

  it("is the engine's version", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("plugin.json validation", () => {
  it("reads the fixture's manifest", async () => {
    const { manifest: m, problems } = await readManifest(JSON.parse(readFixture().json.get("plugins/spinner/plugin.json")!));
    expect(problems).toEqual([]);
    expect(m).toMatchObject({ name: "acme.spinner", version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", editor: "editor/index.ts" });
    expect(m!.assetKinds).toEqual([expect.objectContaining({ id: "spin", extensions: [".spin.json"], label: "Spin Preset" })]);
  });

  it("lists every problem", async () => {
    const { manifest: m, problems } = await readManifest({ name: "Bad Name", version: "1", sdk: "nope", dependencies: { x: 3 }, server: "no", assetKinds: [{ id: "k", extensions: ["json"], label: "K", icon: "M0 0" }] });
    expect(m).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"name" must be lower case'),
        expect.stringContaining('"version" must be a semver version'),
        expect.stringContaining('"sdk" must be a semver range'),
        expect.stringContaining('needs a "runtime" or an "editor" entry'),
        expect.stringContaining('dependency "x"'),
        expect.stringContaining('"server" must be true or false'),
        expect.stringContaining('assetKinds[0]: "extensions"'),
      ]),
    );
  });

  it("reserves myco. for first-party plugins and keeps entries inside the plugin", async () => {
    expect((await readManifest(manifest({ name: "myco.spinner" }))).problems).toEqual([expect.stringContaining('can\'t start with "myco."')]);
    expect((await readManifest(manifest({ name: "a", runtime: "../x.ts" }))).problems).toEqual([expect.stringContaining("inside the plugin")]);
    expect((await readManifest("{}")).problems).toEqual(["plugin.json must hold an object"]);
  });
});

describe("animationNodes (ADR 0370, T45t)", () => {
  const nodesOnly = (animationNodes: unknown) => ({ name: "acme", version: "1.0.0", sdk: "^1.0.0", animationNodes });
  const plan = (raw: unknown, assets?: string[]) =>
    planPluginCode({ json: new Map([["plugins/acme/plugin.json", JSON.stringify(raw)]]), code: new Map(), ...(assets && { assets }) }, { editor: true });

  it("reads the node modules with their budgets; a plugin may have nothing else", async () => {
    const p = await plan(nodesOnly([{ module: "nodes/sway.wasm", budget: 5000 }, { module: "./nodes/ik.wasm" }]), ["plugins/acme/nodes/sway.wasm", "plugins/acme/nodes/ik.wasm"]);
    expect(p.problems).toEqual([]);
    expect(p.plugins[0]!.manifest.animationNodes).toEqual([
      { module: "nodes/sway.wasm", budget: 5000 },
      { module: "nodes/ik.wasm", budget: 1_000_000 },
    ]);
    expect(p.plugins[0]!.warnings).toBeUndefined();
  });

  it("is lenient: bad entries and budgets are warnings, never a refusal, and missing module files are warned", async () => {
    const p = await plan(nodesOnly([{ module: "nodes/sway.wasm", budget: -1 }, { module: "/abs.wasm" }, { module: "nodes/gone.wasm" }]), ["plugins/acme/nodes/sway.wasm"]);
    expect(p.problems).toEqual([]);
    expect(p.plugins.map((x) => x.manifest.name)).toEqual(["acme"]);
    expect(p.plugins[0]!.manifest.animationNodes!.map((m) => m.module)).toEqual(["nodes/sway.wasm", "nodes/gone.wasm"]);
    expect(p.plugins[0]!.warnings).toEqual([
      expect.stringContaining("animationNodes[0].budget"),
      expect.stringContaining("animationNodes[1].module"),
      "its animation node module plugins/acme/nodes/gone.wasm doesn't exist; its nodes pass their input through",
    ]);
    // A section that isn't a list is a warning; with nothing else, the plugin is still accepted (it declared the section).
    const odd = await plan(nodesOnly("nodes/sway.wasm"));
    expect(odd.problems).toEqual([]);
    expect(odd.plugins[0]!.manifest.animationNodes).toBeUndefined();
    expect(odd.plugins[0]!.warnings).toEqual([expect.stringContaining("must be a list")]);
  });
});

describe("componentCategories (ADR 0447)", () => {
  const plan = (componentCategories: unknown) =>
    planPluginCode({ json: new Map([["plugins/acme/plugin.json", JSON.stringify(manifest({ name: "acme", componentCategories } as never))]]), code: new Map([["plugins/acme/runtime/index.ts", ""]]) }, { editor: true });

  it("reads the Add Component submenus of the plugin's Components", async () => {
    const p = await plan({ Rendering: ["acme.Spinner"], Acme: ["acme.Wobble"] });
    expect(p.problems).toEqual([]);
    expect(p.plugins[0]!.manifest.componentCategories).toEqual({ Rendering: ["acme.Spinner"], Acme: ["acme.Wobble"] });
    expect(p.plugins[0]!.warnings).toBeUndefined();
  });

  it("is lenient: a bad section or entry is a warning, never a refusal", async () => {
    const p = await plan({ Rendering: ["acme.Spinner"], "": ["acme.X"], Bad: "acme.Y" });
    expect(p.problems).toEqual([]);
    expect(p.plugins[0]!.manifest.componentCategories).toEqual({ Rendering: ["acme.Spinner"] });
    expect(p.plugins[0]!.warnings).toEqual([expect.stringContaining('componentCategories ""'), expect.stringContaining('componentCategories "Bad"')]);
    const odd = await plan(["acme.Spinner"]);
    expect(odd.plugins[0]!.manifest.componentCategories).toBeUndefined();
    expect(odd.plugins[0]!.warnings).toEqual([expect.stringContaining('"componentCategories" must be an object')]);
  });
});

describe("discovery", () => {
  it("finds plugins/<folder>/plugin.json with its entries", async () => {
    const { json, code } = readFixture();
    const { found, problems } = await planPluginCode({ json, code }, { editor: true });
    expect(problems).toEqual([]);
    expect(found).toEqual([
      expect.objectContaining({
        source: { kind: "project", folder: "plugins/spinner" },
        where: "plugins/spinner/plugin.json",
        runtime: "plugins/spinner/runtime/index.ts",
        editor: "plugins/spinner/editor/index.ts",
      }),
    ]);
  });

  it("refuses a manifest that doesn't parse, and entries that are missing or in the wrong half", async () => {
    const json = new Map([
      ["plugins/broken/plugin.json", "{ nope"],
      ["plugins/missing/plugin.json", JSON.stringify(manifest({ name: "acme.missing" }))],
      ["plugins/swapped/plugin.json", JSON.stringify(manifest({ name: "acme.swapped", runtime: "editor/index.ts" }))],
    ]);
    const { found, problems } = await planPluginCode({ json, code: new Map([["plugins/swapped/editor/index.ts", ""]]) }, { editor: true });
    expect(found).toEqual([]);
    expect(problems.map((p) => [p.plugin, p.message])).toEqual([
      ["plugins/broken/plugin.json", expect.stringContaining("isn't valid JSON")],
      ["acme.missing", "its runtime entry plugins/missing/runtime/index.ts doesn't exist"],
      ["acme.swapped", expect.stringContaining("can't be inside the editor/ folder")],
    ]);
  });

  it("finds npm packages whose package.json marks them as plugins", async () => {
    const files = new Map<string, string>([
      ["node_modules/acme-npm/package.json", JSON.stringify({ name: "acme-npm", myco: { plugin: "plugin.json" } })],
      ["node_modules/acme-npm/plugin.json", JSON.stringify(manifest({ name: "acme.npm", runtime: "dist/runtime.js", editor: "dist/editor.js" }))],
      ["node_modules/acme-npm/dist/runtime.js", "export function activate() {}"],
      ["node_modules/acme-npm/dist/editor.js", "export function activate() {}"],
      ["node_modules/lodash-es/package.json", JSON.stringify({ name: "lodash-es" })],
      ["node_modules/acme-bad/package.json", JSON.stringify({ name: "acme-bad", myco: { plugin: "nowhere.json" } })],
    ]);
    const json = new Map([["package.json", JSON.stringify({ dependencies: { "acme-npm": "^1.0.0", "lodash-es": "^4" }, devDependencies: { "acme-bad": "1.0.0", "not-installed": "1.0.0" } })]]);
    const packages: PluginFiles = { read: async (p) => files.get(p) ?? null };
    const build = await planPluginCode({ json, code: new Map(), packages }, { editor: false });
    expect(build.found).toEqual([expect.objectContaining({ source: { kind: "npm", package: "acme-npm" }, runtime: "acme-npm/dist/runtime.js", editor: "acme-npm/dist/editor.js" })]);
    expect(build.problems).toEqual([expect.objectContaining({ where: "node_modules/acme-bad/nowhere.json", message: expect.stringContaining("isn't there") })]);
    expect(build.npmEntries).toEqual(["acme-npm/dist/runtime.js"]);
    expect((await planPluginCode({ json, code: new Map(), packages }, { editor: true })).npmEntries).toEqual(["acme-npm/dist/runtime.js", "acme-npm/dist/editor.js"]);
    expect((await planPluginCode({ json, code: new Map(), packages, disabled: ["acme.npm"] }, { editor: true })).npmEntries).toEqual([]);
  });

  it("makes a discovery that fails a problem, not a throw", async () => {
    const json = new Map([["package.json", JSON.stringify({ dependencies: { "acme-npm": "^1.0.0" } })]]);
    const plan = await planPluginCode({ json, code: new Map(), packages: { read: () => Promise.reject(new Error("disk gone")) } }, { editor: true });
    expect(plan.found).toEqual([]);
    expect(plan.problems).toEqual([{ plugin: "(plugins)", where: "plugins/", message: "couldn't look for plugins: disk gone" }]);
  });
});

describe("checks and order", () => {
  it("refuses a plugin whose SDK range the engine doesn't meet", async () => {
    const { plugins, problems } = await planPluginCode(projectOf([manifest({ name: "acme.future", sdk: "^2.0.0" })]), { editor: false });
    expect(plugins).toEqual([]);
    expect(problems).toEqual([expect.objectContaining({ plugin: "acme.future", message: `acme.future needs Myco SDK ^2.0.0; this is ${SDK_VERSION}` })]);
  });

  it("orders by dependencies, first-party ones included, and refuses what can't be satisfied", async () => {
    const project = projectOf([
      manifest({ name: "acme.c", dependencies: { "acme.b": "^1.0.0", "myco.physics": "*" } }),
      manifest({ name: "acme.b", dependencies: { "acme.a": "1.x" } }),
      manifest({ name: "acme.a" }),
      manifest({ name: "acme.old", dependencies: { "acme.a": "^2.0.0" } }),
      manifest({ name: "acme.lonely", dependencies: { "acme.nowhere": "*" } }),
      manifest({ name: "acme.needslonely", dependencies: { "acme.lonely": "*" } }),
      manifest({ name: "acme.x", dependencies: { "acme.y": "*" } }),
      manifest({ name: "acme.y", dependencies: { "acme.x": "*" } }),
    ]);
    // A second acme.a, in a folder found after the first one's.
    project.json.set("plugins/zz-copy/plugin.json", JSON.stringify(manifest({ name: "acme.a" })));
    project.code.set("plugins/zz-copy/runtime/index.ts", "");
    const { plugins, problems } = await planPluginCode(project, { editor: false });
    expect(plugins.map((p) => p.manifest.name)).toEqual(["acme.a", "acme.b", "acme.c"]);
    const why = Object.fromEntries(problems.map((p) => [p.plugin, p.message]));
    expect(why).toEqual({
      "acme.old": "acme.old needs acme.a ^2.0.0; the installed one is 1.0.0",
      "acme.lonely": "acme.lonely needs the plugin acme.nowhere, which isn't installed",
      "acme.needslonely": "acme.needslonely needs acme.lonely, which has a problem",
      "acme.x": "dependency cycle: acme.x → acme.y → acme.x",
      "acme.y": "dependency cycle: acme.x → acme.y → acme.x",
      "acme.a": "another plugin named acme.a was found first, at plugins/acme.a/plugin.json",
    });
  });
});

describe("enabling", () => {
  const a = manifest({ name: "acme.a", editor: "editor/index.ts" });
  const b = manifest({ name: "acme.b", dependencies: { "acme.a": "*" } });
  const p = manifest({ name: "acme.p", dependencies: { "myco.physics": "*" } });
  const all = (disabled: string[]) => resolveEnabledPlugins([...FIRST_PARTY_MANIFESTS, a, b, p], disabled);

  it("defaults third-party plugins on, and turns off dependents of disabled plugins, first-party ones included", () => {
    expect([...all([])].filter((n) => n.startsWith("acme."))).toEqual(["acme.a", "acme.b", "acme.p"]);
    expect([...all(["acme.a"])].filter((n) => n.startsWith("acme."))).toEqual(["acme.p"]);
    expect([...all(["myco.physics"])].filter((n) => n.startsWith("acme."))).toEqual(["acme.a", "acme.b"]);
  });

  it("loads only enabled plugins' files, and their editor folders only in the editor", async () => {
    const project = projectOf([a, b], ["scripts/main.ts"]);
    project.code.delete("plugins/acme.b/editor/index.ts");
    project.code.set("plugins/stray/runtime/index.ts", ""); // no valid plugin here
    const keys = async (options: { editor: boolean }, disabled: string[] = []) => [...(await planPluginCode({ ...project, disabled }, options)).code.keys()].sort();
    expect(await keys({ editor: true })).toEqual(["plugins/acme.a/editor/index.ts", "plugins/acme.a/runtime/index.ts", "plugins/acme.b/runtime/index.ts", "scripts/main.ts"]);
    expect(await keys({ editor: false })).toEqual(["plugins/acme.a/runtime/index.ts", "plugins/acme.b/runtime/index.ts", "scripts/main.ts"]);
    expect(await keys({ editor: true }, ["acme.a"])).toEqual(["scripts/main.ts"]);
  });

  it("plans the same plugins for the editor and a build; only the editor halves' files differ", async () => {
    const project = projectOf([a, b, p], ["scripts/main.ts"]);
    for (const disabled of [[], ["acme.a"], ["myco.physics"]]) {
      const editor = await planPluginCode({ ...project, disabled }, { editor: true });
      const build = await planPluginCode({ ...project, disabled }, { editor: false });
      const names = (list: readonly { manifest: { name: string } }[]) => list.map((x) => x.manifest.name);
      expect(names(editor.plugins)).toEqual(names(build.plugins));
      expect(names(editor.loaded)).toEqual(names(build.loaded));
      expect(names(editor.runtime)).toEqual(names(build.runtime));
      expect([...editor.enabled]).toEqual([...build.enabled]);
      expect(editor.problems).toEqual(build.problems);
      expect([...editor.code.keys()].filter((k) => !k.includes("/editor/"))).toEqual([...build.code.keys()]);
    }
  });
});

describe("loading through the script loader", () => {
  afterEach(() => runtimeActivator.deactivate("acme.spinner"));

  it("compiles a plugin's runtime half like scripts and activates it: its Component is claimed, and unregistered on deactivation", async () => {
    const { json, code } = readFixture();
    const plan = await planPluginCode({ json, code }, { editor: false });
    expect(plan.problems).toEqual([]);
    expect([...plan.code.keys()].sort()).toEqual(["plugins/spinner/runtime/index.ts", "scripts/useSpinner.ts"]);
    const result = await loadScripts(plan.code, json);
    expect(result.problems).toEqual([]);
    const spinner = plan.runtime[0]!;
    const module = await loadedScriptModule(spinner.runtime!);
    runtimeActivator.activate(toRuntimePlugin(spinner.manifest, spinner.runtime!, module));
    expect(isRuntimePluginActive("acme.spinner")).toBe(true);
    expect(getComponentClass("acme.Spinner")).toBe(module.Spinner);
    expect(((await loadedScriptModule("scripts/useSpinner.ts")) as { defaultSpeed: number }).defaultSpeed).toBe(90);
    runtimeActivator.deactivate("acme.spinner");
    expect(getComponentClass("acme.Spinner")).toBeUndefined();
  });

  it("keeps runtime code away from the editor half and myco/editor", async () => {
    const result = await loadScripts(
      new Map([
        ["plugins/p/runtime/a.ts", 'import { activatePlugins } from "myco/editor";\nexport const x = activatePlugins;\n'],
        ["plugins/p/runtime/b.ts", 'import { y } from "../editor/y";\nexport const z = y;\n'],
        ["plugins/p/editor/y.ts", "export const y = 1;\n"],
        ["scripts/s.ts", 'export { y } from "../plugins/p/editor/y";\n'],
      ]),
    );
    const why = Object.fromEntries(result.problems.map((p) => [p.path, p.message]));
    expect(why["plugins/p/runtime/a.ts"]).toContain('can\'t import "myco/editor"');
    expect(why["plugins/p/runtime/b.ts"]).toContain("is in a plugin's editor half");
    expect(why["scripts/s.ts"]).toContain("is in a plugin's editor half");
  });

  it("refuses an entry that exports no activate()", () => {
    expect(() => toRuntimePlugin(manifest({ name: "acme.none" }), "plugins/acme.none/runtime/index.ts", {})).toThrow("acme.none: its runtime entry (plugins/acme.none/runtime/index.ts) exports no activate(context) function");
  });
});

describe("game builds", () => {
  const source = (settings: Record<string, unknown> = {}) => {
    const { json, code, files } = readFixture();
    json.set("project.json", JSON.stringify({ name: "Spinner fixture", ...settings }));
    return { name: "spinner", settings, files, scripts: code, json };
  };

  it("include the enabled plugins' runtime halves, never their editor halves", async () => {
    const plan = await planWebBuild(source());
    expect(plan.manifest.plugins).toEqual([{ manifest: expect.objectContaining({ name: "acme.spinner" }), module: "code/plugins/spinner/runtime/index.js" }]);
    expect(plan.manifest.scripts.map((s) => s.source).sort()).toEqual(["plugins/spinner/runtime/index.ts", "scripts/useSpinner.ts"]);
    expect([...plan.generated.keys()].filter((p) => p.includes("/editor/"))).toEqual([]);
    expect(plan.generated.get("code/plugins/spinner/runtime/index.js")).toContain("acme.Spinner");
  });

  it("leave a disabled plugin out (and fail on a script that still imports it)", async () => {
    const settings = { plugins: { disabled: ["acme.spinner"] } };
    const s = source(settings);
    s.scripts.delete("scripts/useSpinner.ts");
    const plan = await planWebBuild(s);
    expect(plan.manifest.plugins).toBeUndefined();
    expect(plan.manifest.scripts).toEqual([]);
    await expect(planWebBuild(source(settings))).rejects.toThrow("can't find");
  });

  it("warm only the assets the built code names: not a disabled plugin's, never an editor half's (ADR 0080, 0329)", async () => {
    const withRefs = (settings: Record<string, unknown> = {}) => {
      const s = source(settings);
      s.scripts.set("plugins/spinner/runtime/presets.ts", `export const fast = "prefabs/fast.prefab.json";\n`);
      s.scripts.set("plugins/spinner/editor/preview.ts", `export const preview = "prefabs/preview.prefab.json";\n`);
      return { ...s, files: [...s.files, "prefabs/fast.prefab.json", "prefabs/preview.prefab.json"] };
    };
    expect((await planWebBuild(withRefs())).manifest.assetRefs).toEqual(["prefabs/fast.prefab.json"]);
    const off = withRefs({ plugins: { disabled: ["acme.spinner"] } });
    off.scripts.delete("scripts/useSpinner.ts");
    expect((await planWebBuild(off)).manifest.assetRefs).toBeUndefined();
  });

  it("stop on a refused plugin", async () => {
    const s = source();
    s.json.set("plugins/spinner/plugin.json", JSON.stringify(manifest({ name: "acme.spinner", sdk: "^9.0.0" })));
    await expect(planWebBuild(s)).rejects.toThrow("acme.spinner needs Myco SDK ^9.0.0");
  });
});

describe("the dedicated server", () => {
  afterEach(() => runtimeActivator.deactivate("acme.spinner"));

  it("loads enabled runtime halves", async () => {
    const project = await readProject(FIXTURE);
    expect([...project.scripts.keys()].sort()).toEqual(["plugins/spinner/editor/index.ts", "plugins/spinner/runtime/index.ts", "scripts/useSpinner.ts"]);
    const { loaded, plugins } = await loadServerCode(project);
    expect(loaded).not.toContain("plugins/spinner/editor/index.ts");
    expect(plugins.map((p) => p.manifest.name)).toEqual(["acme.spinner"]);
  });

  it("skips plugins whose manifest says server: false", async () => {
    const { json, code } = readFixture();
    const drawOnly = { ...JSON.parse(json.get("plugins/spinner/plugin.json")!), server: false } as PluginManifest;
    json.set("plugins/spinner/plugin.json", JSON.stringify(drawOnly));
    const server = await planPluginCode({ json, code }, { editor: false, server: true });
    expect(server.runtime).toEqual([]);
    expect([...server.code.keys()]).toEqual(["scripts/useSpinner.ts"]);
    const build = await planPluginCode({ json, code }, { editor: false });
    expect(build.runtime.map((p) => p.manifest.name)).toEqual(["acme.spinner"]);
  });
});
