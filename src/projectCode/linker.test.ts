// The project code linker (ADR 0329): one suite runs both targets, memory (module URLs, imported) and
// build (files under code/), over the same fixtures, so the hosts can't drift on what a problem is,
// which plugin entries fail, or which assets the code names.
import { beforeAll, describe, expect, it } from "vitest";
import * as engine from "../myco";
import { rewriteImports, typescript } from "../editor/moduleImports";
import type { PackageSource } from "../editor/packages";
import { nodePackageSource } from "../server/packages";
import { buildTarget } from "./buildTarget";
import { compileScript, resolveScript } from "./compile";
import { link, type LinkInput } from "./linker";
import { loadOrder } from "./loadOrder";
import { MemoryTarget } from "./memoryTarget";

beforeAll(() => typescript().then(() => undefined), 60_000);

const pkg = (json: object) => JSON.stringify(json);
const NODE_MODULES: Record<string, string> = {
  "package.json": pkg({ dependencies: { "esm-pkg": "1", "acme-plugin": "1" } }),
  "node_modules/esm-pkg/package.json": pkg({ name: "esm-pkg", module: "index.mjs" }),
  "node_modules/esm-pkg/index.mjs": `export const add = (a, b) => a + b;\n`,
  "node_modules/acme-plugin/package.json": pkg({ name: "acme-plugin", module: "index.mjs" }),
  "node_modules/acme-plugin/index.mjs": `import { add } from "esm-pkg";\nexport const activate = () => add(1, 2);\n`,
};
const packages = (mode: PackageSource["mode"]): PackageSource => ({
  files: { read: async (path) => NODE_MODULES[path] ?? null },
  mode,
  id: `linker-${mode}`,
  esbuild: nodePackageSource(".", mode).esbuild,
});

/** Link `input` into a fresh memory target and the build target. */
async function both(input: LinkInput, mode: PackageSource["mode"] | null = null) {
  const withPackages = mode ? { ...input, packages: packages(mode) } : input;
  const memory = new MemoryTarget(engine);
  return { memory: await link(withPackages, memory), build: await link(withPackages, buildTarget()), target: memory };
}

const byPath = <T extends { path: string }>(list: readonly T[]) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** A project's code with a bit of everything: imports between scripts, JSON, the engine, and broken imports of every kind. */
const PROJECT = new Map([
  ["scripts/main.ts", `import { Mathf } from "myco";\nimport { two } from "./util";\nimport levels from "../data/levels.json";\nexport const value = Mathf.clamp(two() + levels.length, 0, 100);\nexport const prefab = "prefabs/enemy.prefab.json";\n`],
  ["scripts/util.ts", `export const two = () => 2;\n`],
  ["scripts/legacy.ts", `import { Mathf } from "tranquility";\nexport const half = Mathf.clamp(5, 0, 1);\n`],
  ["scripts/syntax.ts", `export const = 1;\n`],
  ["scripts/missing.ts", `import "./gone";\n`],
  ["scripts/badJson.ts", `import bad from "../data/bad.json";\nexport { bad };\n`],
  ["scripts/cycleA.ts", `import "./cycleB";\n`],
  ["scripts/cycleB.ts", `import "./cycleA";\n`],
  ["scripts/usesMissing.ts", `import "./missing";\n`],
  ["scripts/types.d.ts", `declare const x: number;\n`], // not a script: ignored
  ["plugins/p/runtime/index.ts", `import { x } from "myco/editor";\nexport const y = x;\n`],
]);
const JSON_FILES = new Map([
  ["data/levels.json", "[1, 2, 3]"],
  ["data/bad.json", "{ nope"],
]);

describe("linking into both targets", () => {
  it("links the same scripts in the same order, with the same problems", async () => {
    const { memory, build } = await both({ code: PROJECT, json: JSON_FILES });
    expect(memory.loaded).toEqual(["scripts/legacy.ts", "scripts/util.ts", "scripts/main.ts"]);
    expect(build.loaded).toEqual(memory.loaded);
    expect(byPath(build.problems)).toEqual(byPath(memory.problems));
    const why = Object.fromEntries(memory.problems.map((p) => [p.path, p.message]));
    expect(Object.keys(why).sort()).toEqual(["plugins/p/runtime/index.ts", "scripts/badJson.ts", "scripts/cycleA.ts", "scripts/cycleB.ts", "scripts/missing.ts", "scripts/syntax.ts", "scripts/usesMissing.ts"]);
    expect(why["scripts/syntax.ts"]).toMatch(/^line 1: /);
    expect(why["scripts/missing.ts"]).toBe(`can't find "./gone"`);
    expect(why["scripts/badJson.ts"]).toBe("can't import data/bad.json: it isn't valid JSON");
    expect(why["scripts/cycleA.ts"]).toMatch(/^import cycle: /);
    expect(why["scripts/usesMissing.ts"]).toBe("imports scripts/missing.ts, which didn't load");
    expect(why["plugins/p/runtime/index.ts"]).toContain(`can't import "myco/editor"`);
  });

  it("names the assets the linked code names, the same in both targets", async () => {
    const isAsset = (p: string) => p === "prefabs/enemy.prefab.json";
    const code = new Map([...PROJECT, ["scripts/other.ts", `export const m = "materials/gone.material.json";\n`]]);
    const { memory, build } = await both({ code, json: JSON_FILES, isAsset });
    expect(memory.assetRefs).toEqual(["prefabs/enemy.prefab.json"]);
    expect(build.assetRefs).toEqual(memory.assetRefs);
  });

  it("reports an npm plugin entry that can't be bundled, in both targets, and bundles the rest", async () => {
    const code = new Map([["scripts/game.ts", `import { add } from "esm-pkg";\nexport const n = add(1, 1);\n`]]);
    const { memory, build, target } = await both({ code, extraEntries: ["acme-plugin", "left-pad"] }, "production");
    for (const linked of [memory, build]) {
      expect(linked.loaded).toEqual(["scripts/game.ts"]);
      expect(linked.specifiers).toEqual(["acme-plugin", "esm-pkg", "left-pad"]);
      expect(linked.problems).toEqual([{ path: "left-pad", message: expect.stringMatching(/^the plugin entry can't be bundled: "left-pad" isn't installed/) }]);
      expect([...linked.entries.keys()].sort()).toEqual(["acme-plugin", "esm-pkg"]);
    }
    expect((await target.packageModule("acme-plugin")).activate).toBeTypeOf("function");
    await expect(target.packageModule("left-pad")).rejects.toThrow(/"left-pad" isn't loaded: "left-pad" isn't installed/);
  }, 30_000);

  it("says packages need node_modules when there are none, in both targets", async () => {
    const code = new Map([["scripts/a.ts", `import mitt from "mitt";\nexport const m = mitt;\n`]]);
    const { memory, build } = await both({ code, extraEntries: ["acme-plugin"] });
    expect(build.problems).toEqual(memory.problems);
    expect(memory.problems.map((p) => p.path).sort()).toEqual(["acme-plugin", "scripts/a.ts"]);
    for (const p of memory.problems) expect(p.message).toMatch(/project folder's node_modules/);
  });
});

describe("the memory target", () => {
  it("imports each module after its imports, sharing the host's engine; the last link's modules stay loadable", async () => {
    const target = new MemoryTarget(engine);
    await link({ code: PROJECT, json: JSON_FILES }, target);
    expect((await target.scriptModule("scripts/main.ts")).value).toBe(5);
    expect((await target.scriptModule("scripts/legacy.ts")).half).toBe(1);
    await expect(target.scriptModule("scripts/missing.ts")).rejects.toThrow(/isn't loaded/);
    expect((globalThis as { __myco?: unknown }).__myco).toBe(engine);
  });

  it("reports a module that throws while loading, and what imports it; the others load", async () => {
    const linked = await link(
      {
        code: new Map([
          ["scripts/Boom.ts", `throw new Error("kaboom");\n`],
          ["scripts/Uses.ts", `import "./Boom";\n`],
          ["scripts/Fine.ts", `export const ok = true;\n`],
        ]),
      },
      new MemoryTarget(engine),
    );
    expect(linked.loaded).toEqual(["scripts/Fine.ts"]);
    expect(linked.problems).toEqual([
      { path: "scripts/Boom.ts", message: "kaboom" },
      { path: "scripts/Uses.ts", message: "imports a script that didn't load" },
    ]);
  });

  it("keeps each host's modules in its own instance", async () => {
    const editor = new MemoryTarget(engine);
    const server = new MemoryTarget(engine);
    await link({ code: new Map([["scripts/a.ts", "export const who = 'editor';\n"]]) }, editor);
    await link({ code: new Map([["scripts/b.ts", "export const who = 'server';\n"]]) }, server);
    expect((await editor.scriptModule("scripts/a.ts")).who).toBe("editor");
    expect((await server.scriptModule("scripts/b.ts")).who).toBe("server");
    await expect(editor.scriptModule("scripts/b.ts")).rejects.toThrow(/isn't loaded/);
  });

  it("runs every module again on the next link, but reuses the bundled packages while nothing changed", async () => {
    const target = new MemoryTarget(engine);
    const input: LinkInput = { code: new Map([["scripts/game.ts", `import { add } from "esm-pkg";\nexport const n = add(1, 1);\n`]]), packages: packages("development") };
    const first = await link(input, target);
    const one = await target.scriptModule("scripts/game.ts");
    const second = await link(input, target);
    expect(await target.scriptModule("scripts/game.ts")).not.toBe(one);
    expect(second.entries.get("esm-pkg")).toBe(first.entries.get("esm-pkg"));
  }, 30_000);
});

describe("the build target", () => {
  it("writes each module under code/ with relative imports, JSON as modules, and no source maps", async () => {
    const { output: files } = await link({ code: PROJECT, json: JSON_FILES }, buildTarget());
    const main = files.get("code/scripts/main.js")!;
    expect(main).toContain('from "../../myco.js"');
    expect(main).toContain('from "./util.js"');
    expect(main).toContain('from "../data/levels.json.js"');
    expect(main).not.toContain("sourceMappingURL");
    expect(files.get("code/scripts/legacy.js")).toContain('from "../../myco.js"');
    expect(files.get("code/data/levels.json.js")).toBe("export default [1,2,3];\n");
    expect([...files.keys()].sort()).toEqual(["code/data/levels.json.js", "code/scripts/legacy.js", "code/scripts/main.js", "code/scripts/util.js"]);
  });

  it("writes the bundled packages into code/deps/, with scripts and entries pointing at them", async () => {
    const code = new Map([["scripts/game.ts", `import { add } from "esm-pkg";\nexport const n = add(1, 1);\n`]]);
    const linked = await link({ code, packages: packages("production"), extraEntries: ["acme-plugin"] }, buildTarget());
    expect(linked.problems).toEqual([]);
    expect(linked.entries.get("acme-plugin")).toMatch(/^code\/deps\/.+\.js$/);
    expect(linked.output.has(linked.entries.get("acme-plugin")!)).toBe(true);
    expect(linked.output.get("code/scripts/game.js")).toContain(`from "../${linked.entries.get("esm-pkg")!.slice("code/".length)}"`);
  }, 30_000);
});

describe("compiling a script", () => {
  const SPIN = `import { GameBehavior, behavior, field } from "myco";\nimport { defaultSpeed } from "./util";\n@behavior("game.Spin")\nexport class Spin extends GameBehavior {\n  @field(Number) speed = defaultSpeed();\n}\n`;

  it("compiles standard decorators and lists imports with their positions", async () => {
    const out = await compileScript("scripts/Spin.ts", SPIN);
    if (!("code" in out)) throw new Error(out.message);
    expect(out.code).toContain("__esDecorate"); // standard decorators, lowered like the editor build
    expect(out.code).toContain("sourceMappingURL=data:");
    expect(out.imports.map((i) => i.specifier)).toEqual(["myco", "./util"]);
    const first = out.imports[0]!;
    expect(out.code.slice(first.start, first.end)).toBe("myco");
  });

  it("reports syntax errors with a line number; type errors don't stop it", async () => {
    expect(await compileScript("scripts/Bad.ts", "const a = ;\n")).toMatchObject({ path: "scripts/Bad.ts", message: expect.stringMatching(/^line 1: /) });
    expect(await compileScript("scripts/Typo.ts", "const n: number = 'text';\n")).toHaveProperty("code");
  });

  it("resolves relative imports the way TypeScript does", () => {
    const paths = new Set(["scripts/util.ts", "scripts/ai/index.ts", "scripts/ai/Enemy.ts"]);
    expect(resolveScript("scripts/Spin.ts", "./util", paths)).toBe("scripts/util.ts");
    expect(resolveScript("scripts/Spin.ts", "./util.js", paths)).toBe("scripts/util.ts");
    expect(resolveScript("scripts/Spin.ts", "./ai", paths)).toBe("scripts/ai/index.ts");
    expect(resolveScript("scripts/ai/Enemy.ts", "../util.ts", paths)).toBe("scripts/util.ts");
    expect(resolveScript("scripts/Spin.ts", "./nope", paths)).toBeNull();
    expect(resolveScript("scripts/Spin.ts", "lodash", paths)).toBeNull();
  });

  it("rewrites specifiers in place", () => {
    const code = `import { a } from "./a"; export * from "myco";`;
    const imports = [
      { specifier: "./a", start: code.indexOf("./a"), end: code.indexOf("./a") + 3 },
      { specifier: "myco", start: code.indexOf("myco"), end: code.indexOf("myco") + 4 },
    ];
    expect(rewriteImports(code, imports, (s) => (s === "./a" ? "data:A" : "data:E"))).toBe(`import { a } from "data:A"; export * from "data:E";`);
  });
});

describe("load order", () => {
  const compiled = (imports: Record<string, string[]>) =>
    new Map(Object.entries(imports).map(([path, specs]) => [path, { path, code: "", imports: specs.map((specifier) => ({ specifier, start: 0, end: 0 })) }]));

  it("loads each script after the scripts it imports", () => {
    const plan = loadOrder(compiled({ "scripts/a.ts": ["./b", "myco"], "scripts/b.ts": ["./c"], "scripts/c.ts": [] }));
    expect(plan.order).toEqual(["scripts/c.ts", "scripts/b.ts", "scripts/a.ts"]);
    expect(plan.problems).toEqual([]);
  });

  it("reports cycles, missing scripts and packages, and what depends on them; the rest still load", () => {
    const plan = loadOrder(
      compiled({
        "scripts/a.ts": ["./b"],
        "scripts/b.ts": ["./a"],
        "scripts/c.ts": ["./gone"],
        "scripts/d.ts": ["lodash"],
        "scripts/e.ts": ["./c"],
        "scripts/f.ts": [],
      }),
    );
    expect(plan.order).toEqual(["scripts/f.ts"]);
    const problem = (p: string) => plan.problems.find((x) => x.path === p)?.message;
    expect(problem("scripts/a.ts")).toMatch(/import cycle/);
    expect(problem("scripts/c.ts")).toMatch(/can't find "\.\/gone"/);
    expect(problem("scripts/d.ts")).toMatch(/can't import "lodash"/);
    expect(problem("scripts/e.ts")).toMatch(/imports scripts\/c\.ts/);
  });
});

describe("action set imports (ADR 0433)", () => {
  const code = new Map([["scripts/system.ts", `import PlayerActions from "../input/player.actions.json";\nexport const id = PlayerActions.id;\nexport const names = PlayerActions.actions.map((a) => a.name);\n`]]);
  const json = new Map([["input/player.actions.json", JSON.stringify({ id: "test.linker.PlayerActions", actions: [{ name: "jump", type: "button" }] })]]);

  it("gives a script the defined set, not the file's JSON, in both targets", async () => {
    const { memory, build, target } = await both({ code, json });
    expect(memory.problems).toEqual([]);
    expect(build.problems).toEqual([]);
    const module = await target.scriptModule("scripts/system.ts");
    expect(module.id).toBe("test.linker.PlayerActions");
    expect(module.names).toEqual(["jump"]);
    const wrapper = build.output.get("code/input/player.actions.json.set.js")!;
    expect(wrapper).toContain(`actionSetFromData("input/player.actions.json", data)`);
    expect(build.output.get("code/scripts/system.js")).toContain(`from "../input/player.actions.json.set.js"`);
  });
});
