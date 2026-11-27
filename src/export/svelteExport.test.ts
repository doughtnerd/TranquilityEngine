import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject } from "../engine";
import { World } from "../engine/core/World";
import { UIButton, UIText } from "../engine/ui/components";
import { UIPointer } from "../engine/tests/uiPointer";
import { UIView } from "../plugins/ui/runtime/UIView";
import { typescript } from "../editor/moduleImports";
import { collectUIRuntimeFiles, type UIRuntimeSource } from "../projectCode/uiBundle";
import { UI_HOST_FILE } from "../projectCode/uiModules";
import { nodeUIRuntimeSource } from "../server/packages";
import { uiHostEntry } from "../../vite.shared";
import { planWebBuild, type BuildSource, type WebBuildPlan } from "./webBuild";

// ADR 0423 wave A part 2, ADR 0425: a game build compiles the project's Svelte UI (dev: false) with CSS as parsed rule
// data, and bundles it with the parts of Svelte's runtime and the engine's renderer it uses into the game's own code,
// tree-shaken: one Svelte instance per game, never `svelte/compiler`, and the player carries no Svelte. Each
// component's module mounts itself (`$mount`), which `UIView` calls; the player serves each as its file's asset.

beforeAll(() => typescript().then(() => undefined), 60_000);
vi.setConfig({ testTimeout: 120_000 }); // the first build loads svelte/compiler and esbuild

const DT = 1 / 60;

const UI: Record<string, string> = {
  "ui/Hud.svelte": `<script lang="ts">
  import "./theme.css";
  import Badge from "./Badge.svelte";
  import { score } from "./score.svelte";
  let { title }: { title: string } = $props();
  let clicks = $state(0);
</script>

<section id="hud">
  <h1 id="title" class="title">{title}</h1>
  <Badge label="Score" value={score.value} />
  <button id="more" onclick={() => clicks++}>More</button>
  <p id="clicks">Clicks: {clicks}</p>
</section>

<style>
  .title { font-size: 30px; }
  :global(:root) { --badge: #00ff00; }
</style>
`,
  "ui/Badge.svelte": `<script lang="ts">
  let { label, value }: { label: string; value: number } = $props();
</script>

<p id="badge" class="badge">{label}: {value}</p>

<style>
  .badge { color: var(--badge); }
</style>
`,
  "ui/score.svelte.ts": "export const score = $state({ value: 7 });\n",
  "ui/theme.css": ".title { color: #ff8800; }\n",
  "ui/unused.css": ".title { color: #000000; }\n",
};

/** A script that changes the rune module's state: it must see the bundle's instance. */
const SCRIPTS = new Map([["scripts/bump.ts", 'import { score } from "../ui/score.svelte";\nexport function bump(): void {\n  score.value++;\n}\n']]);

function source(ui: Record<string, string> = UI, uiRuntime: UIRuntimeSource = nodeUIRuntimeSource()): BuildSource {
  const json = new Map([["project.json", '{ "name": "Svelte Game" }'], ["scenes/main.scene.json", "{}"]]);
  return { name: "svelte", settings: { name: "Svelte Game" }, files: [...json.keys(), ...SCRIPTS.keys(), ...Object.keys(ui)], scripts: SCRIPTS, json, ui: new Map(Object.entries(ui)), uiRuntime };
}

/** The import specifiers in minified or compiled code. */
const importsOf = (code: string) => [...code.matchAll(/(?:import|from)\s*["']([^"']+)["']/g)].map((m) => m[1]);

/** The files the UI bundle wrote: the UI modules' entries and the shared chunks. */
const uiFiles = (plan: WebBuildPlan) => [...plan.generated].filter(([p]) => p.startsWith("code/ui/") || p.startsWith("code/ui-runtime/"));

let plans: Promise<WebBuildPlan> | null = null;
/** The HUD project's plan, built once (bundling takes a few seconds). */
const hudPlan = () => (plans ??= planWebBuild(source()));

let dir: string | null = null;
let engine: Engine | null = null;
let pointer: UIPointer | null = null;

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine?.dispose();
  engine = null;
  Assets.setCompiledModules(new Map());
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("exporting Svelte UI", () => {
  it("bundles components, rune modules and imported .css with the runtime into the build's code; the sources don't ship", async () => {
    const plan = await hudPlan();
    expect(plan.manifest.scripts).toEqual([
      { source: "ui/score.svelte.ts", module: "code/ui/score.svelte.ts.js" },
      { source: "scripts/bump.ts", module: "code/scripts/bump.js" },
      { source: "ui/Badge.svelte", module: "code/ui/Badge.svelte.js" },
      { source: "ui/theme.css", module: "code/ui/theme.css.js" },
      { source: "ui/Hud.svelte", module: "code/ui/Hud.svelte.js" },
    ]);
    expect(plan.copies).toEqual(["project.json", "scenes/main.scene.json", "ui/theme.css", "ui/unused.css"]);
    // Every module the player imports is a file of the build at that address (on Windows, too, where esbuild's output paths are the drive's).
    for (const { module } of plan.manifest.scripts) expect(plan.generated.has(module), module).toBe(true);
    for (const path of plan.generated.keys()) expect(path, path).not.toMatch(/^[A-Za-z]:|^\/|\\/);
    // Every import is a file of the build: the bundle's chunks, and the player's UI host entry beside myco.js. No bare
    // `svelte/*` import is left for the player to provide.
    const ui = uiFiles(plan);
    for (const [path, code] of ui) {
      for (const spec of importsOf(code)) {
        expect(spec, `${path} imports ${spec}`).toMatch(/^\.\.?\//);
        expect(spec.endsWith(UI_HOST_FILE) ? spec : "", `${path} imports ${spec}`).toBe(spec.endsWith(UI_HOST_FILE) ? `../../${UI_HOST_FILE}` : "");
      }
    }
    expect(ui.some(([, code]) => importsOf(code).some((s) => s.endsWith(`/${UI_HOST_FILE}`)))).toBe(true);
    // The script imports the rune module's entry, the bundle's own instance.
    expect(importsOf(plan.generated.get("code/scripts/bump.js")!)).toEqual(["../ui/score.svelte.ts.js"]);
    for (const code of [...plan.generated].filter(([p]) => p.startsWith("code/")).map(([, c]) => c)) {
      expect(code).not.toMatch(/svelte\/compiler|css-tree|parseStylesheet/);
      expect(code).not.toMatch(/add_locations|FILENAME|Svelte error/); // not dev mode, nor Svelte's dev runtime
    }
    // Styles ship as the cascade's rule data.
    expect(ui.map(([, c]) => c).join("\n")).toContain(`selectorText:".title"`);
  });

  it("carries only the runtime the game uses: a keyed {#each} brings the each block, a HUD without one doesn't", async () => {
    const hud = uiFiles(await hudPlan()).map(([, c]) => c).join("\n");
    const list = `<script lang="ts">\n  let { items }: { items: { id: string; label: string }[] } = $props();\n</script>\n\n{#each items as item (item.id)}<p>{item.label}</p>{/each}\n`;
    const withList = uiFiles(await planWebBuild(source({ ...UI, "ui/List.svelte": list }))).map(([, c]) => c).join("\n");
    expect(hud).not.toContain("svelte.dev/e/each_key_duplicate");
    expect(withList).toContain("svelte.dev/e/each_key_duplicate");
    expect(withList.length).toBeGreaterThan(hud.length);
  });

  it("bundles the same code from the files the editor serves as from the engine's folder", async () => {
    const node = nodeUIRuntimeSource();
    const files = await collectUIRuntimeFiles(node.files);
    expect([...files.keys()].some((p) => p.startsWith("node_modules/svelte/src/internal/client/"))).toBe(true);
    expect([...files.keys()].some((p) => p.includes("/compiler/"))).toBe(false);
    const served: UIRuntimeSource = { files: { read: async (p) => files.get(p) ?? null }, esbuild: node.esbuild };
    const fromServed = await planWebBuild(source(UI, served));
    expect(new Map(uiFiles(fromServed))).toEqual(new Map(uiFiles(await hudPlan())));
  });

  it("compiles the engine's built-in UI a project uses into its code (0423 wave B), and none that it doesn't", async () => {
    expect((await hudPlan()).manifest.scripts.some((s) => s.source.startsWith("@myco/"))).toBe(false);
    const scene = JSON.stringify({ format: "myco.scene@1", nodes: [{ name: "Controls", components: [{ type: "engine.UIControlMapper" }] }] });
    const json = new Map([["project.json", '{ "name": "Mapper" }'], ["scenes/main.scene.json", scene]]);
    const plan = await planWebBuild({ name: "mapper", settings: { name: "Mapper" }, files: [...json.keys()], scripts: new Map(), json, uiRuntime: nodeUIRuntimeSource() });
    expect(plan.manifest.scripts).toEqual([{ source: "@myco/ui/ControlMapper.svelte", module: "code/@myco/ui/ControlMapper.svelte.js" }]);
    expect(plan.copies).not.toContain("@myco/ui/ControlMapper.svelte");
    const code = [...plan.generated].filter(([p]) => p.startsWith("code/")).map(([, c]) => c).join("\n");
    expect(code).toContain("$mount");
    expect(code).not.toMatch(/svelte\/compiler|css-tree|parseStylesheet/);
    const { uiRuntime: _, ...withoutRuntime } = { name: "mapper", settings: { name: "Mapper" }, files: [...json.keys()], scripts: new Map<string, string>(), json, uiRuntime: nodeUIRuntimeSource() };
    await expect(planWebBuild(withoutRuntime)).rejects.toThrow(/uses UIControlMapper, whose built-in UI needs the engine's Svelte runtime/);
  });

  it("a project with Svelte UI can't be built without the runtime", async () => {
    const { uiRuntime: _, ...withoutRuntime } = source();
    await expect(planWebBuild(withoutRuntime)).rejects.toThrow(/ui\/Hud\.svelte: the UI runtime \(Svelte\) didn't load: this build has no Svelte runtime/);
  });

  it("stays small: the HUD's UI code is within its tripwire (ADR 0425: measured + 20%)", async () => {
    const ui = uiFiles(await hudPlan());
    const gzip = ui.reduce((sum, [, code]) => sum + gzipSync(code).length, 0);
    // Measured 2026-11-26 (Svelte 5.59.2, esbuild 0.28.2): 24.9 KB gzip for the HUD's components, rule data, Svelte and the renderer
    // at 0425; 30.6 KB once waves Y1-Y3 grew the renderer (window units and matchMedia, animate/measure, event propagation, scrolling);
    // 36.9 KB at Z3 (form elements, SVG, media, inline runs and {@html}, then Svelte's frames and clock on the engine frame).
    // 38.2 KB (38,221 bytes) after Z1-Z2 (form bindings, SVG, media, 0429's runs and `html` hook) and the conformance triage's
    // Element-subset members (reflected attributes, namespaces, stepUp, booleans as the DOM writes them).
    expect(gzip).toBeLessThan(MEASURED_GZIP * 1.2);
  });

  it("mounts in the player's layout through UIView: props are reactive, events reach handlers, scripts share the state", async () => {
    const plan = await hudPlan();
    dir = mkdtempSync(join(tmpdir(), "myco-svelte-export-"));
    const write = (path: string, text: string) => {
      const full = join(dir!, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    for (const [path, text] of plan.generated) if (path.startsWith("code/")) write(path, text);
    // The player's UI host entry, as its build makes it (re-exporting the engine modules the renderer imports).
    const host = uiHostEntry();
    const load = host.plugin.load as (this: { addWatchFile(f: string): void }, id: string) => string;
    write(UI_HOST_FILE, load.call({ addWatchFile: () => {} }, Object.values(host.input)[0]));
    // What the player does: import the modules in order, and serve each component as its file's asset value.
    const components = new Map<string, unknown>();
    const modules = new Map<string, Record<string, unknown>>();
    for (const s of plan.manifest.scripts) {
      const module = (await import(/* @vite-ignore */ pathToFileURL(join(dir, ...s.module.split("/"))).href)) as Record<string, unknown>;
      modules.set(s.source, module);
      if (s.source.endsWith(".svelte")) components.set(s.source, module);
    }
    Assets.setCompiledModules(components);
    expect(typeof modules.get("ui/Hud.svelte")!.$mount).toBe("function");

    engine = await Engine.create({ headless: true });
    const view = GameObject.create("HUD").addBehavior(UIView, { component: "asset:ui/Hud.svelte", props: { title: "Shipped" } });
    await view.ready;
    const title = view.query("#title")!.as(UIText);
    expect(title.text).toBe("Shipped");
    expect(title.fontSize).toBe(30);
    expect(title.color).toEqual(Color.from("#ff8800"));
    expect(view.query("#badge")!.as(UIText).text).toBe("Score: 7");
    expect(view.query("#badge")!.as(UIText).color).toEqual(Color.from("#00ff00"));

    view.props.title = "Changed";
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Changed");

    pointer = await UIPointer.create(World.require());
    pointer.click(view.query("#more")!.as(UIButton));
    engine.step(DT);
    expect(view.query("#clicks")!.as(UIText).text).toBe("Clicks: 1");

    (modules.get("scripts/bump.ts")!.bump as () => void)();
    engine.step(DT);
    expect(view.query("#badge")!.as(UIText).text).toBe("Score: 8");
  });
});

/** The HUD's UI code, gzip bytes per file summed, as measured (the tripwire is 20% above it). */
const MEASURED_GZIP = 38_200;
