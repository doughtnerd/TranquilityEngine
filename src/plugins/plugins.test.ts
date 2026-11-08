// Import direction (ADR 0133): the editor half may import the runtime half, never the reverse; the
// engine knows nothing of plugins' editor halves or the editor.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function files(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
  });
}

/** Module specifiers a file imports or re-exports (static, dynamic, `import type` included unless `skipTypes`). */
function specifiers(file: string): { spec: string; typeOnly: boolean }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; typeOnly: boolean }[] = [];
  const re = /(?:^|[\s;])(?:(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?|import\s*\(\s*)["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push({ spec: m[3]!, typeOnly: !!m[2] });
  return out;
}

const resolved = (file: string, spec: string) => (spec.startsWith(".") ? resolve(dirname(file), spec) : spec);
const rel = (p: string) => relative(SRC, p).replaceAll("\\", "/");

const editorSide = (target: string): boolean =>
  /^editor(\/|$)/.test(target) || /^plugins\/editor(\.ts)?$/.test(target) || /^plugins\/[^/]+\/editor(\/|$)/.test(target);

describe("plugin import direction", () => {
  const runtimeFiles = [...files(join(SRC, "plugins")).filter((f) => /^plugins\/[^/]+\/runtime\//.test(rel(f))), join(SRC, "plugins/runtime.ts")];

  it("keeps runtime halves free of editor imports", () => {
    const bad: string[] = [];
    for (const f of runtimeFiles) {
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (editorSide(r) || /(^|\/)editor(\/|$)/.test(spec)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the engine free of plugin editor halves and the editor", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "engine"))) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (editorSide(r)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the engine free of plugins entirely (ADR 0135): plugins register through the runtime context", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "engine"))) {
      if (/\.test\.tsx?$/.test(f) || /^engine\/tests\//.test(rel(f))) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (/^plugins(\/|$)/.test(r)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("only the player, the server, the editor's plugin application, Play, Vitest's setup file and myco.ts import the runtime plugin list", () => {
    const importers: string[] = [];
    for (const f of files(SRC)) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        if (target.startsWith("/") && /^plugins\/runtime(\.ts)?$/.test(rel(target))) importers.push(rel(f));
      }
    }
    // myco.ts: the default activation for games built on the engine library (ADR 0135).
    expect(importers.sort()).toEqual(["editor/playMode.ts", "myco.ts", "player/main.ts", "plugins/editorApply.ts", "plugins/testSetup.ts", "server/run.ts"]);
  });

  it("keeps the editor core free of plugins' editor halves (only main.tsx loads them, through editorBoot.ts)", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "editor"))) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (/^plugins\/[^/]+\/editor(\/|$)/.test(r) || (/^plugins\/(editor|editorBoot)(\.ts)?$/.test(r) && rel(f) !== "editor/main.tsx")) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("plugin to plugin imports (ADR 0133, 0136)", () => {
  /** The plugin folders: each has a manifest. */
  const pluginDirs = readdirSync(join(SRC, "plugins")).filter((d) => {
    try {
      return statSync(join(SRC, "plugins", d, "manifest.ts")).isFile();
    } catch {
      return false;
    }
  });
  /** Plugin names a plugin's manifest lists under `dependencies`. */
  const dependencies = (dir: string): string[] => {
    const text = readFileSync(join(SRC, "plugins", dir, "manifest.ts"), "utf8");
    const block = /dependencies\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
    return [...block.matchAll(/["']([^"']+)["']\s*:/g)].map((m) => m[1]!);
  };
  const nameOf = (dir: string): string => /name:\s*["']([^"']+)["']/.exec(readFileSync(join(SRC, "plugins", dir, "manifest.ts"), "utf8"))?.[1] ?? dir;

  it("finds the plugin folders (the scan works)", () => expect(pluginDirs).toEqual(expect.arrayContaining(["tilemaps", "physics2d", "sky"])));

  it("imports another plugin only through its runtime/index.ts, and type-only unless the manifest depends on it", () => {
    const bad: string[] = [];
    for (const dir of pluginDirs) {
      const deps = dependencies(dir);
      for (const f of files(join(SRC, "plugins", dir))) {
        if (/\.test\.tsx?$/.test(f)) continue;
        for (const { spec, typeOnly } of specifiers(f)) {
          const target = resolved(f, spec);
          if (!target.startsWith("/")) continue;
          const m = /^plugins\/([^/]+)(\/.*)?$/.exec(rel(target));
          if (!m || m[1] === dir || !pluginDirs.includes(m[1]!)) continue;
          if (!/^\/runtime(\/index(\.ts)?)?$/.test(m[2] ?? "")) bad.push(`${rel(f)} imports ${spec}: only another plugin's runtime/index.ts`);
          else if (!typeOnly && !deps.includes(nameOf(m[1]!))) bad.push(`${rel(f)} imports ${spec}: a value import needs ${nameOf(m[1]!)} in its manifest's dependencies`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps Physics 2D and Tilemaps apart: 2D colliders read core shape sources (ADR 0136)", () => {
    const touches = (dir: string, other: string) =>
      files(join(SRC, "plugins", dir)).some((f) => specifiers(f).some(({ spec }) => resolved(f, spec).startsWith("/") && rel(resolved(f, spec)).startsWith(`plugins/${other}/`)));
    expect(touches("physics2d", "tilemaps")).toBe(false);
    expect(touches("tilemaps", "physics2d")).toBe(false);
  });
});
