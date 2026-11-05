// The files a navigation bake writes (ADR 0065), shared by the editor (navBake.ts) and `npm run nav:bake`
// (src/nav-cli): which bake file a chunk writes, the record of what it baked from (`.myco/nav/<asset>.json`,
// for the stale notice), and pointing a scene file's NavChunk at its bake. No editor state: Node runs it too.
import type { NavBakeReport } from "../engine/nav/bake";
import { findNavChunks, NAV_CHUNK, navBakePath, navChunkOf } from "../engine/nav/geometry";
import type { GameObject } from "../engine/scene/GameObject";
import type { SceneFile } from "../engine/scene/SceneLoader";

/** What a bake did, kept in `.myco/nav/<asset>.json`. */
export interface NavBakeRecord {
  format: "myco.navbake@1";
  scenePath: string;
  chunkNodeId: string;
  /** The project path of the bake file. */
  asset: string;
  /** {@link navInputSignature} of the inputs it was baked from. */
  inputSignature: string;
  /** Wall-clock milliseconds. */
  ms: number;
  bakedAt: string;
  report: NavBakeReport;
}

/** Where a bake file's record lives, project-relative: `.myco/nav/<asset>.json`. */
export const navRecordPath = (asset: string) => `.myco/nav/${asset}.json`;

/** `asset:scenes/main.nav.bin` → `scenes/main.nav.bin`; "" for an unset reference. */
export const assetPathOf = (ref: unknown) => (typeof ref === "string" ? ref.replace(/^asset:/, "").replace(/^\.?\//, "") : "");

/**
 * The bake file for a chunk: the one its `bake` field names, else `<scene>.nav.bin` for a scene's first
 * chunk, else `<scene>.<chunk id>.nav.bin`.
 */
export function navAssetFor(scenePath: string, chunkNode: GameObject, chunksInScene: readonly GameObject[]): string {
  const comp = navChunkOf(chunkNode);
  const current = comp ? assetPathOf((comp as unknown as { bake?: unknown }).bake) : "";
  if (current) return current;
  const first = chunksInScene.length === 0 || chunksInScene[0] === chunkNode;
  return first ? navBakePath(scenePath) : navBakePath(scenePath).replace(/\.nav\.bin$/, `.${chunkNode.id || chunkNode.name}.nav.bin`);
}

/** The id a chunk bakes under: its node's id (its name for nodes made at runtime). */
export const chunkIdOf = (node: GameObject) => node.id || node.name;

/** The bake file a chunk writes, looking its scene's other chunks up. */
export const navAssetOf = (scenePath: string, chunkNode: GameObject): string => {
  const scene = chunkNode.scene;
  return navAssetFor(scenePath, chunkNode, scene ? findNavChunks(scene) : []);
};

/** A new record of a bake. */
export function navBakeRecord(scenePath: string, chunkNodeId: string, asset: string, inputSignature: string, ms: number, report: NavBakeReport): NavBakeRecord {
  return { format: "myco.navbake@1", scenePath, chunkNodeId, asset, inputSignature, ms: Math.round(ms), bakedAt: new Date().toISOString(), report };
}

/** The total polygons of a bake (every agent group's navmesh). */
export const navPolyCount = (r: NavBakeReport) => r.navmeshes.reduce((n, m) => n + m.polys, 0);

/** One line about a bake: "1,234 polys, 2 agent groups, 3 warnings, 120 ms". */
export function navBakeSummary(record: NavBakeRecord): string {
  const r = record.report;
  const parts = [`${navPolyCount(r).toLocaleString("en")} polys`];
  if (r.navmeshes.length !== 1) parts.push(`${r.navmeshes.length} agent groups`);
  const leaves = r.volumes.reduce((n, v) => n + v.leaves, 0);
  if (leaves > 0) parts.push(`${leaves.toLocaleString("en")} flight leaves`);
  if (r.warnings.length) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`);
  parts.push(`${record.ms} ms`);
  return parts.join(", ");
}

/** Point a NavChunk in a scene file at its bake file (for scenes that aren't open). Returns the new JSON, or null if the node wasn't found. */
export function withBakeReference(file: SceneFile, nodeId: string, asset: string): SceneFile | null {
  const copy = structuredClone(file) as { nodes?: unknown[] };
  let found = false;
  const visit = (nodes: unknown[] | undefined) => {
    for (const n of nodes ?? []) {
      const node = n as { id?: string; components?: { type: string; data?: Record<string, unknown> }[]; children?: unknown[] };
      if (node.id === nodeId) {
        const c = node.components?.find((o) => o.type === NAV_CHUNK);
        if (c) {
          c.data = { ...(c.data ?? {}), bake: `asset:${asset}` };
          found = true;
        }
      }
      visit(node.children);
    }
  };
  visit(copy.nodes);
  return found ? (copy as SceneFile) : null;
}
