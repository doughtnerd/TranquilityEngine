// The game player (ADR 0041): a prebuilt page that runs whichever project is exported beside it.
// It reads game.json, fetches the project's JSON files and points its binary assets at their
// URLs (scene loading looks assets up synchronously), imports the compiled scripts so they
// register their components and systems, then builds the Engine from the project's bootstrap,
// full-window, as play mode does. Start-up Worlds whose bootstrap config names no scenes load the
// manifest's main scene. Saves go to the platform's storage (ADR 0024): IndexedDB in a browser,
// the app data folder in a desktop package.
//
// The engine is the build's myco.js (a separate entry of the player bundle), which the compiled
// scripts import too, so the game and its scripts share one engine.
import * as engine from "../myco";
import { activateGamePlugins } from "../plugins/runtime";
import { Assets, Engine, type Bootstrap, type ProjectSettingsInput } from "../engine";
import { engineWorld, engineWorldConfig, setScriptAssetRefs } from "../engine/editor";
import { toRuntimePlugin } from "../plugins/thirdParty";
import type { RuntimePlugin } from "../plugins/runtimeContext";
import { MANIFEST_FILE, MANIFEST_FORMAT, PROJECT_DIR, type GameManifest } from "../export/format";

/** A build file's URL, from its "/"-separated path. */
const urlOf = (path: string) => new URL(path.split("/").map(encodeURIComponent).join("/"), document.baseURI).href;

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(urlOf(path));
  if (!res.ok) throw new Error(`Couldn't load ${path} (HTTP ${res.status}).`);
  return res;
}

async function boot(): Promise<void> {
  if (location.protocol === "file:") return; // player.html explains
  // For tests and the console, as in the editor: the engine module and the running Engine.
  (globalThis as { __myco?: unknown }).__myco = engine;

  const manifest = (await (await fetchOk(MANIFEST_FILE)).json()) as GameManifest;
  if (manifest.format !== MANIFEST_FORMAT) throw new Error(`This player reads game.json format ${MANIFEST_FORMAT}, but the game is format ${manifest.format}. Export it again.`);
  document.title = manifest.name;

  const values = new Map<string, unknown>();
  await Promise.all(
    manifest.files.map(async (path) => {
      const at = `${PROJECT_DIR}/${path}`;
      if (/\.json$/i.test(path)) values.set(path, await (await fetchOk(at)).json());
      else if (/\.(js|xml|css|wgsl|glsl)$/i.test(path)) values.set(path, await (await fetchOk(at)).text()); // text assets (scripts, UI documents and stylesheets, shader code), as the editor serves them
      else values.set(path, urlOf(at));
    }),
  );
  Assets.addSource({ has: (p) => values.has(p), get: (p) => values.get(p) });

  const settings = (values.get("project.json") ?? {}) as ProjectSettingsInput;
  setScriptAssetRefs(manifest.assetRefs ?? []); // warmed up with every scene (ADR 0080)
  for (const script of manifest.scripts) await import(/* @vite-ignore */ urlOf(script.module));
  // Third-party plugins' runtime halves (ADR 0139): the build holds only enabled ones, in dependency order.
  const thirdParty: RuntimePlugin[] = [];
  for (const p of manifest.plugins ?? []) {
    const module = (await import(/* @vite-ignore */ urlOf(p.module))) as Record<string, unknown>;
    thirdParty.push(toRuntimePlugin({ manifest: p.manifest, source: { kind: "project", folder: "" }, where: p.module, runtime: p.module }, module));
  }
  // The plugin set (ADR 0144): first-party runtime halves (ADR 0135) and the third-party ones, minus what
  // project.json turns off (ADR 0133). A plugin that fails to activate stops the game, like a broken script.
  activateGamePlugins(thirdParty, { disabled: settings.plugins?.disabled });
  const moduleOf = (path: string) => manifest.scripts.find((s) => s.source === path.replace(/^\.?\//, ""))?.module;
  const loadScript = async (path: string): Promise<Bootstrap> => {
    const module = moduleOf(path);
    if (!module) throw new Error(`The bootstrap script "${path}" isn't in this build.`);
    return ((await import(/* @vite-ignore */ urlOf(module))) as { bootstrap: Bootstrap }).bootstrap;
  };

  document.body.style.background = settings.display?.backgroundColor ?? "#000";
  const container = document.getElementById("game")!;
  const runtime = await Engine.create({ container, project: settings, loadScript });
  if (manifest.mainScene) {
    for (const handle of runtime.worlds()) {
      const named = engineWorldConfig(runtime, handle.name)?.scenes !== undefined;
      if (!named && engineWorld(runtime, handle.name)!.sceneNodes.length === 0) await handle.loadScene(manifest.mainScene);
    }
  }
  runtime.start();
  (window as { engine?: Engine }).engine = runtime;
  container.querySelector("canvas")?.focus(); // keyboard input without a click first
  // The Export option "audio capture" (ADR 0172): F9 and the three-finger hold record the audio mix. Without it nothing is
  // imported or installed, so the build holds no listener and loads no part of the recorder.
  if (manifest.audioCapture) (await import("../plugins/audio/runtime/capture/trigger")).installCaptureTrigger();
}

boot().catch((err: unknown) => {
  console.error("[myco] The game couldn't start:", err);
  const box = document.getElementById("player-message")!;
  box.replaceChildren(Object.assign(document.createElement("div"), { textContent: `The game couldn't start.\n\n${err instanceof Error ? err.message : String(err)}` }));
  box.hidden = false;
});
