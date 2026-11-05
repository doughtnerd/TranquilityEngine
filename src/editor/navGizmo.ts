// Navigation debug drawing in the scene view and while playing (ADR 0065 "Debug drawing").
//
// Edit mode: for the open scene's NavChunk nodes with a baked asset, the baked navmesh is drawn
// from the bake's bytes (no runtime): polygon outlines, shared edges and chunk-face edges under
// "Navmesh", fold links and jump links (as arcs) under "Links", flight leaves under "Flight volume"
// (capped), for one agent group (a section of the bake). The asset is read again when its URL
// changes or the scene's document does. Landing links, seams and paths exist only at runtime.
//
// Play mode: every World of the play session gets a provider that draws its live navigation
// runtime (the navmesh with overlays, links, landing links, seams, agents' paths), switched by the
// same toggles and by `Navigation.debug` flags on the facade. The game view's render backend draws
// overlays too (RenderBackend.syncOverlay), so a game can draw them without the editor by adding
// `RuntimeNavOverlay` through `addEditorOverlay`.
import { effect, type ReadonlySignal } from "@preact/signals";
import type { Engine } from "../engine";
import type { World } from "../engine/core/World";
import { addEditorOverlay, navigationOf, removeEditorOverlay, type EditorOverlay } from "../engine/editor";
import {
  NO_NAV_DEBUG,
  RuntimeNavOverlay,
  chunkIdsOf,
  debugBakeLeaves,
  leafSegments,
  navmeshLineSegments,
  readNavDebugFlags,
  type DebugSegments,
  type NavDebugColors,
  type NavDebugFlags,
  type NavDebugSource,
} from "../engine/nav/debugGeometry";
import { bakeAgentGroups, debugBakeLines } from "../engine/nav/runtime";
import { projectNavigation } from "./navBake";
import { persisted } from "./preferences";
import type { PlaySession } from "./playMode";
import { currentProject, docVersion, openScene, playState } from "./state";
import { mix, parseHex, theme, type ThemeTokens } from "./theme";

/** The scene view's navigation toggles (and the group whose bake is drawn), remembered per user. */
export interface NavOverlaySettings extends NavDebugFlags {
  /** Which agent group of the bake to draw: its section index (the agent type's position in the project's navigation settings). */
  group: number;
}

export const DEFAULT_NAV_OVERLAY: NavOverlaySettings = { ...NO_NAV_DEBUG, seams: true, paths: true, group: 0 };

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

/** The component the overlay looks for in the open scene. */
export const NAV_CHUNK = "engine.NavChunk";

// ------------------------------------------------------------------------------------------- colours

const hexOf = (c: string): number => {
  const rgb = parseHex(c) ?? [255, 0, 255];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
};

/** Debug colours from the theme's tokens (so they follow Settings > Appearance). */
export function navDebugColors(t: ThemeTokens): NavDebugColors {
  return {
    outline: hexOf(t.success),
    shared: hexOf(mix(t.success, t.bg, 0.6)),
    fold: hexOf(t.accent2),
    jump: hexOf(t.warning),
    chunkFace: hexOf(t.accent),
    volume: hexOf(t.muted),
    landing: hexOf(t.danger),
    seam: hexOf(t.accentHover),
    path: hexOf(t.link),
  };
}

// ------------------------------------------------------------------------------------------- the open scene's bakes

/** The baked asset paths (project-relative) of the NavChunk nodes in a scene document. */
export function bakePathsOf(doc: { nodes: readonly { components?: { type: string; data?: Record<string, unknown> }[] }[] }): string[] {
  const out: string[] = [];
  for (const node of doc.nodes) {
    for (const c of node.components ?? []) {
      if (c.type !== NAV_CHUNK) continue;
      const raw = c.data?.bake;
      const ref = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { path?: unknown }).path === "string" ? (raw as { path: string }).path : "";
      const path = ref.replace(/^asset:/, "").replace(/^\.?\//, "");
      if (path && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

interface BakeEntry {
  url: string;
  /** Bumped when the raw buffers arrive or change. */
  version: number;
  loading: boolean;
  lines: Map<number, Float32Array>;
  leaves: Map<number, Float32Array>;
  failed: string | null;
}

/** What the scene view drew last (the test hook `navOverlay()` and the status). */
export interface NavOverlayStats {
  bakes: number;
  loaded: number;
  segments: number;
  /** Segment count by colour (0xRRGGBB). */
  byColor: Record<number, number>;
  failed: string[];
}

/** The editor-side cache and provider for the edit-mode drawing. */
export class NavBakeOverlay {
  private readonly entries = new Map<string, BakeEntry>();
  private paths: string[] = [];
  private scannedAt = -Infinity;
  private scannedVersion = -1;
  private scannedScene: unknown = null;
  private memoKey = "";
  private memo: DebugSegments[] = [];
  stats: NavOverlayStats = { bakes: 0, loaded: 0, segments: 0, byColor: {}, failed: [] };

  constructor(
    private readonly settings: () => NavOverlaySettings,
    private readonly colors: () => NavDebugColors,
    private readonly clock: () => number = () => Date.now(),
    private readonly readBytes: (url: string) => Promise<Uint8Array> = fetchBytes,
    private readonly lines: (bytes: Uint8Array, group: number) => Promise<Float32Array> = debugBakeLines,
    private readonly leaves: (bytes: Uint8Array, group: number) => Promise<Float32Array> = debugBakeLeaves,
    private readonly sceneBakes: () => { paths: string[]; urlOf: (path: string) => string | null; token: unknown; version: number } | null = openSceneBakes,
    private readonly groupsOf: (bytes: Uint8Array, typeIndex: number) => Promise<{ walk: number; fly: number }> = agentGroupsOf,
  ) {}

  /** The segments to draw this frame (empty unless a toggle is on). */
  segments(): DebugSegments[] {
    const s = this.settings();
    if (!s.navmesh && !s.links && !s.volume) return this.finish([], 0);
    const scene = this.sceneBakes();
    if (!scene) return this.finish([], 0);
    const now = this.clock();
    // Rescan the scene's chunks when its document changes, and now and then for rewritten assets.
    if (scene.token !== this.scannedScene || scene.version !== this.scannedVersion || now - this.scannedAt > 1000) {
      this.scannedScene = scene.token;
      this.scannedVersion = scene.version;
      this.scannedAt = now;
      this.paths = scene.paths;
      for (const path of this.paths) {
        const url = scene.urlOf(path);
        const e = this.entries.get(path);
        if (url && (!e || e.url !== url)) this.entries.set(path, { url, version: (e?.version ?? 0) + 1, loading: false, lines: new Map(), leaves: new Map(), failed: null });
      }
    }
    const colors = this.colors();
    let versionKey = "";
    for (const path of this.paths) {
      const e = this.entries.get(path);
      if (!e) continue;
      this.load(e, s.group, s.volume);
      versionKey += `${path}:${e.version}:${e.lines.size}:${e.leaves.size};`;
    }
    const key = `${versionKey}|${s.navmesh}|${s.links}|${s.volume}|${s.group}|${Object.values(colors).join(",")}`;
    if (key !== this.memoKey) {
      this.memoKey = key;
      const out: DebugSegments[] = [];
      for (const path of this.paths) {
        const e = this.entries.get(path);
        if (!e) continue;
        const lines = e.lines.get(s.group);
        if (lines && (s.navmesh || s.links)) out.push(...navmeshLineSegments(lines, s, colors));
        const leaves = e.leaves.get(s.group);
        if (leaves && s.volume) out.push(...leafSegments(leaves, colors.volume));
      }
      this.memo = out;
    }
    return this.finish(this.memo, this.paths.length);
  }

  private finish(segments: DebugSegments[], bakes: number): DebugSegments[] {
    const byColor: Record<number, number> = {};
    let total = 0;
    for (const g of segments) {
      const n = g.positions.length / 6;
      byColor[g.color] = (byColor[g.color] ?? 0) + n;
      total += n;
    }
    const failed = [...this.entries.values()].flatMap((e) => (e.failed ? [e.failed] : []));
    this.stats = { bakes, loaded: [...this.entries.values()].filter((e) => e.lines.size > 0).length, segments: total, byColor, failed };
    return segments;
  }

  private load(e: BakeEntry, group: number, volume: boolean): void {
    if (e.loading || e.failed) return;
    const needLines = !e.lines.has(group), needLeaves = volume && !e.leaves.has(group);
    if (!needLines && !needLeaves) return;
    e.loading = true;
    const version = e.version;
    void (async () => {
      try {
        const bytes = await this.readBytes(e.url);
        const g = await this.groupsOf(bytes, group);
        if (needLines) e.lines.set(group, g.walk >= 0 ? await this.lines(bytes, g.walk) : new Float32Array(0));
        if (needLeaves) e.leaves.set(group, g.fly >= 0 ? await this.leaves(bytes, g.fly) : new Float32Array(0));
      } catch (err) {
        // A bake that doesn't read (stale format, no such group) is shown once, not retried every frame.
        e.failed = `${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (e.version === version) e.loading = false;
      }
    })();
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function openSceneBakes(): { paths: string[]; urlOf: (path: string) => string | null; token: unknown; version: number } | null {
  const scene = openScene.peek(), project = currentProject.peek();
  if (!scene || !project) return null;
  return {
    paths: bakePathsOf(scene.doc),
    token: scene,
    version: docVersion.peek(),
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
  const project = currentProject.peek();
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
});

/** A provider drawing `world`'s live navigation runtime; empty while the World has none. */
export function runtimeNavProvider(world: World, settings: () => NavDebugFlags = () => cleanNavOverlay(navOverlaySettings.peek())): () => EditorOverlay {
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
        () => projectNavigation(currentProject.peek()).agentTypes.map((t) => t.id),
        () => orFlags(settings(), readNavDebugFlags(nav.debug)),
        () => navDebugColors(theme.peek()),
      );
    }
    return { lines: [], handles: [], segments: overlay.segments() };
  };
}

const PLAY_ID = "navigation";

/** Draw navigation in the scene view (edit mode) and in every World of a play session. Returns a function that removes it. */
export function installNavGizmo(engine: Engine, playing: ReadonlySignal<PlaySession | null>): () => void {
  const world = engine.world;
  const bake = new NavBakeOverlay(
    () => cleanNavOverlay(navOverlaySettings.peek()),
    () => navDebugColors(theme.peek()),
  );
  addEditorOverlay(world, PLAY_ID, () => (playState.peek() === "edit" ? { lines: [], handles: [], segments: bake.segments() } : { lines: [], handles: [] }), "navigation");

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
    removeEditorOverlay(world, PLAY_ID);
    for (const w of playWorlds) removeEditorOverlay(w, PLAY_ID);
    playWorlds = [];
  };
}
