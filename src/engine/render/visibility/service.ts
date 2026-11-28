/**
 * The visibility stage's World service (ADR 0446 §3, 0135): once per frame, after transform propagation, it finds each
 * `LODGroup`'s members, brings bounds up to date and runs selection for the main camera (the enabled `Camera` with the
 * lowest depth, as `Camera.main` and the animation core's views). That result feeds `LODGroup.currentLevel` and
 * `visibility` with no renderer, so a headless or server World behaves the same. The renderer reads it for its main
 * view and asks `select(view)` for its other views. Not public API.
 *
 * **Slots.** Every enabled member (a `MeshRenderer`, or a plugin's registered member type) has a renderer slot, stable
 * while it stays enabled; `slotOf` gives it, and each `VisibilityResult`'s arrays are indexed by it. A member outside
 * any group draws LOD0 and is hidden only when off-screen. A member's level byte is its group's level: each of its
 * meshes draws min(level, its last level) (ADR 0446 §2).
 *
 * **Crossfades (ADR 0446 §4).** Persistent views fade a group with `fade: "crossfade"` between levels over its
 * `fadeDuration`, on the World's real time (a 60th of a second per gather where it stands still, as in an edit-mode
 * World). During a fade a result's `levels` holds the incoming level and `fade` its value (`fadeIn`), and `fadeLevels`
 * gives the outgoing one, which draws with `outgoingOf(fade)`.
 *
 * Groups: a member belongs to the nearest `LODGroup` on its node or an ancestor (one on a component node counts for the
 * node it acts for); a disabled group stops the search, so its members draw as if ungrouped.
 */
import type { Component } from "../../core/Component";
import type { QualityTier } from "../../core/graphics";
import type { World } from "../../core/World";
import { _registerWorldService, _worldServiceOf } from "../../core/worldServices";
import type { ModelMesh } from "../../scene/models";
import { Graphics } from "../Graphics";
import { Camera, LODGroup } from "../components";
import { RendererBounds, computeGroupBounds, newGroupBounds, type GroupBounds } from "./bounds";
import { lodMemberTypes } from "./lodMember";
import { SelectionState, automaticHeights, selectLevels, type MeshLevelErrors, type SelectionGroups, type SelectionOut } from "./select";
import { LOD_CULLED, type LodMember, type LodVisibility, type ViewKey, type VisibilityResult, type VisibilityStats, type VisibilityView } from "./types";
import { cameraView } from "./views";

/** The service's id (ADR 0135). */
export const VISIBILITY_SERVICE_ID = "myco.visibility";
/** The most levels a group has: heights past this are ignored. */
export const MAX_LOD_LEVELS = 8;

type Member = Component & LodMember;

interface MemberEntry {
  readonly member: Member;
  readonly slot: number;
  readonly bounds: RendererBounds;
  group: GroupEntry | null;
  seen: number;
}

interface GroupEntry {
  /** Null for a member outside any group, drawn as a group of one. */
  readonly owner: LODGroup | null;
  readonly index: number;
  members: MemberEntry[];
  previous: MemberEntry[];
  readonly bounds: GroupBounds;
  /** The group node's world matrix the bounds were computed for. */
  matrix: Float32Array | null;
  /** Whether its heights were last derived automatically (they are again when its members' meshes change). */
  automatic: boolean;
  seen: number;
}

/** One view's buffers. */
interface ViewEntry {
  result: VisibilityResult;
  /** Per slot during a fade: the outgoing level (`LOD_CULLED` when fading in from culled, or steady). */
  fadeLevels: Uint8Array;
  groupOut: SelectionOut;
  stats: VisibilityStats;
  /** The gather generation it was last selected with. */
  generation: number;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Whether a member casts shadows (members without the field do). */
const castsShadows = (m: Member) => m.castShadows;

/** @internal One World's visibility stage. */
export class VisibilityService {
  private readonly members = new Map<Member, MemberEntry>();
  private readonly freeSlots: number[] = [];
  private slotCount = 0;
  private readonly groups = new Map<object, GroupEntry>();
  private readonly freeGroups: number[] = [];
  private groupCount = 0;
  private readonly entries: (GroupEntry | null)[] = [];
  private readonly state = new SelectionState();
  private input: { count: number; sphere: Float32Array; size: Float32Array; heights: Float32Array; heightStart: Uint32Array; heightCount: Uint8Array; forceLevel: Int16Array; fadeDuration: Float32Array } = {
    count: 0,
    sphere: new Float32Array(0),
    size: new Float32Array(0),
    heights: new Float32Array(0),
    heightStart: new Uint32Array(0),
    heightCount: new Uint8Array(0),
    forceLevel: new Int16Array(0),
    fadeDuration: new Float32Array(0),
  };
  /** The fade clock in seconds (`tick`), and the World's real time it last read. */
  private now = 0;
  private lastRealtime = -1;
  /** The World's frame count at the last tick, and whether a renderer selected a view since (`select`). */
  private lastFrame = -1;
  private rendered = false;
  private readonly views = new Map<ViewKey, ViewEntry>();
  private generation = 0;
  private mainEntry: ViewEntry | null = null;
  private readonly removeHook: () => void;

  constructor(private readonly world: World) {
    this.removeHook = world._afterPropagation(() => this.update());
  }

  /**
   * Bring members, groups and bounds up to date and select for the main camera. Runs after each transform propagation;
   * callers that need this frame's result before it (the animation gather) may call it themselves.
   */
  update(): void {
    this.gather();
    const camera = mainCamera(this.world);
    if (!camera) {
      this.mainEntry = null;
      return;
    }
    const px = camera._devicePixelSize();
    this.mainEntry = this.run(cameraView(camera, px.width, px.height));
  }

  /** The main camera's result this frame, or null without an enabled camera. */
  get main(): VisibilityResult | null {
    return this.mainEntry?.result ?? null;
  }

  /**
   * One view's result. The main camera's view (same key, same matrix and height) reuses the frame's result; any other
   * view is selected now, with hysteresis kept per view key when the view is persistent.
   */
  select(view: VisibilityView): VisibilityResult {
    const main = this.mainEntry;
    if (main && main.generation === this.generation && sameView(main.result.view, view)) {
      this.rendered = true;
      return main.result;
    }
    // A renderer selects each view once a frame: a view selected again with no gather since is a new frame (an
    // edit-mode World that isn't stepped), so gather first.
    if (this.generation === 0 || this.views.get(view.key)?.generation === this.generation) this.gather();
    this.rendered = true;
    return this.run(view).result;
  }

  /**
   * The outgoing level per slot of a result this service gave (`LOD_CULLED` where it doesn't fade, or fades in from
   * culled), or null for a result it no longer holds. A slot fades while its `fade` value isn't 0.
   */
  fadeLevels(result: VisibilityResult): Uint8Array | null {
    const v = this.views.get(result.view.key);
    return v && v.result === result ? v.fadeLevels : null;
  }

  /** Whether a member's group crossfades level changes now (its `fade` is `"crossfade"` and the tier allows it). */
  crossfades(member: LodMember): boolean {
    const m = this.members.get(member as Member);
    if (!m || !m.group || !Graphics.tier.lodCrossfade) return false;
    return (this.input.fadeDuration[m.group.index] ?? 0) > 0;
  }

  /** A member's renderer slot, or -1 while it has none (disabled, or not seen since it was enabled). */
  slotOf(member: LodMember): number {
    return this.members.get(member as Member)?.slot ?? -1;
  }

  /** How many slots results hold (the highest slot + 1). */
  get slots(): number {
    return this.slotCount;
  }

  /** A group's level for the main camera: 0 without a camera or before its first frame, -1 when LOD-culled. */
  levelOf(group: LODGroup): number {
    const e = this.groups.get(group);
    const main = this.mainEntry;
    if (!e || !main || e.index >= main.groupOut.levels.length) return 0;
    const level = main.groupOut.levels[e.index];
    return level === LOD_CULLED ? -1 : level;
  }

  /** Why a group is or isn't drawn for the main camera: `"drawn"` without a camera or before its first frame. */
  visibilityOf(group: LODGroup): LodVisibility {
    const e = this.groups.get(group);
    const main = this.mainEntry;
    if (!e || !main || e.index >= main.groupOut.levels.length) return "drawn";
    if (main.groupOut.hidden[e.index]) return "offScreen";
    return main.groupOut.levels[e.index] === LOD_CULLED ? "lodCulled" : "drawn";
  }

  /** The statistics of a view's last selection (`LODGroup`s only), or null when it hasn't been selected. */
  stats(key: ViewKey): VisibilityStats | null {
    return this.views.get(key)?.stats ?? null;
  }

  /** Forget a view: its buffers and hysteresis (a camera removed, a probe face done). */
  forgetView(key: ViewKey): void {
    this.views.delete(key);
    this.state.dropView(key);
  }

  dispose(): void {
    this.removeHook();
    this.members.clear();
    this.groups.clear();
    this.views.clear();
    this.mainEntry = null;
  }

  // --- gathering -------------------------------------------------------------------------------------------------

  private gather(): void {
    const frame = ++this.generation;
    this.tick();
    const world = this.world;
    // Owner entity → its LODGroup, or null for a disabled one (which stops the search).
    const owners = new Map<number, LODGroup | null>();
    for (const g of world._componentsOfType(LODGroup)) {
      if (g._destroyed) continue;
      const e = g.owner.entity;
      const active = g.isActiveAndEnabled;
      if (active && !owners.get(e)) owners.set(e, g);
      else if (!owners.has(e)) owners.set(e, null);
      if (active) this.groupEntry(g, frame);
    }
    for (const type of lodMemberTypes()) {
      for (const c of world._componentsOfType(type)) {
        if (!c.isActiveAndEnabled) continue;
        let m = this.members.get(c);
        if (!m) {
          const slot = this.freeSlots.pop() ?? this.slotCount++;
          this.members.set(c, (m = { member: c, slot, bounds: new RendererBounds(), group: null, seen: 0 }));
        }
        m.seen = frame;
        let owner: LODGroup | null = null;
        for (let e = c.gameObject.entity; e !== -1; e = world.parentOf[e]) {
          if (owners.has(e)) {
            owner = owners.get(e)!;
            break;
          }
        }
        const g = this.groupEntry(owner ?? c, frame);
        m.group = g;
        g.members.push(m);
      }
    }
    for (const [key, m] of this.members) {
      if (m.seen === frame) continue;
      this.members.delete(key);
      this.freeSlots.push(m.slot);
    }
    for (const [key, g] of this.groups) {
      if (g.seen === frame) continue;
      this.groups.delete(key);
      this.entries[g.index] = null;
      this.freeGroups.push(g.index);
      this.state.forget(g.index);
    }
    this.fillInput();
  }

  /** Advance the fade clock: by the World's real time, or a 60th of a second where it doesn't advance. */
  private tick(): void {
    const time = this.world.time;
    const real = time.realtimeSinceStartup;
    const delta = this.lastRealtime >= 0 ? real - this.lastRealtime : 0;
    this.lastRealtime = real;
    const frame = time.frameCount;
    if (delta > 0) this.now += delta;
    else if (frame === this.lastFrame && this.rendered) this.now += 1 / 60; // a World that isn't stepped, drawn again
    // Otherwise the same frame again (the animation gather's `update`, then the one after propagation): no advance.
    this.lastFrame = frame;
    this.rendered = false;
  }

  /** The group entry for an `LODGroup`, or for a lone member (its own key); made on first sight, members reset once a frame. */
  private groupEntry(key: LODGroup | Member, frame: number): GroupEntry {
    let g = this.groups.get(key);
    if (!g) {
      const index = this.freeGroups.pop() ?? this.groupCount++;
      this.state.forget(index);
      g = { owner: key instanceof LODGroup ? key : null, index, members: [], previous: [], bounds: newGroupBounds(), matrix: null, automatic: false, seen: 0 };
      this.groups.set(key, g);
      this.entries[index] = g;
    }
    if (g.seen !== frame) {
      g.seen = frame;
      const prev = g.previous;
      g.previous = g.members;
      g.members = prev;
      prev.length = 0;
    }
    return g;
  }

  private grow(count: number): void {
    const i = this.input;
    if (i.size.length >= count) return;
    const n = Math.max(count, i.size.length * 2, 16);
    const sphere = new Float32Array(n * 4), size = new Float32Array(n), heights = new Float32Array(n * MAX_LOD_LEVELS);
    const heightStart = new Uint32Array(n), heightCount = new Uint8Array(n), forceLevel = new Int16Array(n), fadeDuration = new Float32Array(n);
    sphere.set(i.sphere);
    fadeDuration.set(i.fadeDuration);
    size.set(i.size);
    heights.set(i.heights);
    heightCount.set(i.heightCount);
    forceLevel.set(i.forceLevel);
    for (let g = 0; g < n; g++) heightStart[g] = g * MAX_LOD_LEVELS;
    this.input = { count: i.count, sphere, size, heights, heightStart, heightCount, forceLevel, fadeDuration };
  }

  /** Bounds, sizes, heights and forced levels into the selection input. */
  private fillInput(): void {
    this.grow(this.groupCount);
    const input = this.input;
    input.count = this.groupCount;
    const world = this.world;
    for (let index = 0; index < this.groupCount; index++) {
      const g = this.entries[index];
      if (!g) {
        // A free index: a group of nothing, LOD0, never culled, off nowhere.
        input.sphere.fill(0, index * 4, index * 4 + 4);
        input.size[index] = 0;
        input.heightCount[index] = 1;
        input.heights[index * MAX_LOD_LEVELS] = 0;
        input.forceLevel[index] = -1;
        input.fadeDuration[index] = 0;
        continue;
      }
      const membership = g.members.length !== g.previous.length || g.members.some((m, i) => m !== g.previous[i]);
      let dirty = membership, meshesChanged = membership;
      for (const m of g.members) {
        const [src, offset] = matrixOf(world, m.member);
        const version = m.bounds.localVersion;
        if (m.bounds.update(m.member.lodMeshes(), src === null ? IDENTITY : src, offset)) dirty = true;
        if (m.bounds.localVersion !== version) meshesChanged = true;
      }
      const owner = g.owner;
      if (owner) {
        const node = owner.owner;
        const e = node.entity;
        const gm = node.transform ? world.worldMatrix(e) : IDENTITY;
        const go = node.transform ? e * 16 : 0;
        if (!g.matrix || !sameMatrix(g.matrix, gm, go)) {
          (g.matrix ??= new Float32Array(16)).set(gm.subarray(go, go + 16));
          dirty = true;
        }
        if (dirty) computeGroupBounds(g.members.map((m) => m.bounds), g.matrix, 0, g.bounds);
        input.sphere.set(g.bounds.sphere, index * 4);
        input.size[index] = owner.size > 0 ? owner.size : g.bounds.size;
        input.forceLevel[index] = Number.isInteger(owner.forceLevel) && owner.forceLevel >= 0 ? Math.min(owner.forceLevel, 254) : -1;
        input.fadeDuration[index] = owner.fade === "crossfade" && Number.isFinite(owner.fadeDuration) ? Math.max(0, owner.fadeDuration) : 0;
        this.fillHeights(g, owner, meshesChanged);
      } else {
        const b = g.members[0]?.bounds;
        if (b) input.sphere.set(b.sphere, index * 4);
        input.size[index] = 0;
        input.heightCount[index] = 1;
        input.heights[index * MAX_LOD_LEVELS] = 0;
        input.forceLevel[index] = -1;
        input.fadeDuration[index] = 0;
      }
    }
  }

  /** A group's heights: its `levels`, or automatic ones derived again whenever its members' meshes change. */
  private fillHeights(g: GroupEntry, owner: LODGroup, meshesChanged: boolean): void {
    const input = this.input;
    const at = g.index * MAX_LOD_LEVELS;
    const levels = owner.levels;
    if (levels.length) {
      const n = Math.min(levels.length, MAX_LOD_LEVELS);
      for (let i = 0; i < n; i++) input.heights[at + i] = Number.isFinite(levels[i]) ? Math.max(0, levels[i]) : 0;
      input.heightCount[g.index] = n;
      g.automatic = false;
      return;
    }
    if (g.automatic && !meshesChanged) return;
    g.automatic = true;
    const lods: MeshLevelErrors[] = [];
    for (const m of g.members) for (const mesh of m.member.lodMeshes() ?? ([] as readonly ModelMesh[])) if (mesh.lods) lods.push(mesh.lods);
    const heights = automaticHeights(lods);
    const n = Math.min(heights.length, MAX_LOD_LEVELS);
    for (let i = 0; i < n; i++) input.heights[at + i] = heights[i];
    input.heightCount[g.index] = n;
  }

  // --- selecting -------------------------------------------------------------------------------------------------

  private run(view: VisibilityView): ViewEntry {
    const groups = this.groupCount, slots = this.slotCount;
    let v = this.views.get(view.key);
    if (!v || v.groupOut.levels.length < groups || v.result.levels.length < slots) {
      const gn = Math.max(groups, 16), sn = Math.max(slots, 16);
      v = {
        result: { view, levels: new Uint8Array(sn), casterLevels: new Uint8Array(sn), hidden: new Uint8Array(sn), fade: new Float32Array(sn) },
        fadeLevels: new Uint8Array(sn),
        groupOut: { levels: new Uint8Array(gn), casterLevels: new Uint8Array(gn), hidden: new Uint8Array(gn), fade: new Float32Array(gn), fadeFrom: new Uint8Array(gn) },
        stats: { groups: 0, perLevel: [], lodCulled: 0, fading: 0, occlusion: null },
        generation: 0,
      };
      this.views.set(view.key, v);
    } else v.result = { ...v.result, view };
    v.generation = this.generation;
    const tier: Readonly<QualityTier> = Graphics.tier;
    const out = v.groupOut;
    selectLevels(view, this.input as SelectionGroups, tier, this.state, out, this.now);
    const r = v.result;
    const levels = r.levels as Uint8Array, casters = r.casterLevels as Uint8Array, hidden = r.hidden as Uint8Array, fade = r.fade as Float32Array;
    const fadeLevels = v.fadeLevels, fadeFrom = out.fadeFrom!;
    levels.fill(LOD_CULLED);
    casters.fill(LOD_CULLED);
    hidden.fill(1);
    fade.fill(0);
    fadeLevels.fill(LOD_CULLED);
    for (const m of this.members.values()) {
      const g = m.group!.index;
      levels[m.slot] = out.levels[g];
      hidden[m.slot] = out.hidden[g];
      casters[m.slot] = castsShadows(m.member) ? out.casterLevels[g] : LOD_CULLED;
      fade[m.slot] = out.fade[g];
      fadeLevels[m.slot] = fadeFrom[g];
    }
    let count = 0, lodCulled = 0, fading = 0;
    const perLevel: number[] = [];
    for (const g of this.groups.values()) {
      if (!g.owner) continue;
      count++;
      const level = out.levels[g.index];
      if (out.fade[g.index] !== 0) fading++;
      if (level === LOD_CULLED) lodCulled++;
      else if (!out.hidden[g.index]) perLevel[level] = (perLevel[level] ?? 0) + 1;
    }
    for (let i = 0; i < perLevel.length; i++) perLevel[i] ??= 0;
    v.stats = { groups: count, perLevel, lodCulled, fading, occlusion: null };
    return v;
  }
}

/** The World's main camera: the enabled `Camera` with the lowest depth (the first such, as `Camera.main`). */
function mainCamera(world: World): Camera | null {
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
  return best;
}

/** The world matrix a member draws at: its node's, else (no transform) the node it acts for, else none. */
function matrixOf(world: World, member: Member): [Float32Array | null, number] {
  let node = member.gameObject;
  if (!node.transform) node = member.owner;
  if (!node.transform) return [null, 0];
  return [world.worldMatrix(node.entity), node.entity * 16];
}

function sameMatrix(a: Float32Array, b: ArrayLike<number>, o: number): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[o + i]) return false;
  return true;
}

function sameView(a: VisibilityView, b: VisibilityView): boolean {
  if (a === b) return true;
  if (a.key !== b.key || a.heightPx !== b.heightPx || a.projection !== b.projection) return false;
  for (let i = 0; i < 16; i++) if (a.viewProjection[i] !== b.viewProjection[i]) return false;
  return true;
}

/** @internal The World's visibility stage, or null while it isn't running there (no `LODGroup` yet). */
export function visibilityService(world: World): VisibilityService | null {
  return (_worldServiceOf(world, VISIBILITY_SERVICE_ID) as VisibilityService | null) ?? null;
}

_registerWorldService<null, VisibilityService>({
  id: VISIBILITY_SERVICE_ID,
  load: () => Promise.resolve(null),
  create: (world) => new VisibilityService(world),
  dispose: (service) => service.dispose(),
  neededBy: { components: ["engine.LODGroup"] },
  // Every World selects: the editor's (its scene view and `currentLevel` in edit mode), the player's, servers'.
  runsIn: () => true,
});
