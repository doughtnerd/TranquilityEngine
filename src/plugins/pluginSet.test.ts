import { describe, expect, it } from "vitest";
import type { PluginManifest } from "./manifest";
import { createPluginSet, throwOnPluginProblem, type HalfActivator, type PluginHalf, type SetPlugin } from "./pluginSet";

// The plugin set (ADR 0144) with fake plugins and fake activators: no global registry is touched.

/** A fake activator that logs what it does and keeps its own active list. */
function fakeActivator(kind: "runtime" | "editor", log: string[], options: { throws?: ReadonlySet<string> } = {}) {
  const active = new Set<string>();
  const activator: Required<HalfActivator> = {
    activate(half) {
      const name = half.manifest.name;
      if (active.has(name)) return;
      if (options.throws?.has(name)) throw new Error(`${kind} boom`);
      active.add(name);
      log.push(`+${kind} ${name}`);
    },
    deactivate(name) {
      if (active.delete(name)) log.push(`-${kind} ${name}`);
    },
    disable(half) {
      log.push(`off ${half.manifest.name}`);
    },
    isActive: (name) => active.has(name),
  };
  return Object.assign(activator, { active });
}

const manifest = (name: string, deps: string[] = [], extra: Partial<PluginManifest> = {}): PluginManifest => ({ name, version: "1.0.0", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])), ...extra });
const half = (m: PluginManifest): PluginHalf => ({ manifest: m, activate: () => {} });
/** A plugin with both halves (or the ones named). */
function plugin(name: string, deps: string[] = [], options: { halves?: Array<"runtime" | "editor">; extra?: Partial<PluginManifest>; modules?: SetPlugin["modules"] } = {}): SetPlugin {
  const m = manifest(name, deps, options.extra);
  const halves = options.halves ?? ["runtime", "editor"];
  return { manifest: m, ...(halves.includes("runtime") ? { runtime: half(m) } : {}), ...(halves.includes("editor") ? { editor: half(m) } : {}), ...(options.modules ? { modules: options.modules } : {}) };
}

function setUp(throws: { runtime?: string[]; editor?: string[] } = {}) {
  const log: string[] = [];
  const runtime = fakeActivator("runtime", log, { throws: new Set(throws.runtime) });
  const editor = fakeActivator("editor", log, { throws: new Set(throws.editor) });
  const set = createPluginSet({ runtime, editor });
  return { log, runtime, editor, set };
}

const editorHost = { editor: true } as const;

describe("the plugin set", () => {
  it("activates runtime halves, then editor halves, dependencies first", () => {
    const { log, set } = setUp();
    const result = set.apply({ plugins: [plugin("c", ["b"]), plugin("b", ["a"]), plugin("a")], host: editorHost });
    expect(result.problems).toEqual([]);
    expect(result.active).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["+runtime a", "+runtime b", "+runtime c", "+editor a", "+editor b", "+editor c"]);
  });

  it("orders each half by the entries that gave it, so runtime and editor orders can differ", () => {
    const { log, set } = setUp();
    const a = manifest("a");
    const b = manifest("b");
    const plugins: SetPlugin[] = [
      { manifest: a, runtime: half(a) },
      { manifest: b, runtime: half(b) },
      { manifest: b, editor: half(b) },
      { manifest: a, editor: half(a) },
    ];
    set.apply({ plugins, host: editorHost });
    expect(log).toEqual(["+runtime a", "+runtime b", "+editor b", "+editor a"]);
  });

  it("activates only runtime halves for a host that isn't the editor", () => {
    const { log, set } = setUp();
    set.apply({ plugins: [plugin("a")] });
    expect(log).toEqual(["+runtime a"]);
  });

  it("keeps unchanged halves when applied again", () => {
    const { log, set } = setUp();
    const plugins = [plugin("a"), plugin("b", ["a"])];
    set.apply({ plugins, host: editorHost });
    log.length = 0;
    expect(set.apply({ plugins, host: editorHost }).problems).toEqual([]);
    expect(log).toEqual([]);
  });

  it("diffs against what is active: disabled plugins and their dependents go, dependents first, and their runtime halves are stubbed", () => {
    const { log, set } = setUp();
    const plugins = [plugin("a"), plugin("b", ["a"]), plugin("c")];
    set.apply({ plugins, host: editorHost });
    log.length = 0;
    const result = set.apply({ plugins, disabled: ["a"], host: editorHost });
    expect(result.active).toEqual(["c"]);
    expect(log).toEqual(["-editor b", "-runtime b", "-editor a", "-runtime a", "off a", "off b"]);
    log.length = 0;
    set.apply({ plugins, host: editorHost });
    expect(log).toEqual(["+runtime a", "+runtime b", "+editor a", "+editor b"]);
  });

  it("deactivates plugins the host no longer lists (a closed project's third-party plugins)", () => {
    const { log, set } = setUp();
    const firstParty = [plugin("core")];
    set.apply({ plugins: [...firstParty, plugin("acme.x", ["core"])], host: editorHost });
    log.length = 0;
    set.apply({ plugins: firstParty, host: editorHost });
    expect(log).toEqual(["-editor acme.x", "-runtime acme.x"]);
    expect(set.active()).toEqual(["core"]);
  });

  it("re-activates a half whose module changed (a script reload), and the same half of the plugins that need it", () => {
    const { log, set } = setUp();
    const v1 = { runtime: {}, editor: {} };
    const v2 = { runtime: {}, editor: v1.editor }; // only the runtime entry was edited
    const y = plugin("acme.y", ["acme.x"]);
    set.apply({ plugins: [plugin("acme.x", [], { modules: v1 }), y], host: editorHost });
    log.length = 0;
    set.apply({ plugins: [plugin("acme.x", [], { modules: v2 }), y], host: editorHost });
    expect(log).toEqual(["-runtime acme.y", "-runtime acme.x", "+runtime acme.x", "+runtime acme.y"]);
  });

  it("with keepRuntime (Play), leaves runtime halves exactly as they are and re-activates changed editor halves", () => {
    const { log, set } = setUp();
    set.apply({ plugins: [plugin("acme.x", [], { modules: { runtime: 1, editor: 1 } })], host: editorHost });
    log.length = 0;
    const reloaded = [plugin("acme.x", [], { modules: { runtime: 2, editor: 2 } }), plugin("acme.new")];
    set.apply({ plugins: reloaded, host: editorHost, keepRuntime: true });
    expect(log).toEqual(["-editor acme.x", "+editor acme.x", "+editor acme.new"]);
    log.length = 0;
    set.apply({ plugins: reloaded, host: editorHost }); // Stop
    expect(log).toEqual(["-runtime acme.x", "+runtime acme.x", "+runtime acme.new"]);
  });

  it("drops runtime halves marked server: false on the server, as off", () => {
    const { log, set } = setUp();
    const result = set.apply({ plugins: [plugin("draw", [], { halves: ["runtime"], extra: { server: false } }), plugin("sim", [], { halves: ["runtime"] })], host: { server: true } });
    expect(result.active).toEqual(["sim"]);
    expect(log).toEqual(["off draw", "+runtime sim"]);
  });

  it("a plugin needing a server: false plugin still activates on the server (the dependency is only off there)", () => {
    const { set } = setUp();
    const result = set.apply({ plugins: [plugin("draw", [], { halves: ["runtime"], extra: { server: false } }), plugin("acme.x", ["draw"], { halves: ["runtime"] })], host: { server: true } });
    expect(result).toEqual({ active: ["acme.x"], problems: [] });
  });

  it("rolls back both halves of a plugin that throws and skips its dependents, without throwing", () => {
    const { log, set, runtime, editor } = setUp({ editor: ["b"] });
    const result = set.apply({ plugins: [plugin("a"), plugin("b", ["a"]), plugin("c", ["b"]), plugin("d", ["c"], { halves: ["runtime"] }), plugin("e")], host: editorHost });
    expect(result.problems).toEqual([
      { plugin: "b", where: "editor", message: "b failed to activate: editor boom" },
      { plugin: "c", where: "dependencies", message: "c needs b, which failed to activate" },
      { plugin: "d", where: "dependencies", message: "d needs c, which failed to activate" },
    ]);
    expect(result.active).toEqual(["a", "e"]);
    expect([...runtime.active].sort()).toEqual(["a", "e"]);
    expect([...editor.active].sort()).toEqual(["a", "e"]);
    // b's runtime half had activated before its editor half threw: it was rolled back, with c's and d's.
    expect(log).toContain("-runtime b");
    expect(log).toContain("-runtime d");
    expect(log).toContain("off c"); // the skipped ones' Components are unclaimed
  });

  it("a runtime half that throws skips the plugin's editor half", () => {
    const { log, set } = setUp({ runtime: ["a"] });
    const result = set.apply({ plugins: [plugin("a")], host: editorHost });
    expect(result.problems).toEqual([{ plugin: "a", where: "runtime", message: "a failed to activate: runtime boom" }]);
    expect(log).toEqual([]);
  });

  it("never throws: cycles and throwing deactivations come back as problems", () => {
    const { set } = setUp();
    const result = set.apply({ plugins: [plugin("x", ["y"]), plugin("y", ["x"]), plugin("z")], host: editorHost });
    expect(result.active).toEqual(["z"]);
    expect(result.problems.map((p) => p.plugin).sort()).toEqual(["x", "y"]);
    expect(result.problems[0].message).toMatch(/cycle/);

    const log: string[] = [];
    const broken = { ...fakeActivator("runtime", log), deactivate: () => { throw new Error("stuck"); } };
    const set2 = createPluginSet({ runtime: broken });
    set2.apply({ plugins: [plugin("a")] });
    expect(() => set2.apply({ plugins: [] })).not.toThrow();
    expect(set2.apply({ plugins: [plugin("a")] }).problems).toEqual([]);
  });

  it("a third-party plugin depending on a disabled first-party plugin is off, in the editor and the player alike", () => {
    for (const host of [editorHost, {}]) {
      const { set } = setUp();
      const firstParty = [plugin("myco.sky"), plugin("myco.ui")];
      const result = set.apply({ plugins: [...firstParty, plugin("acme.clouds", ["myco.sky"])], disabled: ["myco.sky"], host });
      expect(result).toEqual({ active: ["myco.ui"], problems: [] });
    }
  });

  it("activates a half deactivated outside the set again", () => {
    const { log, set, runtime } = setUp();
    set.apply({ plugins: [plugin("a")] });
    runtime.deactivate("a");
    log.length = 0;
    set.apply({ plugins: [plugin("a")] });
    expect(log).toEqual(["+runtime a"]);
  });

  it("throwOnPluginProblem stops a host with the first problem", () => {
    const { set } = setUp({ runtime: ["a"] });
    expect(() => throwOnPluginProblem(set.apply({ plugins: [plugin("a"), plugin("b", ["a"])] }))).toThrow("a failed to activate: runtime boom");
  });
});
