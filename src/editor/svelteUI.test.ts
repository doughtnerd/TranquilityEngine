import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject } from "../engine";
import { UIText } from "../engine/ui/components";
import { UIView } from "../plugins/ui/runtime/UIView";
import { loadedScriptModule, replaceScripts } from "./scriptLoader";
import { MemoryFileSystem } from "./memoryFs";
import { joinPath, openFolderProject, useProjectAssets } from "./projects";
import { currentProject, playState, scriptProblems, status } from "./state";
import { saveCodeFile } from "./session";
import { loadProjectCode } from "../plugins/thirdPartyEditor";
import { kindCreators } from "./assetKindHost";
import { useCoreAssetKinds } from "./testing";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { uiEditorPlugin } from "../plugins/ui/editor";


// ADR 0419 wave A part 2: a project's Svelte UI compiles in the editor with its scripts (the project code
// linker's memory target, dev mode), each component becomes its `.svelte` file's asset value, a `UIView`
// mounts it, and loading again after a save remounts the view with its props (hot reload).

const DT = 1 / 60;

const hud = (version: string) => `<script lang="ts">
  import "./theme.css";
  import Badge from "./Badge.svelte";
  import { score } from "./score.svelte";
  let { title }: { title: string } = $props();
</script>

<section id="hud">
  <h1 id="title" class="title">{title} ${version}</h1>
  <Badge label="Score" value={score.value} />
</section>

<style>
  .title { font-size: 30px; }
</style>
`;

const files = (version = "v1", extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({
      "ui/Hud.svelte": hud(version),
      "ui/Badge.svelte": `<script lang="ts">
  let { label, value }: { label: string; value: number } = $props();
</script>

<p id="badge" class="badge">{label}: {value}</p>

<style>
  .badge { color: #00ff00; }
</style>
`,
      "ui/score.svelte.ts": "export const score = $state({ value: 0 });\nexport function add(n: number): void {\n  score.value += n;\n}\n",
      "ui/theme.css": ".title { color: #ff8800; }\n:root { --unused: 1px; }\n",
      // Not imported by any component: never loaded, so its rules don't apply.
      "ui/other.css": ".title { color: #000000; }\n",
      // A UI document's stylesheet: not UI code.
      "ui/menu.ui.css": "Text { color: #123456; }\n",
      ...extra,
    }),
  );

let engine: Engine;

// The first link loads svelte/compiler and TypeScript: seconds when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  engine = await Engine.create({ headless: true, kind: "editor" });
});

afterEach(async () => {
  engine.dispose();
  await replaceScripts(new Map(), new Map());
});

async function mount(props: Record<string, unknown>): Promise<UIView> {
  const view = GameObject.create("HUD").addBehavior(UIView, { component: "asset:ui/Hud.svelte", props });
  await view.ready;
  return view;
}

describe("Svelte UI in the editor", () => {
  it("compiles components, rune modules and imported .css with the scripts; a UIView mounts the component", async () => {
    const result = await replaceScripts(new Map(), new Map(), undefined, [], files());
    expect(result.problems).toEqual([]);
    expect([...result.loaded].sort()).toEqual(["ui/Badge.svelte", "ui/Hud.svelte", "ui/score.svelte.ts", "ui/theme.css"]);
    expect(Assets.has("ui/Hud.svelte")).toBe(true);

    const view = await mount({ title: "Hi" });
    const title = view.query("#title")!.as(UIText);
    expect(title.text).toBe("Hi v1");
    expect(title.fontSize).toBe(30); // the component's scoped style
    expect(title.color).toEqual(Color.from("#ff8800")); // theme.css, imported by the component, applies globally
    expect(view.query("#badge")!.as(UIText).text).toBe("Score: 0");
    expect(view.query("#badge")!.as(UIText).color).toEqual(Color.from("#00ff00"));

    // The rune module is shared state: a script importing it changes what the view shows.
    const runes = loadedScriptModule("ui/score.svelte.ts");
    ((await runes) as { add(n: number): void }).add(5);
    engine.step(DT);
    expect(view.query("#badge")!.as(UIText).text).toBe("Score: 5");
  });

  it("hot reloads: loading a changed component remounts mounted views with their props; a compile error keeps the last version", async () => {
    await replaceScripts(new Map(), new Map(), undefined, [], files());
    const view = await mount({ title: "Hi" });
    view.props.title = "Yo";
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo v1");
    const before = view.query("#title")!.node;

    // Saving the component reloads the project's code: the new module is the asset's value; the view mounts it next frame.
    expect((await replaceScripts(new Map(), new Map(), undefined, [], files("v2"))).problems).toEqual([]);
    engine.step(DT);
    expect(before.isValid).toBe(false);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo v2");

    // A compile error is a problem on the file (with its line, as a script's); the view keeps showing the last version.
    const broken = await replaceScripts(new Map(), new Map(), undefined, [], files("v3", { "ui/Hud.svelte": hud("v3").replace("</section>", "{#if title}</section>") }));
    expect(broken.problems).toEqual([{ path: "ui/Hud.svelte", message: expect.stringMatching(/^line \d+: /) }]);
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo v2");

    // Fixed: it mounts again.
    await replaceScripts(new Map(), new Map(), undefined, [], files("v4"));
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo v4");
  });

  it("reports what UI code can't import", async () => {
    const result = await replaceScripts(new Map(), new Map(), undefined, [], files("v1", { "ui/Bad.svelte": `<script>import x from "./missing.svelte";</script><p>{x}</p>` }));
    expect(result.problems).toEqual([{ path: "ui/Bad.svelte", message: `can't find "./missing.svelte"` }]);
  });
});

describe("Svelte UI in an open project", () => {
  useCoreAssetKinds();
  useEditorPlugins([uiEditorPlugin], "each");
  const ROOT = "C:\\Games\\svelte";

  afterEach(() => {
    currentProject.value = null;
    playState.value = "edit";
  });

  async function openProject(): Promise<void> {
    const fs = new MemoryFileSystem();
    const project = { "project.json": JSON.stringify({ name: "Svelte UI" }), ...Object.fromEntries(files()) };
    for (const [path, text] of Object.entries(project)) fs.files.set(joinPath(ROOT, path), text);
    const opened = await openFolderProject(fs, ROOT);
    useProjectAssets(opened);
    currentProject.value = opened;
    const loaded = await loadProjectCode(opened); // what opening a project does
    expect(loaded.problems).toEqual([]);
  }

  it("compiles the project's components on open, and again when one is saved in the Code panel (hot reload)", async () => {
    await openProject();
    const view = await mount({ title: "Hi" });
    view.props.title = "Yo";
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo v1");

    await saveCodeFile("ui/Hud.svelte", hud("saved"));
    expect(scriptProblems.value).toEqual([]);
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo saved");

    // A compile error is reported in the status line like a script's.
    await saveCodeFile("ui/Hud.svelte", hud("broken").replace("</section>", "{#if title}</section>"));
    expect(scriptProblems.value).toEqual([{ path: "ui/Hud.svelte", message: expect.stringMatching(/^line \d+: /) }]);
    expect(status.value).toMatchObject({ kind: "error", text: expect.stringContaining("ui/Hud.svelte") });
    engine.step(DT);
    expect(view.query("#title")!.as(UIText).text).toBe("Yo saved");
  });

  it("New Svelte Component writes a starter component in ui/ that compiles, ready for a UIView", async () => {
    await openProject();
    const create = kindCreators().find((c) => c.label === "New Svelte Component")!;
    expect(create.kind).toBe("svelte");
    const path = await create.create("ui");
    expect(path).toBe("ui/NewComponent.svelte");
    expect(scriptProblems.value).toEqual([]);
    const view = GameObject.create("New").addBehavior(UIView, { component: `asset:${path}` });
    await view.ready;
    expect(view.query("h1")!.as(UIText).text).toBe("New Component");
    expect(view.query("h1")!.as(UIText).fontSize).toBe(32);
  });
});
