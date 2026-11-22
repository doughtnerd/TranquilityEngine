// The game player (ADR 0041): a prebuilt page that runs whichever project is exported beside it.
// It reads game.json, loads the project's files as asset values (ADR 0254: JSON parsed, text files as
// text, the rest by URL; scene loading looks assets up synchronously), and launches the game as play mode does
// (`launchGame`, ADR 0236): the compiled scripts register their components and systems, the plugins
// activate, the Engine is built full-window from the project's bootstrap, and start-up Worlds whose
// bootstrap config names no scenes load the manifest's main scene. Saves go to the platform's
// storage (ADR 0024): IndexedDB in a browser, the app data folder in a desktop package.
//
// The engine is the build's myco.js (a separate entry of the player bundle), which the compiled
// scripts import too, so the game and its scripts share one engine.
import * as engine from "../myco";
import { activateGamePlugins } from "../plugins/runtime";
import { Engine, type Bootstrap, type ProjectSettingsInput } from "../engine";
import { launchGame } from "../engine/launch";
import { loadProjectFiles } from "../engine/scene/projectFiles";
import { toRuntimePlugin } from "../plugins/thirdParty";
import type { RuntimePlugin } from "../plugins/runtimeContext";
import { MANIFEST_FILE, MANIFEST_FORMAT, PROJECT_DIR, type GameManifest } from "../export/format";
import { LEGACY_AUDIO_MESSAGE, projectWithAudio } from "../engine/audio/project/load";
import { AUDIO_PROJECT_FILE } from "../engine/audio/project/types";

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

  // Every project file as the same asset value as in the editor (ADR 0254): JSON parsed, text files' text, the rest by URL.
  const { values, problems } = await loadProjectFiles(manifest.files, {
    readText: async (path) => (await fetchOk(`${PROJECT_DIR}/${path}`)).text(),
    url: (path) => urlOf(`${PROJECT_DIR}/${path}`),
  });
  if (problems.length > 0) throw new Error(`Some of the game's JSON files don't parse: ${problems.map((p) => `${p.path} (${p.message})`).join(", ")}`);
  // The mix is audio.json's (ADR 0330): project.json's settings with its runtime view as `audio`. A project.json that
  // still has the old section is refused: the editor migrates it.
  const read = projectWithAudio(values.get("project.json") ?? {}, values.get(AUDIO_PROJECT_FILE));
  if (read.legacyAudio) throw new Error(LEGACY_AUDIO_MESSAGE);
  for (const line of [...read.problems, ...read.warnings]) console.warn(`[myco] ${AUDIO_PROJECT_FILE}: ${line}`);
  const settings: ProjectSettingsInput = read.project;
  const thirdParty: RuntimePlugin[] = [];
  const moduleOf = (path: string) => manifest.scripts.find((s) => s.source === path.replace(/^\.?\//, ""))?.module;
  document.body.style.background = settings.display?.backgroundColor ?? "#000";
  const container = document.getElementById("game")!;
  // The launch (ADR 0236): the build's files, its scripts and plugins, then the Engine; start-up Worlds whose
  // bootstrap config names no scenes load the manifest's main scene. The page never stops the game, so
  // nothing disposes the launch here (a failed launch undoes itself).
  const { engine: runtime } = await launchGame({
    assets: { has: (p) => values.has(p), get: (p) => values.get(p) },
    scriptAssetRefs: manifest.assetRefs ?? [], // warmed up with every scene (ADR 0080)
    async loadScripts() {
      for (const script of manifest.scripts) await import(/* @vite-ignore */ urlOf(script.module));
      // Third-party plugins' runtime halves (ADR 0139): the build holds only enabled ones, in dependency order.
      for (const p of manifest.plugins ?? []) {
        const module = (await import(/* @vite-ignore */ urlOf(p.module))) as Record<string, unknown>;
        thirdParty.push(toRuntimePlugin(p.manifest, p.module, module));
      }
    },
    // The plugin set (ADR 0144): first-party runtime halves (ADR 0135) and the third-party ones, minus what
    // project.json turns off (ADR 0133). A plugin that fails to activate stops the game, like a broken script.
    activatePlugins: () => activateGamePlugins(thirdParty, { disabled: settings.plugins?.disabled }),
    project: settings,
    async loadScript(path: string): Promise<Bootstrap> {
      const module = moduleOf(path);
      if (!module) throw new Error(`The bootstrap script "${path}" isn't in this build.`);
      return ((await import(/* @vite-ignore */ urlOf(module))) as { bootstrap: Bootstrap }).bootstrap;
    },
    entryScene: manifest.mainScene || null,
    container,
  });
  runtime.start();
  (window as { engine?: Engine }).engine = runtime;
  container.querySelector("canvas")?.focus(); // keyboard input without a click first
  // The Export option "audio capture" (ADR 0172): F9 and the three-finger hold record the audio mix. Without it nothing is
  // imported or installed, so the build holds no listener and loads no part of the recorder.
  if (manifest.audioCapture) (await import("../plugins/audio/runtime/capture/trigger")).installCaptureTrigger();
  // The Export option "audio takes" (ADR 0334): F10 records a take. Without it nothing is imported or installed.
  if (manifest.audioTake) {
    // `audioTakeFrames: false` keeps pictures of the game view out of takes (on by default).
    if (manifest.audioTakeFrames === false) (await import("../plugins/audio/runtime/capture/take")).setTakeFrames(false);
    (await import("../plugins/audio/runtime/capture/trigger")).installTakeTrigger();
  }
}

boot().catch((err: unknown) => {
  console.error("[myco] The game couldn't start:", err);
  const box = document.getElementById("player-message")!;
  box.replaceChildren(Object.assign(document.createElement("div"), { textContent: `The game couldn't start.\n\n${err instanceof Error ? err.message : String(err)}` }));
  box.hidden = false;
});
