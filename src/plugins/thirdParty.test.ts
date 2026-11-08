// Third-party plugins (ADR 0139): manifests, SDK ranges, discovery in plugins/ and npm packages,
// checks and order, enabling, loading through the script loader, game builds and the server.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../engine/core/registry";
import { loadScripts, loadedScriptModule } from "../editor/scriptLoader";
import { planWebBuild } from "../export/webBuild";
import { loadProjectCode as loadServerCode, readProject } from "../server/project";
import { resolveEnabledPlugins } from "./enabled";
import type { PluginManifest } from "./manifest";
import { FIRST_PARTY_MANIFESTS } from "./manifests";
import { activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive } from "./runtimeContext";
import {
  SDK_VERSION,
  checkPlugins,
  discoverPlugins,
  npmPluginEntries,
  parsePluginManifest,
  planPluginCode,
  satisfies,
  selectPluginCode,
  toRuntimePlugin,
  type FoundPlugin,
  type ThirdPartyManifest,
} from "./thirdParty";

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
const found = (m: ThirdPartyManifest): FoundPlugin => ({ manifest: m, source: { kind: "project", folder: `plugins/${m.name}` }, where: `plugins/${m.name}/plugin.json`, runtime: `plugins/${m.name}/runtime/index.ts` });

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

  it("lists every first-party plugin's manifest", () => {
    const dirs = readdirSync(__dirname).filter((d) => {
      try {
        return statSync(join(__dirname, d, "manifest.ts")).isFile();
      } catch {
        return false;
      }
    });
    expect(FIRST_PARTY_MANIFESTS.length).toBe(dirs.length);
  });
});

describe("plugin.json validation", () => {
  it("reads the fixture's manifest", () => {
    const { manifest: m, problems } = parsePluginManifest(JSON.parse(readFixture().json.get("plugins/spinner/plugin.json")!));
    expect(problems).toEqual([]);
    expect(m).toMatchObject({ name: "acme.spinner", version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", editor: "editor/index.ts" });
    expect(m!.assetKinds).toEqual([expect.objectContaining({ id: "spin", extensions: [".spin.json"], label: "Spin Preset" })]);
  });

  it("lists every problem", () => {
    const { manifest: m, problems } = parsePluginManifest({ name: "Bad Name", version: "1", sdk: "nope", dependencies: { x: 3 }, server: "no", assetKinds: [{ id: "k", extensions: ["json"], label: "K", icon: "M0 0" }] });
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

  it("reserves myco. for first-party plugins and keeps entries inside the plugin", () => {
    expect(parsePluginManifest(manifest({ name: "myco.spinner" })).problems).toEqual([expect.stringContaining('can\'t start with "myco."')]);
    expect(parsePluginManifest(manifest({ name: "a", runtime: "../x.ts" })).problems).toEqual([expect.stringContaining("inside the plugin")]);
    expect(parsePluginManifest("{}").problems).toEqual(["plugin.json must hold an object"]);
  });
});

describe("discovery", () => {
  it("finds plugins/<folder>/plugin.json with its entries", async () => {
    const { json, code } = readFixture();
    const { plugins, problems } = await discoverPlugins({ json, code: code.keys() });
    expect(problems).toEqual([]);
    expect(plugins).toEqual([
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
    const { plugins, problems } = await discoverPlugins({ json, code: ["plugins/swapped/editor/index.ts"] });
    expect(plugins).toEqual([]);
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
    const { plugins, problems } = await discoverPlugins({ json, code: [], packages: { read: async (p) => files.get(p) ?? null } });
    expect(plugins).toEqual([expect.objectContaining({ source: { kind: "npm", package: "acme-npm" }, runtime: "acme-npm/dist/runtime.js", editor: "acme-npm/dist/editor.js" })]);
    expect(problems).toEqual([expect.objectContaining({ where: "node_modules/acme-bad/nowhere.json", message: expect.stringContaining("isn't there") })]);
    expect(npmPluginEntries(plugins, new Set(["acme.npm"]), { editor: false })).toEqual(["acme-npm/dist/runtime.js"]);
    expect(npmPluginEntries(plugins, new Set(["acme.npm"]), { editor: true })).toEqual(["acme-npm/dist/runtime.js", "acme-npm/dist/editor.js"]);
  });
});

describe("checks and order", () => {
  it("refuses a plugin whose SDK range the engine doesn't meet", () => {
    const { plugins, problems } = checkPlugins([found(manifest({ name: "acme.future", sdk: "^2.0.0" }))], FIRST_PARTY_MANIFESTS, "1.0.0");
    expect(plugins).toEqual([]);
    expect(problems).toEqual([expect.objectContaining({ plugin: "acme.future", message: "acme.future needs Myco SDK ^2.0.0; this is 1.0.0" })]);
  });

  it("orders by dependencies, first-party ones included, and refuses what can't be satisfied", () => {
    const list = [
      found(manifest({ name: "acme.c", dependencies: { "acme.b": "^1.0.0", "myco.physics": "*" } })),
      found(manifest({ name: "acme.b", dependencies: { "acme.a": "1.x" } })),
      found(manifest({ name: "acme.a" })),
      found(manifest({ name: "acme.old", dependencies: { "acme.a": "^2.0.0" } })),
      found(manifest({ name: "acme.lonely", dependencies: { "acme.nowhere": "*" } })),
      found(manifest({ name: "acme.needslonely", dependencies: { "acme.lonely": "*" } })),
      found(manifest({ name: "acme.x", dependencies: { "acme.y": "*" } })),
      found(manifest({ name: "acme.y", dependencies: { "acme.x": "*" } })),
      found(manifest({ name: "myco.sky" })),
      found(manifest({ name: "acme.a" })),
    ];
    const { plugins, problems } = checkPlugins(list, FIRST_PARTY_MANIFESTS);
    expect(plugins.map((p) => p.manifest.name)).toEqual(["acme.a", "acme.b", "acme.c"]);
    const why = Object.fromEntries(problems.map((p) => [p.plugin, p.message]));
    expect(why).toEqual({
      "acme.old": "acme.old needs acme.a ^2.0.0; the installed one is 1.0.0",
      "acme.lonely": "acme.lonely needs the plugin acme.nowhere, which isn't installed",
      "acme.needslonely": "acme.needslonely needs acme.lonely, which has a problem",
      "acme.x": "dependency cycle: acme.x → acme.y → acme.x",
      "acme.y": "dependency cycle: acme.x → acme.y → acme.x",
      "myco.sky": "myco.sky is a first-party plugin's name",
      "acme.a": "another plugin named acme.a was found first, at plugins/acme.a/plugin.json",
    });
  });
});

describe("enabling", () => {
  const a = found(manifest({ name: "acme.a" }));
  const b = found(manifest({ name: "acme.b", dependencies: { "acme.a": "*" } }));
  const p = found(manifest({ name: "acme.p", dependencies: { "myco.physics": "*" } }));
  const all = (disabled: string[]) => resolveEnabledPlugins([...FIRST_PARTY_MANIFESTS, a.manifest, b.manifest, p.manifest], disabled);

  it("defaults third-party plugins on, and turns off dependents of disabled plugins, first-party ones included", () => {
    expect([...all([])].filter((n) => n.startsWith("acme."))).toEqual(["acme.a", "acme.b", "acme.p"]);
    expect([...all(["acme.a"])].filter((n) => n.startsWith("acme."))).toEqual(["acme.p"]);
    expect([...all(["myco.physics"])].filter((n) => n.startsWith("acme."))).toEqual(["acme.a", "acme.b"]);
  });

  it("loads only enabled plugins' files, and their editor folders only in the editor", () => {
    const code = new Map([
      ["scripts/main.ts", ""],
      ["plugins/acme.a/runtime/index.ts", ""],
      ["plugins/acme.a/editor/index.ts", ""],
      ["plugins/acme.b/runtime/index.ts", ""],
      ["plugins/stray/runtime/index.ts", ""], // no valid plugin here
    ]);
    expect([...selectPluginCode(code, [a, b], all([]), { editor: true }).keys()]).toEqual(["scripts/main.ts", "plugins/acme.a/runtime/index.ts", "plugins/acme.a/editor/index.ts", "plugins/acme.b/runtime/index.ts"]);
    expect([...selectPluginCode(code, [a, b], all([]), { editor: false }).keys()]).toEqual(["scripts/main.ts", "plugins/acme.a/runtime/index.ts", "plugins/acme.b/runtime/index.ts"]);
    expect([...selectPluginCode(code, [a, b], all(["acme.a"]), { editor: true }).keys()]).toEqual(["scripts/main.ts"]);
  });
});

describe("loading through the script loader", () => {
  afterEach(() => deactivateRuntimePlugin("acme.spinner"));

  it("compiles a plugin's runtime half like scripts and activates it: its Component is claimed, and unregistered on deactivation", async () => {
    const { json, code } = readFixture();
    const plan = await planPluginCode({ json, code, builtIn: FIRST_PARTY_MANIFESTS }, { editor: false });
    expect(plan.problems).toEqual([]);
    expect([...plan.code.keys()].sort()).toEqual(["plugins/spinner/runtime/index.ts", "scripts/useSpinner.ts"]);
    const result = await loadScripts(plan.code, json);
    expect(result.problems).toEqual([]);
    const spinner = plan.runtime[0]!;
    const module = await loadedScriptModule(spinner.runtime!);
    activateRuntimePlugins([toRuntimePlugin(spinner, module)], { provided: plan.enabled });
    expect(isRuntimePluginActive("acme.spinner")).toBe(true);
    expect(getComponentClass("acme.Spinner")).toBe(module.Spinner);
    expect(((await loadedScriptModule("scripts/useSpinner.ts")) as { defaultSpeed: number }).defaultSpeed).toBe(90);
    deactivateRuntimePlugin("acme.spinner");
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
    expect(() => toRuntimePlugin(found(manifest({ name: "acme.none" })), {})).toThrow("exports no activate(context) function");
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

  it("stop on a refused plugin", async () => {
    const s = source();
    s.json.set("plugins/spinner/plugin.json", JSON.stringify(manifest({ name: "acme.spinner", sdk: "^9.0.0" })));
    await expect(planWebBuild(s)).rejects.toThrow("acme.spinner needs Myco SDK ^9.0.0");
  });
});

describe("the dedicated server", () => {
  afterEach(() => deactivateRuntimePlugin("acme.spinner"));

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
    const server = await planPluginCode({ json, code, builtIn: FIRST_PARTY_MANIFESTS }, { editor: false, server: true });
    expect(server.runtime).toEqual([]);
    expect([...server.code.keys()]).toEqual(["scripts/useSpinner.ts"]);
    const build = await planPluginCode({ json, code, builtIn: FIRST_PARTY_MANIFESTS }, { editor: false });
    expect(build.runtime.map((p) => p.manifest.name)).toEqual(["acme.spinner"]);
  });
});
