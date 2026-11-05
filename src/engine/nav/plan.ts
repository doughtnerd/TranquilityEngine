/**
 * Internal (ADR 0065): what a chunk's bake will do, without baking, for the editor's navigation inspectors and
 * scene previews (Foxfire's NavChunkAuthoringEditor, NavAgentAuthoringEditor, NavResolutionVolumeEditor,
 * ResolutionVolumeFlightPreview, ModifierVolumeFlightPreview and SurfaceBinsPreview). The grouping and the bin
 * classification run the bake's own Rust code (`nav-wasm`'s `plan.rs`); the small rules here are ports of the
 * editors' own.
 */
import { loadNavigation } from "./loader";
import type { NavGeometry } from "./geometry";
import type { NavAgentType, NavigationSettings } from "./settings";

/** One agent type in a chunk's bake plan. */
export interface NavPlanAgentType {
  id: string;
  name: string;
  /** Listed in the settings and not skipped by the chunk. */
  baked: boolean;
  /** In the chunk's `skipAgents`. */
  skipped: boolean;
  walks: boolean;
  flies: boolean;
  /** The navmesh (group) it gets, -1 for none. */
  walkGroup: number;
  /** The flight volume (group) it gets, -1 for none. */
  flyGroup: number;
  /** The flight cell it asks for, before rounding to whole voxels. */
  flightBaseCell: number;
}

/** What a chunk bakes for each agent type, and which types share a navmesh or flight volume. */
export interface NavBakePlan {
  agentTypes: NavPlanAgentType[];
  walkGroups: { members: string[]; cellSize: number; cellHeight: number }[];
  flyGroups: { members: string[]; cellSize: number }[];
  warnings: string[];
}

/** A chunk's bake plan from its collected geometry (`collectNavGeometry`), by the bake's own grouping rules. */
export async function navBakePlan(settings: NavigationSettings, geometry: Pick<NavGeometry, "meshes" | "chunk" | "modifierVolumes" | "gates" | "resolutionVolumes">): Promise<NavBakePlan> {
  const mod = await loadNavigation();
  const input = { settings, chunk: geometry.chunk, modifierVolumes: geometry.modifierVolumes, gates: geometry.gates, resolutionVolumes: geometry.resolutionVolumes };
  const walkableFor = geometry.meshes.filter((m) => (m.kind ?? "navMesh") === "navMesh").map((m) => m.walkableFor ?? []);
  return JSON.parse(mod.bakePlan(JSON.stringify(input), JSON.stringify(walkableFor))) as NavBakePlan;
}

/** Lines describing a plan (the NavChunk inspector's summary): per agent type, its navmesh and flight volume. */
export function describeNavBakePlan(plan: NavBakePlan): string[] {
  const nameOf = (id: string) => plan.agentTypes.find((t) => t.id === id)?.name || id;
  const lines: string[] = [];
  for (const t of plan.agentTypes) {
    const name = t.name || t.id;
    if (t.skipped) {
      lines.push(`${name}: skipped here (Skip Agents).`);
      continue;
    }
    if (!t.baked) {
      lines.push(`${name}: not baked.`);
      continue;
    }
    const parts: string[] = [];
    if (t.walkGroup >= 0) {
      const g = plan.walkGroups[t.walkGroup];
      const others = (g?.members ?? []).filter((m) => m !== t.id).map(nameOf);
      parts.push(`navmesh ${t.walkGroup + 1}${g ? ` (${round(g.cellSize)} × ${round(g.cellHeight)} m voxels)` : ""}${others.length ? `, shared with ${others.join(", ")}` : ""}`);
    } else if (t.walks) parts.push("no navmesh (more than 32 walking types?)");
    if (t.flyGroup >= 0) {
      const g = plan.flyGroups[t.flyGroup];
      const others = (g?.members ?? []).filter((m) => m !== t.id).map(nameOf);
      parts.push(`flight volume ${t.flyGroup + 1}${g ? ` (${round(g.cellSize)} m cells)` : ""}${others.length ? `, shared with ${others.join(", ")}` : ""}`);
    }
    lines.push(`${name}: ${parts.length ? parts.join("; ") : "neither walks nor flies: nothing baked"}.`);
  }
  return lines;
}

const round = (v: number) => +v.toFixed(3);

// ------------------------------------------------------------------------------------------- small rules

/** `NavChunkAuthoring.Bakes`: the agent type is in the settings and not in the chunk's `skipAgents`. */
export function chunkBakesAgentType(settings: NavigationSettings, skipAgents: readonly string[], typeId: string): boolean {
  return settings.agentTypes.some((t) => t.id === typeId) && !skipAgents.includes(typeId);
}

/** The agent type a NavAgent's `agentType` field resolves to ("" = the first type). */
export function resolveAgentType(settings: NavigationSettings, idOrName: string): NavAgentType | null {
  if (!idOrName) return settings.agentTypes[0] ?? null;
  return settings.agentTypes.find((t) => t.id === idOrName) ?? settings.agentTypes.find((t) => t.name === idOrName) ?? null;
}

/** `ToBakeFlyer` + `RequestedFlightCellSize`: the flight cell an agent type asks for (before rounding to voxels). */
export function flightBaseCell(settings: NavigationSettings, type: NavAgentType): number {
  const radius = Math.max(type.flight.radius, 0.01);
  const fixed = settings.flightVoxels === "fixed" ? settings.flightCellSize : 0;
  return fixed > 0 ? fixed : radius / Math.max(settings.flightCellsPerRadius, 0.25);
}

/** `NavVolumeParallelBuilder.MaxRegionLevels`. */
export const MAX_REGION_LEVELS = 3;

/** How many halvings a resolution region gives a flight volume whose base cell is `baseCell` (0 = it does nothing). */
export function resolutionRegionLevel(baseCell: number, regionCell: number): number {
  if (!(regionCell > 0) || !(baseCell > 0)) return 0;
  return Math.min(MAX_REGION_LEVELS, Math.max(0, Math.round(Math.log2(baseCell / regionCell))));
}

/** One flying agent type's cells inside a resolution region (NavResolutionVolumeEditor). */
export interface ResolutionRegionEffect {
  id: string;
  name: string;
  baseCell: number;
  /** 0: no effect. */
  level: number;
  /** The cell the region gets (`baseCell` when it does nothing). */
  cell: number;
}

/** Per flying agent type the chunk bakes and the region applies to (`affectedAgents`, empty = all): its region cells. */
export function resolutionRegionEffects(settings: NavigationSettings, skipAgents: readonly string[], regionCell: number, affectedAgents: readonly string[]): ResolutionRegionEffect[] {
  const out: ResolutionRegionEffect[] = [];
  for (const t of settings.agentTypes) {
    if (!t.canFly || !chunkBakesAgentType(settings, skipAgents, t.id)) continue;
    if (affectedAgents.length > 0 && !affectedAgents.includes(t.id)) continue;
    const baseCell = flightBaseCell(settings, t);
    const level = resolutionRegionLevel(baseCell, regionCell);
    out.push({ id: t.id, name: t.name || t.id, baseCell, level, cell: baseCell / (1 << level) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- orientation bins

/** The orientation bins navigation settings make (`plan.rs`'s `surface_bin_layout`). */
export interface SurfaceBinLayout {
  bins: { normal: [number, number, number]; name: string; ring: number; indexInRing: number }[];
  ceilingBin: number;
  sideBinCount: number;
  rings: { tiltDeg: number; count: number; azimuthOffsetDeg: number; skipped: boolean; firstBin: number }[];
  coverageDeg: number;
  groundCaptureDeg: number;
  ceilingCaptureDeg: number;
  maxSurfaceDeg: number;
  /** Share of walkable surface directions outside every bin's coverage. */
  uncoveredShare: number;
  /** Bins no surface direction reaches. */
  unusedBins: number[];
}

/** The settings' bin layout, or `{ error }` when they make none. */
export async function surfaceBinLayout(settings: NavigationSettings): Promise<SurfaceBinLayout | { error: string }> {
  return JSON.parse((await loadNavigation()).surfaceBinLayout(JSON.stringify(settings))) as SurfaceBinLayout | { error: string };
}

/** The bin each triangle (9 floats each, world space) bakes into; -1 where it isn't walkable. */
export async function classifySurfaceBins(settings: NavigationSettings, triangles: Float32Array): Promise<Int32Array> {
  return (await loadNavigation()).classifySurfaceBins(JSON.stringify(settings), triangles);
}

/** Text lines summarising a bin layout (SurfaceBinsPreview's inspector summary) and its warnings. */
export function describeSurfaceBins(layout: SurfaceBinLayout): { summary: string[]; warnings: string[] } {
  const summary = [
    `${layout.bins.length} bins: floor, ${layout.sideBinCount} side, ${layout.ceilingBin >= 0 ? `ceiling (bin ${layout.ceilingBin})` : "no ceiling"}.`,
  ];
  layout.rings.forEach((r, i) => {
    let line = `Ring ${i + 1}: tilt ${round(r.tiltDeg)}° × ${r.count}, azimuth ${round(r.azimuthOffsetDeg)}°`;
    if (r.skipped) line += " — skipped: every surface it would hold is steeper than Max Surface Deg";
    else if (r.count <= 0) line += " — no bins";
    else line += r.count === 1 ? ` → bin ${r.firstBin}` : ` → bins ${r.firstBin}–${r.firstBin + r.count - 1}`;
    summary.push(line);
  });
  const warnings: string[] = [];
  if (layout.uncoveredShare > 0.005)
    warnings.push(`${Math.round(layout.uncoveredShare * 100)}% of walkable surface directions are outside every bin's coverage cone and get no navmesh. Add bins, raise Coverage Deg, or move the ring tilts.`);
  if (layout.unusedBins.length > 0)
    warnings.push(`Never used: ${layout.unusedBins.map((b) => layout.bins[b]?.name ?? `bin ${b}`).join(", ")}. Every direction near them goes to the floor or ceiling capture or a closer bin, so they cost bake time for nothing.`);
  return { summary, warnings };
}

/** A bin's colour (0xRRGGBB): `floor` and `ceiling` as given, side bins spread over the hues between (golden-ratio steps). */
export function binColor(bin: number, ceilingBin: number, floor: number, ceiling: number): number {
  if (bin === 0) return floor;
  if (bin === ceilingBin) return ceiling;
  const t = (((bin - 1) * 0.618034) % 1) * 0.56;
  const hue = t < 0.2 ? t : t < 0.43 ? t + 0.27 : t + 0.44;
  return hsvToHex(hue, 0.75, 0.95);
}

function hsvToHex(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

// ------------------------------------------------------------------------------------------- baked flight leaves

/** The flight volume sections (groups) a bake holds. */
export async function bakeVolumeGroups(bytes: Uint8Array): Promise<number[]> {
  const info = JSON.parse((await loadNavigation()).bakeInfo(bytes, false)) as { sections?: { kind: string; group: number }[] };
  return [...new Set((info.sections ?? []).filter((s) => s.kind === "volume").map((s) => s.group))];
}

/** A bake's flight leaves (stride 5: min xyz, edge, area), only those in `area` (an area id; "" = any), and with `refinedOnly` only those in resolution regions. */
export async function debugBakeFlightLeaves(bytes: Uint8Array, group: number, area: string, refinedOnly: boolean): Promise<Float32Array> {
  return (await loadNavigation()).debugBakeFlightLeaves(bytes, group, area, refinedOnly);
}

/** The inverse of an affine column-major 4×4 matrix (null if singular). */
export function invertAffine(m: ArrayLike<number>): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
  // inv is row-major 3×3: inv[r * 3 + c].
  const t = [m[12], m[13], m[14]];
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 4 + row] = inv[row * 3 + col];
  for (let row = 0; row < 3; row++) out[12 + row] = -(inv[row * 3] * t[0] + inv[row * 3 + 1] * t[1] + inv[row * 3 + 2] * t[2]);
  out[15] = 1;
  return out;
}

/** Leaves (stride 5) whose centres are inside the oriented box `boxToWorld` (the unit box `[-0.5, 0.5]^3` to world). */
export function leavesInBox(leaves: Float32Array, boxToWorld: ArrayLike<number>, max = Infinity): Float32Array {
  const inv = invertAffine(boxToWorld);
  if (!inv) return new Float32Array(0);
  const out: number[] = [];
  for (let o = 0; o + 5 <= leaves.length && out.length / 5 < max; o += 5) {
    const h = leaves[o + 3] / 2, x = leaves[o] + h, y = leaves[o + 1] + h, z = leaves[o + 2] + h;
    const lx = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
    const ly = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
    const lz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
    if (Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5 && Math.abs(lz) <= 0.5) out.push(leaves[o], leaves[o + 1], leaves[o + 2], leaves[o + 3], leaves[o + 4]);
  }
  return Float32Array.from(out);
}
