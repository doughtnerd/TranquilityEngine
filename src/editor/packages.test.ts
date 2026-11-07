import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../engine";
import { compileForBuild } from "../export/webBuild";
import { bundlePackages, isPackageSpecifier, packageName, packageTypes, PackageResolver, type PackageFiles, type PackageSource } from "./packages";
import { loadScripts, replaceScripts } from "./scriptLoader";
import { nodeEsbuild } from "../server/packages";

/** A project folder's files in memory. */
const filesOf = (files: Record<string, string>): PackageFiles => ({ read: async (path) => files[path] ?? null });

const pkg = (json: object) => JSON.stringify(json);

/** A small node_modules: an ESM package, a CommonJS one, one with an exports map, one depending on another, and one needing Node's fs. */
const NODE_MODULES: Record<string, string> = {
  "package.json": pkg({ dependencies: { "esm-pkg": "1", "cjs-pkg": "1" } }),
  "node_modules/esm-pkg/package.json": pkg({ name: "esm-pkg", module: "dist/index.mjs", main: "dist/index.cjs", types: "dist/index.d.ts" }),
  "node_modules/esm-pkg/dist/index.mjs": `export const add = (a, b) => a + b;\nexport { greet } from "./greet.mjs";\n`,
  "node_modules/esm-pkg/dist/greet.mjs": `export const greet = (n) => "hi " + n;\n`,
  "node_modules/esm-pkg/dist/index.cjs": `throw new Error("the CommonJS build shouldn't be picked");`,
  "node_modules/esm-pkg/dist/index.d.ts": `export declare const add: (a: number, b: number) => number;\nexport { greet } from "./greet";\n`,
  "node_modules/esm-pkg/dist/greet.d.ts": `export declare const greet: (n: string) => string;\n`,
  "node_modules/cjs-pkg/package.json": pkg({ name: "cjs-pkg", main: "lib/main.js" }),
  "node_modules/cjs-pkg/lib/main.js": `const helper = require("./helper");\nmodule.exports = { twice: (x) => helper.mul(x, 2), env: process.env.NODE_ENV };\n`,
  "node_modules/cjs-pkg/lib/helper.js": `exports.mul = (a, b) => a * b;\n`,
  "node_modules/mapped/package.json": pkg({ name: "mapped", exports: { ".": { browser: "./browser.js", node: "./node.js", default: "./node.js" }, "./extra": "./extra.js" } }),
  "node_modules/mapped/browser.js": `export const where = "browser";\n`,
  "node_modules/mapped/node.js": `export const where = "node";\n`,
  "node_modules/mapped/extra.js": `import { add } from "esm-pkg";\nexport const three = add(1, 2);\n`,
  "node_modules/@scope/thing/package.json": pkg({ name: "@scope/thing", main: "index.js", browser: { fs: false } }),
  "node_modules/@scope/thing/index.js": `const fs = require("fs");\nmodule.exports = { hasFs: Object.keys(fs).length > 0, nested: require("dep") };\n`,
  "node_modules/@scope/thing/node_modules/dep/package.json": pkg({ name: "dep", main: "index.js" }),
  "node_modules/@scope/thing/node_modules/dep/index.js": `module.exports = "nested dep";\n`,
  "node_modules/needs-fs/package.json": pkg({ name: "needs-fs", main: "index.js" }),
  "node_modules/needs-fs/index.js": `module.exports = require("fs").readFileSync;\n`,
};

const source = (files: Record<string, string> = NODE_MODULES, mode: PackageSource["mode"] = "development"): PackageSource => ({
  files: filesOf(files),
  mode,
  id: `test-${mode}`,
  esbuild: nodeEsbuild,
});

afterEach(async () => {
  await replaceScripts(new Map());
});

describe("package specifiers", () => {
  it("tells package imports from the engine, relative paths and URLs", () => {
    expect(isPackageSpecifier("mitt")).toBe(true);
    expect(isPackageSpecifier("@scope/pkg/sub")).toBe(true);
    expect(isPackageSpecifier("myco")).toBe(false);
    expect(isPackageSpecifier("tranquility")).toBe(false);
    expect(isPackageSpecifier("./util")).toBe(false);
    expect(isPackageSpecifier("https://example.com/x.js")).toBe(false);
    expect(packageName("lodash-es/debounce")).toBe("lodash-es");
    expect(packageName("@scope/pkg/sub")).toBe("@scope/pkg");
  });
});

describe("resolving from node_modules (ADR 0125)", () => {
  const resolver = () => new PackageResolver(filesOf(NODE_MODULES));

  it("prefers module over main, follows exports maps with the browser condition, and probes extensions", async () => {
    expect(await resolver().resolve("esm-pkg", "")).toEqual({ file: "node_modules/esm-pkg/dist/index.mjs" });
    expect(await resolver().resolve("cjs-pkg", "")).toEqual({ file: "node_modules/cjs-pkg/lib/main.js" });
    expect(await resolver().resolve("./helper", "node_modules/cjs-pkg/lib/main.js")).toEqual({ file: "node_modules/cjs-pkg/lib/helper.js" });
    expect(await resolver().resolve("mapped", "")).toEqual({ file: "node_modules/mapped/browser.js" });
    expect(await resolver().resolve("mapped/extra", "")).toEqual({ file: "node_modules/mapped/extra.js" });
  });

  it("finds nested node_modules first, and honours browser-field replacements", async () => {
    expect(await resolver().resolve("dep", "node_modules/@scope/thing/index.js")).toEqual({ file: "node_modules/@scope/thing/node_modules/dep/index.js" });
    expect(await resolver().resolve("fs", "node_modules/@scope/thing/index.js")).toEqual({ empty: true });
  });

  it("explains missing packages, unexported paths and Node built-ins", async () => {
    expect(await resolver().resolve("left-pad", "")).toEqual({ error: expect.stringMatching(/isn't installed: run npm install/) });
    expect(await resolver().resolve("mapped/secret", "")).toHaveProperty("error");
    expect(await resolver().resolve("fs", "node_modules/needs-fs/index.js")).toEqual({ error: expect.stringMatching(/Node's "fs"/) });
  });
});

describe("bundling packages", () => {
  it("bundles ESM and CommonJS packages with shared chunks, attributing failures to their specifier", async () => {
    const bundle = await bundlePackages(["esm-pkg", "cjs-pkg", "mapped/extra", "needs-fs", "left-pad"], source());
    expect([...bundle.entries.keys()].sort()).toEqual(["cjs-pkg", "esm-pkg", "mapped/extra"]);
    expect(bundle.problems.get("left-pad")).toMatch(/isn't installed/);
    expect(bundle.problems.get("needs-fs")).toMatch(/Node's "fs"/);
    // esm-pkg is imported by mapped/extra too: one copy, in a chunk both entries import.
    const all = [...bundle.chunks.values()].map((c) => c.code).join("\n");
    expect(all.match(/hi /g)).toHaveLength(1);
    expect(all).toContain('"development"');
  }, 30_000);

  it("loads scripts importing packages, sharing the editor's engine", async () => {
    const scripts = new Map([
      [
        "scripts/UsesPackages.ts",
        `import { GameBehavior, behavior, field } from "myco";
import { add, greet } from "esm-pkg";
import cjs from "cjs-pkg";
import { where } from "mapped";
import thing from "@scope/thing";
@behavior("game.UsesPackages")
export class UsesPackages extends GameBehavior {
  @field(Number) sum = add(2, 3) + cjs.twice(10);
  label = greet(where) + " " + thing.nested + " " + thing.hasFs;
}
`,
      ],
      ["scripts/Broken.ts", `import pad from "left-pad";\nexport const x = pad;\n`],
    ]);
    const result = await loadScripts(scripts, new Map(), source());
    expect(result.loaded).toEqual(["scripts/UsesPackages.ts"]);
    expect(result.problems).toEqual([{ path: "scripts/Broken.ts", message: expect.stringMatching(/can't import "left-pad": "left-pad" isn't installed/) }]);
    const Cls = getComponentClass("game.UsesPackages") as unknown as new () => { sum: number; label: string };
    const instance = new Cls();
    expect(instance.sum).toBe(25);
    expect(instance.label).toBe("hi browser nested dep false");
  }, 30_000);

  it("says packages need a project folder when there's no package source", async () => {
    const result = await loadScripts(new Map([["scripts/A.ts", `import mitt from "mitt";\nexport const m = mitt;\n`]]));
    expect(result.problems[0].message).toMatch(/project folder's node_modules/);
  });

  it("writes packages into code/deps/ in game builds, with scripts importing them by relative path", async () => {
    const scripts = new Map([["scripts/Game.ts", `import { add } from "esm-pkg";\nimport { GameBehavior } from "myco";\nexport const n = add(1, 1);\nexport class G extends GameBehavior {}\n`]]);
    const { files } = await compileForBuild(scripts, new Map(), source(NODE_MODULES, "production"));
    const deps = [...files.keys()].filter((p) => p.startsWith("code/deps/"));
    expect(deps.length).toBeGreaterThan(0);
    expect(files.get("code/scripts/Game.js")).toMatch(/from "\.\.\/deps\/pkg0_esm_pkg\.js"/);
    await expect(compileForBuild(new Map([["scripts/X.ts", `import "left-pad";`]]), new Map(), source())).rejects.toThrow(/left-pad/);
  }, 30_000);
});

describe("package types for the TypeScript service", () => {
  it("reads a package's declarations and the files they reference; untyped packages are listed", async () => {
    const { files, untyped } = await packageTypes(["esm-pkg", "cjs-pkg"], filesOf(NODE_MODULES));
    expect([...files.keys()].sort()).toEqual(["node_modules/cjs-pkg/package.json", "node_modules/esm-pkg/dist/greet.d.ts", "node_modules/esm-pkg/dist/index.d.ts", "node_modules/esm-pkg/package.json"]);
    expect(untyped).toEqual(["cjs-pkg"]);
  });

  it("falls back to @types/<name>", async () => {
    const files = { ...NODE_MODULES, "node_modules/@types/cjs-pkg/package.json": pkg({ name: "@types/cjs-pkg", types: "index.d.ts" }), "node_modules/@types/cjs-pkg/index.d.ts": "export declare function twice(x: number): number;\n" };
    const { files: out, untyped } = await packageTypes(["cjs-pkg"], filesOf(files));
    expect(out.has("node_modules/@types/cjs-pkg/index.d.ts")).toBe(true);
    expect(untyped).toEqual([]);
  });
});
