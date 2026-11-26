import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Assets, Color, Engine, GameObject } from "../engine";
import { UIText } from "../engine/ui/components";
import { UIView } from "../plugins/ui/runtime/UIView";
import { loadUIRuntimeModule } from "../plugins/ui/svelte/runtimeModules";
import { typescript } from "../editor/moduleImports";
import { UI_RUNTIME_SPECIFIERS, uiRuntimeFile } from "../projectCode/uiModules";
import { planWebBuild, type BuildSource } from "./webBuild";

// ADR 0419 wave A part 2: a game build compiles the project's Svelte UI (dev: false) into its code, with CSS as
// parsed rule data, importing Svelte's runtime and the renderer from the player's fixed-name entries
// (`svelte/internal/client.js`…), never `svelte/compiler`; the player serves each component as its file's asset.

beforeAll(() => typescript().then(() => undefined), 60_000);

const UI: Record<string, string> = {
  "ui/Hud.svelte": `<script lang="ts">
  import "./theme.css";
  import Badge from "./Badge.svelte";
  import { score } from "./score.svelte";
  let { title }: { title: string } = $props();
</script>

<section id="hud">
  <h1 id="title" class="title">{title}</h1>
  <Badge label="Score" value={score.value} />
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

function source(): BuildSource {
  const json = new Map([["project.json", '{ "name": "Svelte Game" }'], ["scenes/main.scene.json", "{}"]]);
  return { name: "svelte", settings: { name: "Svelte Game" }, files: [...json.keys(), ...Object.keys(UI)], scripts: new Map(), json, ui: new Map(Object.entries(UI)) };
}

let dir: string | null = null;
let engine: Engine | null = null;

afterEach(() => {
  engine?.dispose();
  engine = null;
  Assets.setCompiledModules(new Map());
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("exporting Svelte UI", () => {
  it("compiles components, rune modules and imported .css into the build's code; the sources don't ship", async () => {
    const plan = await planWebBuild(source());
    expect(plan.manifest.scripts).toEqual([
      { source: "ui/Badge.svelte", module: "code/ui/Badge.svelte.js" },
      { source: "ui/theme.css", module: "code/ui/theme.css.js" },
      { source: "ui/score.svelte.ts", module: "code/ui/score.svelte.ts.js" },
      { source: "ui/Hud.svelte", module: "code/ui/Hud.svelte.js" },
    ]);

    expect(plan.copies).toEqual(["project.json", "scenes/main.scene.json", "ui/theme.css", "ui/unused.css"]);
    const hud = plan.generated.get("code/ui/Hud.svelte.js")!;
    // The runtime comes from the player's entries beside myco.js; nothing imports the compiler or a CSS parser.
    const specifiers = [...hud.matchAll(/(?:import|from)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(["../../svelte/internal/client.js", "../../svelte/internal/flags/custom-renderer.js", "../../svelte/myco-ui-renderer.js", "../../svelte/myco-ui-renderer.js", "./Badge.svelte.js", "./score.svelte.ts.js", "./theme.css.js"]);
    for (const code of [...plan.generated].filter(([p]) => p.startsWith("code/")).map(([, c]) => c)) {
      expect(code).not.toMatch(/svelte\/compiler|css-tree|parseStylesheet/);
      expect(code).not.toMatch(/add_locations|\$\.FILENAME/); // not compiled in dev mode
    }
    // Styles ship as the cascade's rule data.
    expect(plan.generated.get("code/ui/theme.css.js")).toContain(`"selectorText":".title"`);
  });

  it("mounts in the player's layout: compiled modules import the runtime entries by path", async () => {
    const plan = await planWebBuild(source());
    dir = mkdtempSync(join(tmpdir(), "myco-svelte-export-"));
    const write = (path: string, text: string) => {
      const full = join(dir!, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    for (const [path, text] of plan.generated) if (path.startsWith("code/")) write(path, text);
    // Stand-ins for the player's UI runtime entries the code imports, each the engine's own copy (as Rollup shares one
    // instance in the player).
    const runtime: Record<string, object> = {};
    (globalThis as { __mycoTestUIRuntime?: unknown }).__mycoTestUIRuntime = runtime;
    const code = [...plan.generated.values()].join("\n");
    for (const spec of UI_RUNTIME_SPECIFIERS.filter((s) => code.includes(`/${uiRuntimeFile(s)}`))) {

      const value = (runtime[spec] = await loadUIRuntimeModule(spec));
      const names = Object.keys(value).filter((n) => n !== "default");
      const read = `globalThis.__mycoTestUIRuntime[${JSON.stringify(spec)}]`;
      write(uiRuntimeFile(spec), `const e = ${read};\nconst { ${names.map((n, i) => `${JSON.stringify(n)}: $${i}`).join(", ")} } = e;\nexport { ${names.map((n, i) => `$${i} as ${n}`).join(", ")} };\n${"default" in value ? "export default e.default;\n" : ""}`);
    }
    // What the player does: import the scripts in order, and serve each component as its file's asset value.
    const components = new Map<string, unknown>();
    for (const s of plan.manifest.scripts) {
      const module: unknown = await import(/* @vite-ignore */ pathToFileURL(join(dir, ...s.module.split("/"))).href);
      if (s.source.endsWith(".svelte")) components.set(s.source, module);
    }
    Assets.setCompiledModules(components);

    engine = await Engine.create({ headless: true });
    const view = GameObject.create("HUD").addBehavior(UIView, { component: "asset:ui/Hud.svelte", props: { title: "Shipped" } });
    await view.ready;
    const title = view.query("#title")!.as(UIText);
    expect(title.text).toBe("Shipped");
    expect(title.fontSize).toBe(30);
    expect(title.color).toEqual(Color.from("#ff8800"));
    expect(view.query("#badge")!.as(UIText).text).toBe("Score: 7");
    expect(view.query("#badge")!.as(UIText).color).toEqual(Color.from("#00ff00"));
  });
});
