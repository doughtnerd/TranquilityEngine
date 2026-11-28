// ADR 0459: one rule turns an asset reference into a project path. The rule's forms, and a guard that no module
// outside `assetPath.ts` strips the `asset:` prefix by hand again (each copy decided on its own whether `./` and `/`
// go too, so `asset:./x` named one file in one module and another in the next).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { assetRefPrefix, normalizeAssetPath, withoutAssetScheme } from "./assetPath";

describe("normalizeAssetPath", () => {
  it("names one project path for every written form, a #sub-asset kept", () => {
    for (const ref of ["images/a.png", "asset:images/a.png", "asset:./images/a.png", "asset:/images/a.png", "./images/a.png", "/images/a.png"]) {
      expect(normalizeAssetPath(ref)).toBe("images/a.png");
    }
    expect(normalizeAssetPath("asset:./models/hero.glb#Anim/Run")).toBe("models/hero.glb#Anim/Run");
    expect(normalizeAssetPath("")).toBe("");
  });

  it("gives the prefix as written, and a scheme-only strip for document-relative paths", () => {
    expect(assetRefPrefix("asset:./a.png")).toBe("asset:./");
    expect(assetRefPrefix("/a.png")).toBe("/");
    expect(assetRefPrefix("a.png")).toBe("");
    expect(withoutAssetScheme("asset:./a.png")).toBe("./a.png");
    expect(withoutAssetScheme("/a.png")).toBe("/a.png");
  });
});

const SRC = join(__dirname, "../..");
/** The owning module, and navigation, which is frozen until its upstream merge (CLAUDE.md). */
const ALLOWED = new Set(["engine/scene/assetPath.ts"]);
const FROZEN = ["engine/nav/", "plugins/navigation/"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

it("no module outside assetPath.ts strips `asset:` with its own regex (ADR 0459)", () => {
  const copies = sources(SRC)
    .map((f) => relative(SRC, f).replaceAll("\\", "/"))
    .filter((f) => !ALLOWED.has(f) && !FROZEN.some((p) => f.startsWith(p)))
    .filter((f) => readFileSync(join(SRC, f), "utf8").includes("/^asset:/"));
  expect(copies).toEqual([]);
});
