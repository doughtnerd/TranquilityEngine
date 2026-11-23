// Optional dependencies (ADR 0374): ordering, the plugin set's failure, version and re-activation rules, the
// context's `plugins.isActive` on both halves, and third-party manifests. Everything runs through the modules'
// own interfaces: `orderPlugins`, `createPluginSet` with fake and real activators, `planPluginCode`.
import { afterEach, describe, expect, it } from "vitest";
import { activatePlugin, deactivatePlugin, type EditorPlugin } from "../editor/sdk/plugins";
import { editorActivator } from "./editorActivator";
import type { PluginManifest } from "./manifest";
import { orderPlugins } from "./order";
import { createPluginSet, type HalfActivator, type PluginHalf, type PluginsView, type SetPlugin } from "./pluginSet";
import { runtimeActivator, type RuntimePlugin } from "./runtimeContext";
import { planPluginCode, type ThirdPartyManifest } from "./thirdParty";

const m = (name: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({ name, version: "1.0.0", ...extra });
const names = (plugins: readonly { manifest: PluginManifest }[]) => plugins.map((p) => p.manifest.name);

describe("ordering", () => {
  it("puts an optional dependency first when it is listed", () => {
    const user = { manifest: m("user", { optionalDependencies: { audio: "*" } }) };
    const audio = { manifest: m("audio") };
    expect(names(orderPlugins([user, audio]))).toEqual(["audio", "user"]);
  });

  it("orders by the union of both lists", () => {
    const user = { manifest: m("user", { dependencies: { a: "*" }, optionalDependencies: { b: "*" } }) };
    const a = { manifest: m("a", { optionalDependencies: { c: "*" } }) };
    const b = { manifest: m("b") };
    const c = { manifest: m("c") };
    const order = names(orderPlugins([user, a, b, c]));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("user"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("user"));
  });

  it("ignores an optional dependency that isn't listed, where a dependency would throw", () => {
    expect(names(orderPlugins([{ manifest: m("user", { optionalDependencies: { audio: "*" } }) }]))).toEqual(["user"]);
    expect(() => orderPlugins([{ manifest: m("user", { dependencies: { audio: "*" } }) }])).toThrow(/needs audio/);
  });

  it("refuses a cycle through an optional dependency", () => {
    const a = { manifest: m("a", { optionalDependencies: { b: "*" } }) };
    const b = { manifest: m("b", { dependencies: { a: "*" } }) };
    expect(() => orderPlugins([a, b])).toThrow(/cycle: a → b → a/);
    const c = { manifest: m("c", { optionalDependencies: { d: "*" } }) };
    const d = { manifest: m("d", { optionalDependencies: { c: "*" } }) };
    expect(() => orderPlugins([c, d])).toThrow(/cycle/);
  });
});

/** Fake activators that log each activation with the optional dependencies the half saw as active. */
function harness(throws: { runtime?: string[]; editor?: string[] } = {}) {
  const log: string[] = [];
  const seen: Record<string, boolean | undefined> = {};
  const make = (kind: "runtime" | "editor"): HalfActivator => {
    const active = new Set<string>();
    return {
      activate(half, plugins?: PluginsView) {
        const name = half.manifest.name;
        if (active.has(name)) return;
        if (throws[kind]?.includes(name)) throw new Error("boom");
        active.add(name);
        const optional = Object.keys(half.manifest.optionalDependencies ?? {});
        optional.forEach((d) => (seen[`${kind}:${name}:${d}`] = plugins?.isActive(d)));
        log.push(`+${kind} ${name}${optional.length ? ` [${optional.filter((d) => plugins?.isActive(d)).join(",")}]` : ""}`);
      },
      deactivate(name) {
        if (active.delete(name)) log.push(`-${kind} ${name}`);
      },
      isActive: (name) => active.has(name),
    };
  };
  const set = createPluginSet({ runtime: make("runtime"), editor: make("editor") });
  return { log, seen, set };
}

const plugin = (manifest: PluginManifest, halves: Array<"runtime" | "editor"> = ["runtime"]): SetPlugin => {
  const half: PluginHalf = { manifest, activate: () => {} };
  return { manifest, ...(halves.includes("runtime") ? { runtime: half } : {}), ...(halves.includes("editor") ? { editor: half } : {}) };
};
const audio = (extra: Partial<PluginManifest> = {}) => m("t.audio", { title: "Audio", ...extra });
const anim = (range = "^1.0.0", extra: Partial<PluginManifest> = {}) => m("t.anim", { title: "Animation", optionalDependencies: { "t.audio": range }, ...extra });

describe("the plugin set and an optional dependency", () => {
  it("activates the dependency first, and the plugin sees it as active", () => {
    const { log, set } = harness();
    const result = set.apply({ plugins: [plugin(anim()), plugin(audio())] });
    expect(log).toEqual(["+runtime t.audio", "+runtime t.anim [t.audio]"]);
    expect(result.problems).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it("activates without a missing optional dependency, and warns about nothing", () => {
    const { log, set } = harness();
    const result = set.apply({ plugins: [plugin(anim())] });
    expect(log).toEqual(["+runtime t.anim []"]);
    expect(result).toMatchObject({ problems: [], notices: [] });
  });

  it("a disabled optional dependency is absent, and not a warning", () => {
    const { log, set } = harness();
    const result = set.apply({ plugins: [plugin(anim()), plugin(audio())], disabled: ["t.audio"] });
    expect(log).toEqual(["+runtime t.anim []"]);
    expect(result).toMatchObject({ problems: [], notices: [] });
  });

  it("a disabled plugin that has the optional dependency turned off doesn't turn off with it", () => {
    const { set } = harness();
    set.apply({ plugins: [plugin(anim()), plugin(audio())], disabled: ["t.audio"] });
    expect(set.isActive("t.anim")).toBe(true);
    expect(set.isActive("t.audio")).toBe(false);
  });

  it("a failed optional dependency doesn't block: the plugin activates without it and the notice says so", () => {
    const { log, set } = harness({ runtime: ["t.audio"] });
    const result = set.apply({ plugins: [plugin(anim()), plugin(audio())] });
    expect(log).toEqual(["+runtime t.anim []"]);
    expect(set.isActive("t.anim")).toBe(true);
    expect(result.problems).toEqual([{ plugin: "t.audio", where: "runtime", message: "t.audio failed to activate: boom" }]);
    expect(result.notices).toEqual([{ plugin: "t.anim", message: "Audio integration unavailable: t.audio failed" }]);
  });

  it("a hard dependency that failed still blocks", () => {
    const { set } = harness({ runtime: ["t.audio"] });
    const hard = m("t.hard", { dependencies: { "t.audio": "*" } });
    const result = set.apply({ plugins: [plugin(hard), plugin(audio())] });
    expect(set.isActive("t.hard")).toBe(false);
    expect(result.notices).toEqual([]);
  });

  it("a version outside the range counts as absent, with one warning naming both versions", () => {
    const { log, set } = harness();
    const result = set.apply({ plugins: [plugin(anim("^2.0.0"), ["runtime", "editor"]), plugin(audio(), ["runtime", "editor"])], host: { editor: true } });
    expect(log).toContain("+runtime t.anim []");
    expect(log).toContain("+editor t.anim []");
    expect(result.problems).toEqual([]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]!.plugin).toBe("t.anim");
    expect(result.notices[0]!.message).toContain("^2.0.0");
    expect(result.notices[0]!.message).toContain("1.0.0");
    expect(result.notices[0]!.message).toContain("t.audio");
  });

  it("a version inside the range is present", () => {
    const { log, set } = harness();
    set.apply({ plugins: [plugin(anim(">=1 <2")), plugin(audio({ version: "1.4.2" }))] });
    expect(log).toContain("+runtime t.anim [t.audio]");
  });

  it("activates again when the optional dependency is turned on, and again when it is turned off", () => {
    const { log, set } = harness();
    const plugins = [plugin(anim()), plugin(audio())];
    set.apply({ plugins, disabled: ["t.audio"] });
    log.length = 0;

    set.apply({ plugins, disabled: ["t.audio"] });
    expect(log).toEqual([]); // nothing changed: nothing re-activates

    set.apply({ plugins });
    expect(log).toEqual(["+runtime t.audio", "-runtime t.anim", "+runtime t.anim [t.audio]"]);
    log.length = 0;

    set.apply({ plugins });
    expect(log).toEqual([]);

    set.apply({ plugins, disabled: ["t.audio"] });
    expect(log).toEqual(["-runtime t.anim", "-runtime t.audio", "+runtime t.anim []"]);
  });

  it("activates again when the optional dependency leaves the plugin list, and when it comes back", () => {
    const { log, set } = harness();
    const user = plugin(anim());
    const dep = plugin(audio());
    set.apply({ plugins: [user, dep] });
    log.length = 0;
    set.apply({ plugins: [user] });
    expect(log).toEqual(["-runtime t.anim", "-runtime t.audio", "+runtime t.anim []"]);
    log.length = 0;
    set.apply({ plugins: [user, dep] });
    expect(log).toEqual(["+runtime t.audio", "-runtime t.anim", "+runtime t.anim [t.audio]"]);
  });

  it("re-activation also re-activates the plugins that need the dependent", () => {
    const { log, set } = harness();
    const top = m("t.top", { dependencies: { "t.anim": "*" } });
    const plugins = [plugin(top), plugin(anim()), plugin(audio())];
    set.apply({ plugins, disabled: ["t.audio"] });
    log.length = 0;
    set.apply({ plugins });
    expect(log).toEqual(["+runtime t.audio", "-runtime t.top", "-runtime t.anim", "+runtime t.anim [t.audio]", "+runtime t.top"]);
  });

  it("a plugin whose optional dependency keeps failing isn't re-activated each time", () => {
    const { log, set } = harness({ runtime: ["t.audio"] });
    const plugins = [plugin(anim()), plugin(audio())];
    set.apply({ plugins });
    log.length = 0;
    const again = set.apply({ plugins });
    expect(log).toEqual([]);
    expect(again.notices).toEqual([{ plugin: "t.anim", message: "Audio integration unavailable: t.audio failed" }]);
  });

  it("follows the same rules for editor halves: the dependency's runtime half counts, and toggling re-activates", () => {
    const { log, set } = harness();
    const plugins = [plugin(anim(), ["editor"]), plugin(audio(), ["runtime"])];
    set.apply({ plugins, host: { editor: true }, disabled: ["t.audio"] });
    expect(log).toEqual(["+editor t.anim []"]);
    log.length = 0;
    set.apply({ plugins, host: { editor: true } });
    expect(log).toEqual(["+runtime t.audio", "-editor t.anim", "+editor t.anim [t.audio]"]);
  });

  it("a runtime half doesn't see an optional dependency that only has an editor half", () => {
    const { log, set } = harness();
    set.apply({ plugins: [plugin(anim(), ["runtime", "editor"]), plugin(audio(), ["editor"])], host: { editor: true } });
    expect(log).toEqual(["+runtime t.anim []", "+editor t.audio", "+editor t.anim [t.audio]"]);
  });

  it("refuses a cycle through an optional dependency without throwing", () => {
    const { set } = harness();
    const a = m("t.a", { optionalDependencies: { "t.b": "*" } });
    const b = m("t.b", { dependencies: { "t.a": "*" } });
    const result = set.apply({ plugins: [plugin(a), plugin(b)] });
    expect(result.problems.map((p) => p.message).join(" ")).toMatch(/cycle/);
    expect(set.active()).toEqual([]);
  });
});

describe("ctx.plugins.isActive on the real contexts", () => {
  const seenBy: string[] = [];
  const cleanup: string[] = [];
  afterEach(() => {
    for (const n of cleanup.splice(0)) (runtimeActivator.deactivate(n), deactivatePlugin(n));
    seenBy.length = 0;
  });

  const runtime = (manifest: PluginManifest): RuntimePlugin => (cleanup.push(manifest.name), { manifest, activate: (ctx) => void seenBy.push(`${manifest.name}:${ctx.plugins.isActive("rt.audio")}`) });

  it("runtime: true when the optional dependency is active, false when absent, outside the range, or in a disabled plugin's stub", () => {
    const set = createPluginSet({ runtime: runtimeActivator });
    const audioPlugin = runtime(m("rt.audio"));
    const user = runtime(m("rt.user", { optionalDependencies: { "rt.audio": "^1.0.0" } }));
    const old = runtime(m("rt.old", { optionalDependencies: { "rt.audio": "^2.0.0" } }));
    const plugins = [{ manifest: user.manifest, runtime: user }, { manifest: old.manifest, runtime: old }, { manifest: audioPlugin.manifest, runtime: audioPlugin }];

    set.apply({ plugins, disabled: ["rt.audio"] });
    expect(seenBy.filter((s) => s.startsWith("rt.user") || s.startsWith("rt.old"))).toEqual(["rt.user:false", "rt.old:false"]);
    seenBy.length = 0;

    set.apply({ plugins });
    expect(seenBy).toContain("rt.user:true"); // re-activated now that rt.audio is on
    expect(seenBy).not.toContain("rt.old:true"); // outside ^2.0.0: still absent, so it didn't change and stays as it was
  });

  it("editor: the half reads the same through its own context", () => {
    const seen: Array<boolean> = [];
    const audioManifest = m("ed.audio");
    const user: EditorPlugin = { manifest: m("ed.user", { optionalDependencies: { "ed.audio": "*" } }), activate: (ctx) => void seen.push(ctx.plugins.isActive("ed.audio")) };
    const audioHalf: EditorPlugin = { manifest: audioManifest, activate: () => {} };
    cleanup.push("ed.user", "ed.audio");
    const set = createPluginSet({ editor: editorActivator });
    const plugins = [{ manifest: user.manifest, editor: user }, { manifest: audioManifest, editor: audioHalf }];
    set.apply({ plugins, host: { editor: true }, disabled: ["ed.audio"] });
    set.apply({ plugins, host: { editor: true } });
    expect(seen).toEqual([false, true]);
  });

  it("the low-level activation without a plugin set reports plain activity", () => {
    const seen: boolean[] = [];
    cleanup.push("ed.low", "ed.low2");
    activatePlugin({ manifest: m("ed.low"), activate: () => {} });
    activatePlugin({ manifest: m("ed.low2"), activate: (ctx) => void seen.push(ctx.plugins.isActive("ed.low"), ctx.plugins.isActive("ed.nope")) });
    expect(seen).toEqual([true, false]);
  });
});

describe("third-party plugins", () => {
  const manifest = (over: Partial<ThirdPartyManifest> & { name: string }): ThirdPartyManifest => ({ version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", ...over });
  const projectOf = (manifests: readonly ThirdPartyManifest[]) => ({
    json: new Map(manifests.map((x) => [`plugins/${x.name}/plugin.json`, JSON.stringify(x)])),
    code: new Map(manifests.map((x) => [`plugins/${x.name}/runtime/index.ts`, ""])),
  });
  const plan = (manifests: readonly ThirdPartyManifest[]) => planPluginCode(projectOf(manifests), { editor: false });

  it("reads optionalDependencies like dependencies, and reports bad ones", async () => {
    const good = await plan([manifest({ name: "acme.a", optionalDependencies: { "myco.audio": "^1.0.0" } })]);
    expect(good.problems).toEqual([]);
    expect(good.found[0]!.manifest.optionalDependencies).toEqual({ "myco.audio": "^1.0.0" });

    const bad = await planPluginCode({ json: new Map([["plugins/p/plugin.json", JSON.stringify({ name: "acme.p", version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", optionalDependencies: { x: 3 } })]]), code: new Map([["plugins/p/runtime/index.ts", ""]]) }, { editor: false });
    expect(bad.problems.map((p) => p.message).join(" ")).toContain('optional dependency "x" needs a semver range');
    const notObject = await planPluginCode({ json: new Map([["plugins/p/plugin.json", JSON.stringify({ name: "acme.p", version: "1.0.0", sdk: "^1.0.0", runtime: "runtime/index.ts", optionalDependencies: ["x"] })]]), code: new Map([["plugins/p/runtime/index.ts", ""]]) }, { editor: false });
    expect(notObject.problems.map((p) => p.message).join(" ")).toContain('"optionalDependencies" must be an object');
  });

  it("doesn't refuse a plugin for a missing or out-of-range optional dependency, and orders after the present one", async () => {
    const { plugins, problems } = await plan([
      manifest({ name: "acme.user", optionalDependencies: { "acme.late": "*", "acme.absent": "*", "myco.audio": "^9.0.0" } }),
      manifest({ name: "acme.late" }),
    ]);
    expect(problems).toEqual([]);
    expect(plugins.map((p) => p.manifest.name)).toEqual(["acme.late", "acme.user"]);
  });

  it("an optional dependency that is refused doesn't refuse the plugin", async () => {
    const { plugins, problems } = await plan([
      manifest({ name: "acme.user", optionalDependencies: { "acme.broken": "*" } }),
      manifest({ name: "acme.broken", dependencies: { "acme.nowhere": "*" } }),
    ]);
    expect(plugins.map((p) => p.manifest.name)).toEqual(["acme.user"]);
    expect(problems.map((p) => p.plugin)).toEqual(["acme.broken"]);
  });

  it("refuses a cycle through an optional dependency", async () => {
    const { plugins, problems } = await plan([
      manifest({ name: "acme.x", optionalDependencies: { "acme.y": "*" } }),
      manifest({ name: "acme.y", dependencies: { "acme.x": "*" } }),
    ]);
    expect(plugins).toEqual([]);
    expect(problems.map((p) => p.message)).toEqual(["dependency cycle: acme.x → acme.y → acme.x", "dependency cycle: acme.x → acme.y → acme.x"]);
  });
});
