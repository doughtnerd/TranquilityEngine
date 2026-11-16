// Navigation debug drawing in the scene view and while playing (ADR 0065 "Debug drawing").
//
// Edit mode: for the open scene's NavChunk nodes with a baked asset, the baked navmesh is drawn
// from the bake's bytes (no runtime): polygon outlines, shared edges and chunk-face edges under
// "Navmesh", fold links and jump links (as arcs) under "Links", flight leaves under "Flight volume"
// (capped), for one agent group (a section of the bake). The asset is read again when its URL
// changes or the scene's document does. Landing links, seams and paths exist only at runtime.
//
// Play mode: every World of the play session gets a provider that draws its live navigation
// runtime (the navmesh with overlays, links, landing links, seams, agents' paths, NavCostVolume costs), switched by the
// same toggles and by `Navigation.debug` flags on the facade. The game view's render backend draws
// overlays too (RenderBackend.syncOverlay), so a game can draw them without the editor by adding
// `RuntimeNavOverlay` through `addEditorOverlay`.
//
// The Navigation plugin's always-on viewport tool `myco.navigation.overlay` (ADR 0138, 0142); the toggles are the
// Scene toolbar's Nav popover (`NavOverlayForm.tsx`, a registered toolbar item).
import { effect, type ReadonlySignal } from "@preact/signals";
import type { World } from "../../../engine/core/World";
import { addEditorOverlay, removeEditorOverlay, type EditorOverlay } from "../../../engine/editor";
import { navigationOf } from "../runtime/navigationSystems";
import { NO_NAV_DEBUG, RuntimeNavOverlay, chunkIdsOf, debugBakeLeaves, readNavDebugFlags, type NavDebugFlags, type NavDebugSource } from "../../../engine/nav/debugGeometry";
import { bakeAgentGroups, debugBakeLines } from "../runtime/runtime";
import { projectNavigation } from "./navBake";
import type { PlaySession } from "../../../editor/playMode";
import { playing as playSession } from "../../../editor/state";
import { type ViewportToolContext, type ViewportToolContribution, editor, persisted, theme } from "../../../editor/sdk";
import { NavBakeOverlay, bakePathsOf, navDebugColors, type SceneBakes } from "./navBakeOverlay";

/** The scene view's navigation toggles (and the group whose bake is drawn), remembered per user. */
export interface NavOverlaySettings extends NavDebugFlags {
  /** Which agent group of the bake to draw: its section index (the agent type's position in the project's navigation settings). */
  group: number;
}

const DEFAULT_NAV_OVERLAY: NavOverlaySettings = { ...NO_NAV_DEBUG, seams: true, paths: true, group: 0 };

export const navOverlaySettings = persisted<NavOverlaySettings>("myco.editor.navOverlay", DEFAULT_NAV_OVERLAY);

export function updateNavOverlay(patch: Partial<NavOverlaySettings>): void {
  navOverlaySettings.value = { ...cleanNavOverlay(navOverlaySettings.peek()), ...patch };
}

/** The settings with anything unusable (older or hand-edited storage) replaced by its default. */
export function cleanNavOverlay(s: Partial<NavOverlaySettings> | null | undefined): NavOverlaySettings {
  const flags = readNavDebugFlags(s, DEFAULT_NAV_OVERLAY);
  const group = typeof s?.group === "number" && Number.isInteger(s.group) && s.group >= 0 ? s.group : 0;
  return { ...flags, group };
}

// ------------------------------------------------------------------------------------------- the open scene's bakes

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function openSceneBakes(): SceneBakes | null {
  const scene = editor.scene.peekOpen(), project = editor.project.peek();
  if (!scene || !project) return null;
  return {
    paths: bakePathsOf(scene.doc),
    token: scene,
    version: editor.project.peekVersion(),
    urlOf: (path) => {
      if (!project.assets.has(path)) return null;
      const v = project.assets.get(path);
      return typeof v === "string" ? v : null;
    },
  };
}

/** Bake bytes by URL (a rebake writes a new URL), for the selection previews (navPreviews.ts). */
const sceneBakeBytes = new Map<string, Promise<Uint8Array | null>>();

/**
 * The open scene's baked chunks' bytes (each once per URL; unreadable ones left out) with a key that changes when
 * any is rebaked: what the edit-mode previews of the selected volume read (Foxfire's BakedFlightBlobs).
 */
export async function openSceneBakeBytes(): Promise<{ key: string; bakes: Uint8Array[] }> {
  const scene = openSceneBakes();
  if (!scene) return { key: "", bakes: [] };
  const urls = scene.paths.map((p) => scene.urlOf(p)).filter((u): u is string => u !== null);
  const bakes: Uint8Array[] = [];
  for (const url of urls) {
    let loading = sceneBakeBytes.get(url);
    if (!loading) {
      loading = fetchBytes(url).catch(() => null);
      sceneBakeBytes.set(url, loading);
      if (sceneBakeBytes.size > 16) sceneBakeBytes.delete(sceneBakeBytes.keys().next().value!);
    }
    const bytes = await loading;
    if (bytes) bakes.push(bytes);
  }
  return { key: urls.join("\n"), bakes };
}

/** The open scene's bake URLs, joined: changes when a chunk is rebaked (cheap; no reads). */
export function openSceneBakeKey(): string {
  const scene = openSceneBakes();
  return scene ? scene.paths.map((p) => scene.urlOf(p) ?? "").join("\n") : "";
}

// ------------------------------------------------------------------------------------------- play mode

/** The navigation settings the project declares (the defaults without any). */
/**
 * The bake sections of the agent type at `typeIndex` in the project's settings (the overlay's "Agent group"). A bake
 * numbers its sections by shared voxel settings, not by type, so the index is resolved through the bake's agent table;
 * without a project (or with an unreadable table) the index itself is used.
 */
async function agentGroupsOf(bytes: Uint8Array, typeIndex: number): Promise<{ walk: number; fly: number }> {
  const project = editor.project.peek();
  const id = project ? projectNavigation(project).agentTypes[typeIndex]?.id : undefined;
  if (id) {
    try {
      return await bakeAgentGroups(bytes, id);
    } catch {
      // fall through
    }
  }
  return { walk: typeIndex, fly: typeIndex };
}

const orFlags = (a: NavDebugFlags, b: NavDebugFlags): NavDebugFlags => ({
  navmesh: a.navmesh || b.navmesh,
  links: a.links || b.links,
  volume: a.volume || b.volume,
  landing: a.landing || b.landing,
  seams: a.seams || b.seams,
  paths: a.paths || b.paths,
  costs: a.costs || b.costs,
});

/** A provider drawing `world`'s live navigation runtime; empty while the World has none. */
function runtimeNavProvider(world: World, settings: () => NavDebugFlags = () => cleanNavOverlay(navOverlaySettings.peek())): () => EditorOverlay {
  let overlay: RuntimeNavOverlay | null = null;
  let forRuntime: unknown = null;
  return () => {
    const nav = navigationOf(world);
    if (!nav) return { lines: [], handles: [] };
    if (!overlay || forRuntime !== nav.runtime) {
      forRuntime = nav.runtime;
      overlay = new RuntimeNavOverlay(
        nav.runtime as unknown as NavDebugSource,
        () => chunkIdsOf(nav.loadedChunks?.()),
        () => projectNavigation(editor.project.peek()).agentTypes.map((t) => t.id),
        () => orFlags(settings(), readNavDebugFlags(nav.debug)),
        () => navDebugColors(theme.peek()),
      );
    }
    return { lines: [], handles: [], segments: overlay.segments() };
  };
}

/** The overlay's id on the play Worlds (the scene view's is the tool's own). */
const PLAY_ID = "navigation";

/** Draw navigation in the scene view (edit mode) and in every World of a play session. Returns a function that removes the play Worlds' drawing. */
function installNavGizmo(view: Pick<ViewportToolContext, "overlay">, playing: ReadonlySignal<PlaySession | null>): () => void {
  const bake = new NavBakeOverlay(
    () => cleanNavOverlay(navOverlaySettings.peek()),
    () => navDebugColors(theme.peek()),
    () => Date.now(),
    fetchBytes,
    debugBakeLines,
    debugBakeLeaves,
    openSceneBakes,
    agentGroupsOf,
  );
  view.overlay(() => (editor.scene.peekPlayState() === "edit" ? { lines: [], handles: [], segments: bake.segments() } : { lines: [], handles: [] }), { kind: "navigation" });

  let playWorlds: World[] = [];
  const stopPlay = effect(() => {
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    const session = playing.value;
    playWorlds = session ? session.engine.worlds().flatMap((h) => session.engine._world(h.name) ?? []) : [];
    for (const w of playWorlds) addEditorOverlay(w, PLAY_ID, runtimeNavProvider(w), "navigation");
  });

  // End-to-end test hook: what the scene view and the play Worlds draw.
  if (typeof window !== "undefined") {
    Object.assign(window, {
      navOverlay: () => ({
        ...bake.stats,
        play: playWorlds.map((w) => {
          const o = runtimeNavProvider(w, () => cleanNavOverlay(navOverlaySettings.peek()))();
          return (o.segments ?? []).reduce((n, s) => n + s.positions.length / 6, 0);
        }),
      }),
    });
  }
  return () => {
    stopPlay();
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    playWorlds = [];
  };
}

/** The scene view's navigation drawing: the open scene's bakes while editing, the live runtime of every play World. */
export const navOverlayTool: ViewportToolContribution = {
  id: "myco.navigation.overlay",
  install: (view) => installNavGizmo(view, playSession),
};
