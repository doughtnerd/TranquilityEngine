import { describe, expect, it } from "vitest";
import { Engine, GameObject, getComponentClass } from "../engine";
import { getFields } from "../engine/core/registry";
import { instantiateDocument } from "../engine/editor";
import { joinPath, openFolderProject } from "./projects";
import { isScriptPath, loadScripts, replaceScripts } from "./scriptLoader";
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

describe("finding scripts", () => {
  it("counts .ts files under scripts/, not declarations or files elsewhere", () => {
    expect(isScriptPath("scripts/Spin.ts")).toBe(true);
    expect(isScriptPath("scripts/ai/Enemy.ts")).toBe(true);
    expect(isScriptPath("scripts/types.d.ts")).toBe(false);
    expect(isScriptPath("behaviors/Bird.ts")).toBe(false);
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

describe("the engine for the console and tests", () => {
  it("is globalThis.__myco in the editor even when a project has no scripts, as in the player", async () => {
    const engine = await import("../myco");
    await replaceScripts(new Map());
    expect((globalThis as { __myco?: unknown }).__myco).toBe(engine);
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
