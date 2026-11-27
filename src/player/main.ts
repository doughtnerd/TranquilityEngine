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
import { Engine, type Bootstrap } from "../engine";
import { launchGame } from "../engine/launch";
import { loadProjectFiles } from "../engine/scene/projectFiles";
import { toRuntimePlugin } from "../plugins/thirdParty";
import type { RuntimePlugin } from "../plugins/runtimeContext";
import { MANIFEST_FILE, PROJECT_DIR } from "../export/format";
import { buildLaunch, checkManifest, type PlayerEnvironment } from "./buildLaunch";
import { installAudioMedia } from "../plugins/audio/runtime/media/mediaTable";
import { installBuildStrings } from "../engine/localisation/runtime/boot";
import type { NetworkInterfaceAddress } from "../engine/debugLink/pairing/address";

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

  const manifest = checkManifest(await (await fetchOk(MANIFEST_FILE)).json());
  document.title = manifest.name;

  // Every project file as the same asset value as in the editor (ADR 0254): JSON parsed, text files' text, the rest by URL.
  const files = await loadProjectFiles(manifest.files, {
    readText: async (path) => (await fetchOk(`${PROJECT_DIR}/${path}`)).text(),
    url: (path) => urlOf(`${PROJECT_DIR}/${path}`),
  });
  // What the build launches with (ADR 0435): the launch settings (project.json with audio.json's mix, ADR 0344; an old
  // audio section is refused) and the launch-time decisions of its Export options.
  const launch = buildLaunch(manifest, files, {
    search: location.search,
    flags: globalThis as PlayerEnvironment["flags"],
    desktop: "__TAURI_INTERNALS__" in window,
    userAgent: navigator.userAgent,
  });
  for (const notice of launch.notices) console.warn(`[myco] ${notice}`);
  const { values } = files;
  const settings = launch.project;
  // ADR 0351 §7: the build's converted audio (packages and the media table), before any scene: its first scene's load
  // waits for the preload packages (the packages World service), as it waits for its other assets.
  installAudioMedia(manifest.audio ?? null, urlOf);
  // ADR 0356 §11: the build's string files (`strings/<code>.json`), one loaded per language switch; the start language's
  // loads with the Engine, before the first scene. A build without them reads the string tables among its files.
  installBuildStrings(manifest.localisation, urlOf);
  // ADR 0352 §8: the build's plugin audio effects, before the Engine (the core registers their modules once it is up).
  if (manifest.audioEffects?.length) {
    const { registerBuildAudioEffects } = await import("./audioEffects");
    const { effectPluginEnginesOf } = await import("../plugins/audio/runtime/effectPlugins/engineGate");
    await registerBuildAudioEffects(manifest.audioEffects, async (path) => {
      const res = await fetch(urlOf(path)).catch(() => null);
      return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    }, effectPluginEnginesOf(settings.plugins));
  }
  const thirdParty: RuntimePlugin[] = [];
  const moduleOf = (path: string) => manifest.scripts.find((s) => s.source === path.replace(/^\.?\//, ""))?.module;
  document.body.style.background = settings.display?.backgroundColor ?? "#000";
  const container = document.getElementById("game")!;
  // The launch (ADR 0236): the build's files, its scripts and plugins, then the Engine; start-up Worlds whose
  // bootstrap config names no scenes load the manifest's main scene. The page never stops the game, so
  // nothing disposes the launch here (a failed launch undoes itself).
  const { engine: runtime } = await launchGame({
    assets: { has: (p) => values.has(p), get: (p) => values.get(p), paths: () => values.keys() },
    scriptAssetRefs: manifest.assetRefs ?? [], // warmed up with every scene (ADR 0080)
    async loadScripts() {
      // Svelte components (ADR 0423) are their `.svelte` files' asset values, which `UIView`s mount; their sources don't ship.
      const components = new Map<string, unknown>();
      for (const script of manifest.scripts) {
        const module: unknown = await import(/* @vite-ignore */ urlOf(script.module));
        if (script.source.endsWith(".svelte")) components.set(script.source, module);
      }
      engine.Assets.setCompiledModules(components);

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
  // ADR 0376 / 0403: a build exported with debugging on (`game.json` `debug`) connects out to the editor or the Studio
  // (`debug.link`, or an address given at launch), listens for tools (`debug.listen`), or both. Launch flags: a desktop
  // build's `--debug-link <address>` and `--debug-code <code>` (its shell sets `__mycoDebugLink` / `__mycoDebugCode`), a
  // web build's `?debug-link=` and `?debug-code=` (the tool's pairing code; plan decision O6, no entry field). Without
  // `debug` nothing is imported, and a release export holds none of the link's files or the pairing overlay. Whether it
  // dials, listens, and as which platform is `buildLaunch`'s decision.
  if (launch.debug) {
    const { debug, override, code, platform } = launch.debug;
    const desktop = platform !== "web";
    // A desktop game can listen: the native WebSocket server stands in for the transport a page lacks.
    // Its network addresses go in the pairing code (a code holds the machine's private IPv4 octets).
    let interfaces: NetworkInterfaceAddress[] = [];
    // The desktop game's listener also hosts the rendezvous on its port (ADR 0403), so pages on its LAN can meet there.
    let listenTransport: string | undefined;
    if (desktop) {
      const native = await import("../engine/debugLink/tauriListener");
      native.registerTauriWebSocketTransport();
      listenTransport = native.TAURI_HOSTING_TRANSPORT;
      if (launch.debug.listen) interfaces = await native.nativeInterfaces();
    }
    const { startDebugLink, startBuildListener } = await import("../engine/debugLink/host");
    if (launch.debug.dial) await startDebugLink(runtime, { debug, override, name: manifest.name, platform, code, interfaces: () => interfaces });
    // A desktop game listens on its native WebSocket; a page can't, so it offers a rendezvous room on its own server
    // (or the hosted rendezvous) and the overlay shows the room code (`host.ts`, `rooms.ts`).
    if (launch.debug.listen) {
      const listener = await startBuildListener(runtime, { debug, name: manifest.name, platform, interfaces: () => interfaces, transport: listenTransport });
      if (listener) (await import("./debugOverlay")).installDebugOverlay(listener);
      // ADR 0403 "Discovery": a native listener reachable from the LAN (port 0 is a page's room, which has no socket)
      // is advertised by mDNS so tools list it; the advert ends when the app does.
      if (listener && desktop && listener.lan && listener.port > 0) {
        const [{ advertiseBuild }, { DEBUG_LINK_PATH }] = await Promise.all([import("../engine/debugLink/tauriDiscovery"), import("../engine/debugLink/config")]);
        void advertiseBuild({ name: manifest.name, platform, port: listener.port, path: DEBUG_LINK_PATH });
      }
    }
  }
  runtime.start();
  (window as { engine?: Engine }).engine = runtime;
  container.querySelector("canvas")?.focus(); // keyboard input without a click first
  // The Export option "audio capture" (ADR 0172): F9 and the three-finger hold record the audio mix. Without it nothing is
  // imported or installed, so the build holds no listener and loads no part of the recorder.
  if (launch.audioCapture) (await import("../plugins/audio/runtime/capture/trigger")).installCaptureTrigger();
  // The Export option "audio takes" (ADR 0348): F10 records a take. Without it nothing is imported or installed.
  if (launch.audioTake) {
    // `audioTakeFrames: false` keeps pictures of the game view out of takes (on by default).
    if (!launch.audioTake.frames) (await import("../plugins/audio/runtime/capture/take")).setTakeFrames(false);
    (await import("../plugins/audio/runtime/capture/trigger")).installTakeTrigger();
  }
}

boot().catch((err: unknown) => {
  console.error("[myco] The game couldn't start:", err);
  const box = document.getElementById("player-message")!;
  box.replaceChildren(Object.assign(document.createElement("div"), { textContent: `The game couldn't start.\n\n${err instanceof Error ? err.message : String(err)}` }));
  box.hidden = false;
});
