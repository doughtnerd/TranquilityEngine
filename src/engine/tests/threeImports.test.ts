// ADR 0081: Babylon.js is the only renderer; three.js stays only for its OBJ, MTL and FBX loaders,
// which `scene/models.ts` imports on demand and converts to renderer-neutral model data. No other
// module imports three.js (tests may, to build loader input). Neither library is in the public API
// (ADR 0010).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url)); // src/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

const imports = sources(root).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file).split("\\").join("/");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["'](three(?:\/[^"']*)?)["']/g)].map((m) => ({ file: rel, specifier: m[1] }));
});

/** The libraries that went with the three.js backend (ADR 0081). */
const REMOVED = ["postprocessing", "n8ao", "three.quarks", "@pmndrs/uikit"];

describe("three.js imports (ADR 0081)", () => {
  it("imports three.js only in the model loaders (and tests)", () => {
    const outside = imports.filter((i) => i.file !== "engine/scene/models.ts" && !i.file.includes("/tests/") && !/\.test\.tsx?$/.test(i.file));
    expect(outside).toEqual([]);
  });

  it("uses only three.js's loaders and the types they hand back there", () => {
    const loaders = imports.filter((i) => i.file === "engine/scene/models.ts" && i.specifier !== "three");
    expect(loaders.length).toBeGreaterThan(0); // the scan works
    for (const i of loaders) expect(i.specifier).toMatch(/^three\/examples\/jsm\/loaders\/(OBJ|MTL|FBX)Loader\.js$/);
  });

  it("leaves the three.js backend's libraries out of the sources and the package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "../package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const name of REMOVED) {
      expect(pkg.dependencies?.[name], name).toBeUndefined();
      expect(pkg.devDependencies?.[name], name).toBeUndefined();
    }
    const used = sources(root).filter((file) => REMOVED.some((name) => new RegExp(`(?:from|import)\\s*\\(?\\s*["']${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`).test(readFileSync(file, "utf8"))));
    expect(used).toEqual([]);
  });
});
