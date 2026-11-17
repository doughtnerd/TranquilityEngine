// The scene view's drawing of baked navigation (ADR 0065 "Debug drawing"), apart from where it comes
// from: which bakes a scene names, the debug colours from the theme's tokens, and the cache that
// reads each bake once and turns it into segments by toggle and agent group. navGizmo.ts gives it
// the open scene's bakes, the bake reader and the editor's settings.
import { leafSegments, navmeshLineSegments, type DebugSegments, type NavDebugColors } from "../../../engine/nav/debugGeometry";
import { NAV_CHUNK } from "../../../engine/nav/geometry";
import { mix, parseHex, type ThemeTokens } from "../../../editor/sdk";
import type { NavOverlaySettings } from "./navGizmo";

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
    costly: hexOf(t.warning),
    cheap: hexOf(t.success),
    excluded: hexOf(t.danger),
  };
}

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

/** The baked chunks of the open scene: their asset paths, each one's URL, and what changes when they might have. */
export interface SceneBakes {
  paths: string[];
  urlOf: (path: string) => string | null;
  token: unknown;
  version: number;
}

/**
 * The editor-side cache and provider for the edit-mode drawing, over the sources it's given: the
 * settings and colours, a clock, how a bake's bytes are read and turned into lines and leaves, the
 * open scene's bakes, and which bake sections an agent type uses.
 */
export class NavBakeOverlay {
  private readonly entries = new Map<string, BakeEntry>();
  private paths: string[] = [];
  private scannedAt = -Infinity;
  private scannedVersion = -1;
  private scannedScene: unknown = null;
  private memoKey = "";
  private memo: DebugSegments[] = [];

  constructor(
    private readonly settings: () => NavOverlaySettings,
    private readonly colors: () => NavDebugColors,
    private readonly clock: () => number,
    private readonly readBytes: (url: string) => Promise<Uint8Array>,
    private readonly lines: (bytes: Uint8Array, group: number) => Promise<Float32Array>,
    private readonly leaves: (bytes: Uint8Array, group: number) => Promise<Float32Array>,
    private readonly sceneBakes: () => SceneBakes | null,
    private readonly groupsOf: (bytes: Uint8Array, typeIndex: number) => Promise<{ walk: number; fly: number }>,
  ) {}

  /** The segments to draw this frame (empty unless a toggle is on). */
  segments(): DebugSegments[] {
    const s = this.settings();
    if (!s.navmesh && !s.links && !s.volume) return [];
    const scene = this.sceneBakes();
    if (!scene) return [];
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
    return this.memo;
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
