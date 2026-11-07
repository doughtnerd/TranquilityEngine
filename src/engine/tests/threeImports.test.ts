// ADR 0081: Babylon.js is the only renderer; three.js stays only for its OBJ, MTL and FBX loaders,
// which `scene/models.ts` imports on demand and converts to renderer-neutral model data, and (ADR
// 0088) its glTF loader and meshopt decoder in `scene/gltf.ts`. No other
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

/** The model loader modules (ADR 0081, 0088). */
const LOADER_FILES = ["engine/scene/models.ts", "engine/scene/gltf.ts"];

/** The libraries that went with the three.js backend (ADR 0081). */
const REMOVED = ["postprocessing", "n8ao", "three.quarks", "@pmndrs/uikit"];

describe("three.js imports (ADR 0081)", () => {
  it("imports three.js only in the model loaders (and tests)", () => {
    const outside = imports.filter((i) => !LOADER_FILES.includes(i.file) && !i.file.includes("/tests/") && !/\.test\.tsx?$/.test(i.file));
    expect(outside).toEqual([]);
  });

  it("uses only three.js's loaders and the types they hand back there", () => {
    const loaders = imports.filter((i) => LOADER_FILES.includes(i.file) && i.specifier !== "three");
    expect(loaders.length).toBeGreaterThan(0); // the scan works
    for (const i of loaders) expect(i.specifier).toMatch(/^three\/examples\/jsm\/(loaders\/(OBJ|MTL|FBX|GLTF)Loader|libs\/meshopt_decoder\.module)\.js$/);
  });

  it("loads three.js for glTF only when a glTF file is parsed, and never for baked models (ADR 0082, 0088, 0090)", () => {
    const text = readFileSync(join(root, "engine/scene/gltf.ts"), "utf8");
    const staticImports = [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s*["']three(?:\/[^"']*)?["']/gm)];
    expect(staticImports.length).toBeGreaterThan(0); // the scan works
    for (const m of staticImports) expect(m[1], m[0]).toBe("type ");
    expect(readFileSync(join(root, "engine/scene/bakedModel.ts"), "utf8")).not.toMatch(/from\s*["']three/);
  });

  it("loads three.js only when a model file is parsed, never at start-up (ADR 0082)", () => {
    const text = readFileSync(join(root, "engine/scene/models.ts"), "utf8");
    const staticImports = [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s*["']three(?:\/[^"']*)?["']/gm)];
    expect(staticImports.length).toBeGreaterThan(0); // the scan works
    for (const m of staticImports) expect(m[1], m[0]).toBe("type ");
    expect(readFileSync(join(root, "engine/scene/builtinMeshes.ts"), "utf8")).not.toMatch(/from\s*["']three/);
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
