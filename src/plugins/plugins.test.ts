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

  it("only the player, the server, the editor's plugin set, the tests' plugin set and myco.ts import the runtime plugin list", () => {
    const importers: string[] = [];
    for (const f of files(SRC)) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        if (target.startsWith("/") && /^plugins\/runtime(\.ts)?$/.test(rel(target))) importers.push(rel(f));
      }
    }
    // myco.ts: the default activation for games built on the engine library (ADR 0135).
    expect(importers.sort()).toEqual(["myco.ts", "player/main.ts", "plugins/editorPlugins.ts", "plugins/testPlugins.ts", "server/run.ts"]);
  });

  it("lets a plugin reach another only through its public module (ADR 0133): `plugins/<other>/runtime`", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "plugins"))) {
      if (/\.test\.tsx?$/.test(f)) continue;
      const own = /^plugins\/([^/]+)\//.exec(rel(f))?.[1];
      if (!own) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        if (!target.startsWith("/")) continue;
        const m = /^plugins\/([^/]+)\/(.+)$/.exec(rel(target));
        if (!m || m[1] === own) continue;
        if (!/^runtime(\/index)?(\.ts)?$/.test(m[2])) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the editor core free of plugins' code: it reaches them through contribution points (ADR 0146; only main.tsx loads them, through editorBoot.ts)", () => {
    // The plugin host modules directly under src/plugins/ (manifests, ordering, enabling, the runtime list, third-party
    // loading) are the plugin system itself, which the shell drives; every file in a plugin's folder is off limits.
    const HOST = new Set(["manifest", "order", "enabled", "runtime", "runtimeContext", "thirdParty", "thirdPartyEditor", "pluginSet", "editorPlugins", "editorActivator"]);
    const bad: string[] = [];
    for (const f of files(join(SRC, "editor"))) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const { spec } of specifiers(f)) {
        const target = resolved(f, spec);
        const r = target.startsWith("/") ? rel(target) : target;
        if (!r.startsWith("plugins/")) continue;
        const host = /^plugins\/([^/]+?)(\.ts)?$/.exec(r)?.[1];
        if (host && HOST.has(host)) continue;
        if (host === "editorBoot" && rel(f) === "editor/main.tsx") continue;
        bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("plugin editor halves reach the editor through its SDK (ADR 0147)", () => {
  /**
   * The internal tier (ADR 0133): shell modules first-party editor halves may still import, as
   * `<file under src/plugins/> -> <module under src/editor/>`. Nothing may be added; an entry is
   * removed once its import goes (the test fails on stale entries), so the list only shrinks.
   */
  const INTERNAL = new Set([
    // The play session's Worlds, for Navigation's debug overlays and panel. Internal like viewport tools,
    // which are handed the World (ADR 0138): a play World is engine internals.
    "plugins/navigation/editor/NavDebugPanel.tsx -> editor/session",
    "plugins/navigation/editor/navGizmo.ts -> editor/playMode",
    "plugins/navigation/editor/navGizmo.ts -> editor/state",
    // The Audio plugin's occlusion overlay (ADR 0162 E4) draws in every World of the play session, as Navigation's does.
    "plugins/audio/editor/OcclusionOverlay.ts -> editor/playMode",
    "plugins/audio/editor/OcclusionOverlay.ts -> editor/state",
    // Baking builds a hidden editor World from the project's settings (ADR 0065): same reason.
    "plugins/navigation/editor/navBake.ts -> editor/projects",
    // The collider gizmo snaps like the transform gizmo (ADR 0142): the scene view's snapping is viewport-tool internals.
    "plugins/physics/editor/colliderGizmo.ts -> editor/sceneTools",
    // Polygon area and hit tests, shared with the shell's marquee selection: geometry, not editor API.
    "plugins/physics/editor/colliderMath.ts -> editor/polygonMath",
    // The Physics section owns project.json's `physics` (ADR 0151), but renaming a layer rewrites the scenes
    // and prefabs that name it, asking first: the shell's project-wide layer rename (ADR 0116).
    "plugins/physics/editor/PhysicsSettingsSection.tsx -> editor/layerRenameEdit",
    // Extract Materials (ADR 0089) writes material assets and the model's sidecar through the shell's import
    // settings writer, which the SDK doesn't offer; the model import settings moved here with ADR 0143.
    "plugins/meshes/editor/ModelImportSettings.tsx -> editor/materialExtract",
    // Shared stylesheets (class names, no code): the asset Inspector's, the bake sections' and the graph view's.
    "plugins/materials/editor/MaterialInspector.tsx -> editor/ui/assetInspector.css",
    "plugins/navigation/editor/FormationInspector.tsx -> editor/ui/assetInspector.css",
    "plugins/navigation/editor/NavGroupSection.tsx -> editor/ui/assetInspector.css",
    "plugins/particles/editor/ui/ParticleInspector.tsx -> editor/ui/assetInspector.css",
    "plugins/tilemaps/editor/TilesetInspector.tsx -> editor/ui/assetInspector.css",
    "plugins/navigation/editor/NavChunkInspector.tsx -> editor/ui/bake.css",
    "plugins/navigation/editor/NavComponentInspectors.tsx -> editor/ui/bake.css",
    "plugins/materials/editor/ShaderGraphPanel.tsx -> editor/graph/graph.css",
    "plugins/particles/editor/ui/particleGraph/GraphEditor.tsx -> editor/graph/graph.css",
  ]);
  const editorHalves = files(join(SRC, "plugins")).filter((f) => /^plugins\/[^/]+\/editor\//.test(rel(f)) && !/\.test\.tsx?$/.test(f));
  const shellImports = editorHalves.flatMap((f) =>
    specifiers(f)
      .map(({ spec }) => resolved(f, spec))
      .filter((t) => t.startsWith("/") && /^editor\//.test(rel(t)))
      .map((t) => ({ file: rel(f), module: rel(t).replace(/\.tsx?$/, "") })),
  );

  it("finds the editor halves (the scan works)", () => {
    expect(editorHalves.length).toBeGreaterThan(50);
    expect(shellImports.some((i) => i.module === "editor/sdk")).toBe(true);
  });

  it("imports src/editor only through `editor/sdk` (what `myco/editor` resolves to), apart from the internal tier", () => {
    const bad = shellImports.filter((i) => !/^editor\/sdk(\/index)?$/.test(i.module) && !INTERNAL.has(`${i.file} -> ${i.module}`)).map((i) => `${i.file} -> ${i.module}`);
    expect(bad).toEqual([]);
  });

  it("keeps the SDK's own imports clear of the plugins: no cycle leaves an editor half reading an unfinished `myco/editor`", () => {
    // Plugin modules call the SDK at load (`persisted(…)`); if `editor/sdk` reached the plugin list
    // (through session.ts → editorPlugins.ts), they would run while it is still loading.
    const asFile = (p: string) => [p, `${p}.ts`, `${p}.tsx`, join(p, "index.ts"), join(p, "index.tsx")].find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
    const seen = new Set<string>();
    const queue = [join(SRC, "editor/sdk/index.ts")];
    while (queue.length) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      // Static value imports only: `import type` is erased and `import()` loads later.
      for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\sfrom\s+)?["'](\.[^"']+)["']/gm)) {
        const spec = m[1]!;
        if (spec.endsWith(".css")) continue;
        const next = asFile(resolved(f, spec));
        if (next && /\.tsx?$/.test(next)) queue.push(next);
      }
    }
    expect([...seen].map(rel).filter((r) => /^plugins\//.test(r) && !/^plugins\/(manifest|order)\.ts$/.test(r))).toEqual([]);
  });

  it("keeps the internal tier's list current: an entry goes once its import does", () => {
    const used = new Set(shellImports.map((i) => `${i.file} -> ${i.module}`));
    expect([...INTERNAL].filter((e) => !used.has(e))).toEqual([]);
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

  it("finds the plugin folders (the scan works)", () => expect(pluginDirs).toEqual(expect.arrayContaining(["tilemaps", "physics", "sky"])));

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

  it("keeps Physics and Tilemaps apart: 2D colliders read core shape sources (ADR 0136)", () => {
    const touches = (dir: string, other: string) =>
      files(join(SRC, "plugins", dir)).some((f) => specifiers(f).some(({ spec }) => resolved(f, spec).startsWith("/") && rel(resolved(f, spec)).startsWith(`plugins/${other}/`)));
    expect(touches("physics", "tilemaps")).toBe(false);
    expect(touches("tilemaps", "physics")).toBe(false);
    expect(touches("physics-rapier", "tilemaps")).toBe(false);
    expect(touches("tilemaps", "physics-rapier")).toBe(false);
  });
});
