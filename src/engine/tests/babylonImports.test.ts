// ADR 0075: Babylon.js is imported module by module (never the "@babylonjs/core" barrel, which
// bundles the whole library), and only inside the Babylon backend, so it stays out of the public
// API (ADR 0010) and a page loads it only when it draws. Tests may import it to drive the backend
// headless.
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
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["'](@babylonjs\/[^"']*)["']/g)].map((m) => ({ file: rel, specifier: m[1] }));
});

describe("Babylon.js imports (ADR 0075)", () => {
  it("never imports a package barrel", () => {
    const barrels = imports.filter((i) => /^@babylonjs\/[^/]+$/.test(i.specifier));
    expect(barrels).toEqual([]);
  });

  it("imports Babylon only inside the Babylon backend (and its tests)", () => {
    const outside = imports.filter((i) => !i.file.startsWith("engine/render/babylon/") && !i.file.startsWith("engine/tests/"));
    expect(outside).toEqual([]);
  });

  it("finds the backend's imports (the scan works)", () => {
    expect(imports.some((i) => i.file === "engine/render/babylon/BabylonRenderer.ts")).toBe(true);
  });
});
