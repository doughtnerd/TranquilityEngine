import { describe, expect, it } from "vitest";
import { Engine, GameObject, getComponentClass } from "../engine";
import { getFields } from "../engine/core/registry";
import { instantiateDocument } from "../engine/editor";
import { joinPath, openFolderProject } from "./projects";
import { compileScript, isScriptPath, loadOrder, loadScripts, resolveScript, rewriteImports } from "./scriptLoader";
import { ROOT, demoFolder } from "./testing";


const SPIN = `
import { GameBehavior, behavior, field } from "myco";
import { defaultSpeed } from "./util";

@behavior("game.Spin")
export class Spin extends GameBehavior {
  @field(Number) speed = defaultSpeed();
  update(): void {
    this.transform.rotate2D(this.speed);
  }
}
`;

describe("finding scripts and their imports", () => {
  it("counts .ts files under scripts/, not declarations or files elsewhere", () => {
    expect(isScriptPath("scripts/Spin.ts")).toBe(true);
    expect(isScriptPath("scripts/ai/Enemy.ts")).toBe(true);
    expect(isScriptPath("scripts/types.d.ts")).toBe(false);
    expect(isScriptPath("behaviors/Bird.ts")).toBe(false);
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
});

describe("compiling", () => {
  it("compiles standard decorators and lists imports with their positions", async () => {
    const out = await compileScript("scripts/Spin.ts", SPIN);
    if (!("code" in out)) throw new Error(out.message);
    expect(out.code).toContain("__esDecorate"); // standard decorators, lowered like the editor build
    expect(out.code).toContain("sourceMappingURL=data:");
    expect(out.imports.map((i) => i.specifier)).toEqual(["myco", "./util"]);
    const first = out.imports[0];
    expect(out.code.slice(first.start, first.end)).toBe("myco");
  });

  it("reports syntax errors with a line number; type errors don't stop it", async () => {
    expect(await compileScript("scripts/Bad.ts", "const a = ;\n")).toMatchObject({ path: "scripts/Bad.ts", message: expect.stringMatching(/^line 1: /) });
    expect(await compileScript("scripts/Typo.ts", "const n: number = 'text';\n")).toHaveProperty("code");
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

describe("loading into the editor", () => {
  it("registers script components that scenes can then use, sharing the editor's engine", async () => {
    const result = await loadScripts(
      new Map([
        ["scripts/Spin.ts", SPIN],
        ["scripts/util.ts", "export const defaultSpeed = () => 3;\n"],
      ]),
    );
    expect(result.problems).toEqual([]);
    expect(result.loaded).toEqual(["scripts/util.ts", "scripts/Spin.ts"]);
    const Spin = getComponentClass("game.Spin")!;
    expect(getFields(Spin).map((f) => f.name)).toEqual(["speed"]);

    const engine = await Engine.create({ headless: true, kind: "editor" });
    const scene = instantiateDocument(
      engine.world,
      { format: "myco.scene@1", nodes: [{ id: "wheel", components: [{ type: "engine.Transform" }, { type: "game.Spin", data: { speed: 7 } }] }] },
      "scenes/test.scene.json",
    );
    const wheel = scene.children[0] as GameObject;
    const spin = wheel.getBehavior(Spin as never) as unknown as { speed: number };
    expect(spin.speed).toBe(7);
    engine.dispose();
  });

  it("loading again replaces the registrations instead of throwing", async () => {
    const data = (speed: number) => `
      import { defineComponent, defineSystem, f32, GameBehavior, behavior, field } from "myco";
      export const Wind = defineComponent("game.Wind", { strength: f32 });
      defineSystem({ name: "game.Blow", phase: "update", query: [Wind], run() {} });
      @behavior("game.Fan") export class Fan extends GameBehavior { @field(Number) speed = ${speed}; }
    `;
    await loadScripts(new Map([["scripts/Fan.ts", data(1)]]));
    const first = getComponentClass("game.Fan");
    const again = await loadScripts(new Map([["scripts/Fan.ts", data(2)]]));
    expect(again.problems).toEqual([]);
    expect(getComponentClass("game.Fan")).not.toBe(first);
    expect((new (getComponentClass("game.Fan") as new () => { speed: number })()).speed).toBe(2);
  });

  it("reports a script that throws while loading, and keeps loading the others", async () => {
    const result = await loadScripts(
      new Map([
        ["scripts/Boom.ts", `throw new Error("kaboom");\n`],
        ["scripts/Uses.ts", `import "./Boom";\n`],
        ["scripts/Fine.ts", `export const ok = true;\n`],
        ["scripts/Bad.ts", `let = ;\n`],
      ]),
    );
    expect(result.loaded).toEqual(["scripts/Fine.ts"]);
    const problem = (p: string) => result.problems.find((x) => x.path === p)?.message;
    expect(problem("scripts/Boom.ts")).toBe("kaboom");
    expect(problem("scripts/Uses.ts")).toMatch(/didn't load/);
    expect(problem("scripts/Bad.ts")).toMatch(/^line 1/);
  });
});

describe("project folders", () => {
  it("read the scripts under scripts/ when opened", async () => {
    const fs = demoFolder();
    fs.files.set(joinPath(ROOT, "scripts/Spin.ts"), SPIN);
    fs.files.set(joinPath(ROOT, "scripts/types.d.ts"), "declare const x: number;");
    const project = await openFolderProject(fs, ROOT);
    expect([...project.scripts.keys()]).toEqual(["scripts/Spin.ts"]);
    expect(project.scripts.get("scripts/Spin.ts")).toBe(SPIN);
    expect(project.files).not.toContain("scripts/Spin.ts"); // not an asset
  });
});

describe("the engine's former name (ADR 0037)", () => {
  it("loads scripts that import \"tranquility\" as the engine", async () => {
    const { loadScripts } = await import("./scriptLoader");
    const result = await loadScripts(new Map([["scripts/legacy.ts", `import { Mathf } from "tranquility";\nexport const half = Mathf.clamp(5, 0, 1);\n`]]));
    expect(result.problems).toEqual([]);
    expect(result.loaded).toEqual(["scripts/legacy.ts"]);
  });
});
