// Scene-view previews for the selected navigation component (ADR 0065), edit mode only, drawn from the open scene's
// last bake (so something moved since shows the last bake inside its current box until you rebake):
//
// - NavResolutionVolume (Foxfire's ResolutionVolumeFlightPreview): the baked flight leaves smaller than their
//   volume's base cell (resolution region leaves) whose centres are inside the selected box.
// - NavModifierVolume that applies to the air (ModifierVolumeFlightPreview): the baked flight leaves in its area
//   inside its box, outlined in the area's colour.
// - NavChunk with "Surface bins" on in its inspector (SurfaceBinsPreview): every collected walkable triangle outlined
//   in the colour of the orientation bin it bakes into (the bake's own classification), and at the chunk node each
//   bin's normal and coverage cone, and the floor and ceiling capture cones.
//
// What the preview found ("rebake to see flight cells"…) is in `navPreviewStatus`, which the inspectors show.
import { signal } from "@preact/signals";
import type { World } from "../engine/core/World";
import { addEditorOverlay, removeEditorOverlay } from "../engine/editor";
import { NavChunk, NavModifierVolume, NavResolutionVolume } from "../engine/nav/components";
import { leafSegments, type DebugSegments } from "../engine/nav/debugGeometry";
import { collectNavGeometry } from "../engine/nav/geometry";
import { binColor, bakeVolumeGroups, classifySurfaceBins, debugBakeFlightLeaves, leavesInBox, surfaceBinLayout, type SurfaceBinLayout } from "../engine/nav/plan";
import type { NavigationSettings } from "../engine/nav/settings";
import type { GameObject } from "../engine/scene/GameObject";
import { projectNavigation } from "./navBake";
import { openSceneBakeBytes, openSceneBakeKey } from "./navGizmo";
import { persisted } from "./preferences";
import { currentProject, docVersion, openScene, playState, selectedKeys } from "./state";
import { parseHex, theme } from "./theme";

/** Outlines per preview (Foxfire's MaxCells). */
export const MAX_PREVIEW_CELLS = 5000;
/** Triangle outlines in the surface bins preview. */
export const MAX_BIN_SEGMENTS = 60_000;
/** Lifts the bin outlines off the surfaces, along each face normal. */
const BIN_LIFT = 0.02;

/** The NavChunk inspector's "Surface bins" toggle, remembered per user. */
export const navSurfaceBins = persisted<boolean>("myco.editor.navSurfaceBins", false);

/** What the selected node's preview found: `node` is its selection key. */
export const navPreviewStatus = signal<{ node: string; kind: "resolution" | "modifier" | "bins"; text: string } | null>(null);

const hexOf = (c: string): number => {
  const rgb = parseHex(c) ?? [255, 0, 255];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
};
const rgbaHex = (c: readonly number[]): number => (Math.round((c[0] ?? 1) * 255) << 16) | (Math.round((c[1] ?? 1) * 255) << 8) | Math.round((c[2] ?? 1) * 255);

/** The unit box `[-0.5, 0.5]^3` to world space for a box component on `node` (its world matrix × center / size). */
export function boxToWorldOf(node: GameObject, center: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }): number[] {
  const world = node.world;
  let e = node.entity;
  while (e >= 0 && !world.hasTransform[e]) e = world.parentEntity(e);
  const m = new Array<number>(16).fill(0);
  if (e < 0) m[0] = m[5] = m[10] = m[15] = 1;
  else {
    const all = world.worldMatrix(e);
    for (let i = 0; i < 16; i++) m[i] = all[e * 16 + i];
  }
  const s = [size.x, size.y, size.z], c = [center.x, center.y, center.z];
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 4 + row] = m[col * 4 + row] * s[col];
  for (let row = 0; row < 3; row++) out[12 + row] = m[row] * c[0] + m[4 + row] * c[1] + m[8 + row] * c[2] + m[12 + row];
  out[15] = 1;
  return out;
}

/** Flight leaves in `box` from every flight volume of `bakes`: `area` "" = any area; `refinedOnly` = only resolution region leaves. */
export async function flightLeavesInBox(bakes: readonly Uint8Array[], box: readonly number[], area: string, refinedOnly: boolean, max = MAX_PREVIEW_CELLS): Promise<Float32Array> {
  const parts: number[] = [];
  for (const bytes of bakes) {
    for (const group of await bakeVolumeGroups(bytes)) {
      if (parts.length / 5 >= max) break;
      const inside = leavesInBox(await debugBakeFlightLeaves(bytes, group, area, refinedOnly), box, max - parts.length / 5);
      for (let i = 0; i < inside.length; i++) parts.push(inside[i]);
    }
  }
  return Float32Array.from(parts);
}

/** The walkable triangles (9 floats each) a chunk collects, outlined by bin; with the bin glyph at `origin`. */
export function binSegments(triangles: Float32Array, bins: Int32Array, layout: SurfaceBinLayout, colors: { floor: number; ceiling: number; unwalkable: number; capture: number }, origin: readonly number[], radius: number): DebugSegments[] {
  const byColor = new Map<number, number[]>();
  const add = (color: number, ...p: number[]) => {
    let list = byColor.get(color);
    if (!list) byColor.set(color, (list = []));
    list.push(...p);
  };
  let segments = 0;
  for (let t = 0; t < bins.length && segments + 3 <= MAX_BIN_SEGMENTS; t++) {
    const o = t * 9;
    const ax = triangles[o], ay = triangles[o + 1], az = triangles[o + 2];
    const bx = triangles[o + 3], by = triangles[o + 4], bz = triangles[o + 5];
    const cx = triangles[o + 6], cy = triangles[o + 7], cz = triangles[o + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz);
    if (len <= 1e-12) continue;
    nx = (nx / len) * BIN_LIFT;
    ny = (ny / len) * BIN_LIFT;
    nz = (nz / len) * BIN_LIFT;
    const color = bins[t] < 0 ? colors.unwalkable : binColor(bins[t], layout.ceilingBin, colors.floor, colors.ceiling);
    const A = [ax + nx, ay + ny, az + nz], B = [bx + nx, by + ny, bz + nz], C = [cx + nx, cy + ny, cz + nz];
    add(color, ...A, ...B, ...B, ...C, ...C, ...A);
    segments += 3;
  }
  // The glyph: each bin's normal and coverage cone; the capture cones.
  const [ox, oy, oz] = origin;
  const cone = (color: number, n: readonly number[], deg: number, r: number) => {
    const a = (deg * Math.PI) / 180, cr = r * Math.sin(a), d = r * Math.cos(a);
    // Two axes perpendicular to n.
    const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = n[1] * ref[2] - n[2] * ref[1], uy = n[2] * ref[0] - n[0] * ref[2], uz = n[0] * ref[1] - n[1] * ref[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
    const steps = 32;
    const at = (k: number) => {
      const t = (k / steps) * Math.PI * 2, c = Math.cos(t) * cr, s = Math.sin(t) * cr;
      return [ox + n[0] * d + ux * c + vx * s, oy + n[1] * d + uy * c + vy * s, oz + n[2] * d + uz * c + vz * s];
    };
    for (let k = 0; k < steps; k++) add(color, ...at(k), ...at(k + 1));
  };
  cone(colors.capture, [0, 1, 0], layout.groundCaptureDeg, radius);
  if (layout.ceilingBin >= 0) cone(colors.capture, [0, -1, 0], layout.ceilingCaptureDeg, radius);
  layout.bins.forEach((b, i) => {
    const color = binColor(i, layout.ceilingBin, colors.floor, colors.ceiling);
    const n = b.normal;
    add(color, ox + n[0] * radius, oy + n[1] * radius, oz + n[2] * radius, ox + n[0] * radius * 1.3, oy + n[1] * radius * 1.3, oz + n[2] * radius * 1.3);
    cone(color, n, layout.coverageDeg, radius * 1.002);
  });
  return [...byColor].map(([color, p]) => ({ positions: Float32Array.from(p), color }));
}

/** A chunk's walkable triangles as one flat array (9 floats each). */
export function walkableTriangles(meshes: readonly { positions: Float32Array; indices: Uint32Array; kind?: string }[]): Float32Array {
  let count = 0;
  for (const m of meshes) if ((m.kind ?? "navMesh") === "navMesh") count += Math.floor(m.indices.length / 3);
  const out = new Float32Array(count * 9);
  let o = 0;
  for (const m of meshes) {
    if ((m.kind ?? "navMesh") !== "navMesh") continue;
    for (let i = 0; i + 2 < m.indices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.indices[i + k] * 3;
        out[o++] = m.positions[v];
        out[o++] = m.positions[v + 1];
        out[o++] = m.positions[v + 2];
      }
    }
  }
  return out;
}

/** The selected node, its selection key and the navigation component the preview draws for, if any. */
function selectedTarget(): { key: string; node: GameObject } | null {
  const scene = openScene.peek();
  const keys = selectedKeys.peek();
  if (!scene || keys.length !== 1) return null;
  const node = scene.sync.nodeFor(keys[0].split("/"));
  return node ? { key: keys[0], node } : null;
}

const v3key = (v: { x: number; y: number; z: number }) => `${v.x},${v.y},${v.z}`;

/** The edit-mode preview provider: recomputes (asynchronously) when what it depends on changes. */
export class NavSelectionPreview {
  private memoKey = "";
  private memoNode = "";
  private memo: DebugSegments[] = [];
  private pending = "";

  segments(): DebugSegments[] {
    if (playState.peek() !== "edit") return [];
    const target = selectedTarget();
    if (!target) return [];
    const { key: nodeKey, node } = target;
    const res = node.getComponent(NavResolutionVolume);
    const mod = node.getComponent(NavModifierVolume);
    const chunk = navSurfaceBins.peek() ? node.getComponent(NavChunk) : null;
    if (!res && !(mod && mod.appliesTo !== "ground" && mod.area) && !chunk) return [];
    const settings = projectNavigation(currentProject.peek());
    const t = theme.peek();
    let key = `${nodeKey}|${openSceneBakeKey()}`;
    let run: (() => Promise<{ segments: DebugSegments[]; status: { kind: "resolution" | "modifier" | "bins"; text: string } | null }>) | null = null;
    if (res && res.enabled) {
      const box = boxToWorldOf(node, res.center, res.size);
      key += `|res|${box.map((x) => x.toFixed(4)).join(",")}|${t.accent2}`;
      run = async () => {
        const { bakes } = await openSceneBakeBytes();
        if (!bakes.length) return { segments: [], status: { kind: "resolution", text: "Rebake to see flight cells." } };
        const leaves = await flightLeavesInBox(bakes, box, "", true);
        return {
          segments: leafSegments(leaves, hexOf(t.accent2), MAX_PREVIEW_CELLS),
          status: { kind: "resolution", text: leaves.length ? `${leaves.length / 5} refined flight cells here in the last bake.` : "No refined flight cells here (rebake? Cell Size fine enough?)" },
        };
      };
    } else if (mod && mod.enabled && mod.appliesTo !== "ground" && mod.area) {
      const box = boxToWorldOf(node, mod.center, mod.size);
      const area = settings.areas.find((a) => a.id === mod.area);
      const color = area ? rgbaHex(area.color) : hexOf(t.warning);
      key += `|mod|${mod.area}|${color}|${box.map((x) => x.toFixed(4)).join(",")}`;
      run = async () => {
        const { bakes } = await openSceneBakeBytes();
        if (!bakes.length) return { segments: [], status: { kind: "modifier", text: "Rebake to see flight cells." } };
        const leaves = await flightLeavesInBox(bakes, box, mod.area, false);
        return {
          segments: leafSegments(leaves, color, MAX_PREVIEW_CELLS),
          status: { kind: "modifier", text: leaves.length ? `${leaves.length / 5} baked flight cells in ${area?.name || mod.area} here.` : "No baked flight cells here (rebake?)" },
        };
      };
    } else if (chunk) {
      key += `|bins|${docVersion.peek()}|${JSON.stringify(settings.orientation)}|${JSON.stringify(settings.surfaceRings)}|${t.success}|${t.accent2}`;
      run = () => surfaceBinsPreview(node, settings, t);
    }
    if (!run) return [];
    if (key !== this.memoKey && key !== this.pending) {
      this.pending = key;
      void run()
        .then((r) => {
          if (this.pending !== key) return;
          this.memo = r.segments;
          this.memoKey = key;
          this.memoNode = nodeKey;
          navPreviewStatus.value = r.status ? { node: nodeKey, ...r.status } : null;
        })
        .catch((err: unknown) => {
          if (this.pending !== key) return;
          this.memo = [];
          this.memoKey = key;
          this.memoNode = nodeKey;
          navPreviewStatus.value = { node: nodeKey, kind: res ? "resolution" : mod ? "modifier" : "bins", text: `Preview failed: ${err instanceof Error ? err.message : String(err)}` };
        })
        .finally(() => {
          if (this.pending === key) this.pending = "";
        });
    }
    return this.memoNode === nodeKey ? this.memo : [];
  }
}

async function surfaceBinsPreview(node: GameObject, settings: NavigationSettings, t: ReturnType<typeof theme.peek>) {
  const layout = await surfaceBinLayout(settings);
  if ("error" in layout) return { segments: [], status: { kind: "bins" as const, text: layout.error } };
  const geometry = collectNavGeometry(node.world, node, settings);
  const triangles = walkableTriangles(geometry.meshes);
  const bins = await classifySurfaceBins(settings, triangles);
  const m = node.world.worldMatrix(node.entity);
  const e = node.entity * 16;
  const origin = node.transform ? [m[e + 12], m[e + 13], m[e + 14]] : [0, 0, 0];
  const segments = binSegments(triangles, bins, layout, { floor: hexOf(t.success), ceiling: hexOf(t.accent2), unwalkable: hexOf(t.muted), capture: hexOf(t.text) }, origin, 2);
  const shown = Math.min(bins.length, Math.floor(MAX_BIN_SEGMENTS / 3));
  return { segments, status: { kind: "bins" as const, text: `${bins.length.toLocaleString("en")} walkable-source triangles${shown < bins.length ? ` (${shown.toLocaleString("en")} drawn)` : ""}${geometry.pending.length ? `; ${geometry.pending.length} models still loading` : ""}.` } };
}

const PREVIEW_ID = "navigation-selection";

/** Draw the selection previews in the scene view (edit mode). Returns a function that removes them. */
export function installNavPreviews(world: World): () => void {
  const preview = new NavSelectionPreview();
  addEditorOverlay(world, PREVIEW_ID, () => ({ lines: [], handles: [], segments: preview.segments() }), "navigation");
  return () => removeEditorOverlay(world, PREVIEW_ID);
}
