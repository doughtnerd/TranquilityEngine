/**
 * Reflection probes on the Babylon backend (ADR 0054, 0075 stage 6). Each ReflectionProbe component
 * is a Babylon `ReflectionProbe` (a cube render target) at its node, sized by the quality tier.
 * Probes capture once when the scene is ready (again when they move or `capture()` is called), or
 * every frame round-robin; a mesh whose bounds centre lies in one or more probe boxes reflects the
 * smallest (`pickProbe`).
 *
 * Captures render outside the frame graph, before it runs: a render target drawn in the middle of
 * the graph leaves its state wrong (see the stage 3 notes in ADR 0075).
 *
 * ADR 0110: a probe can box-project its reflections (Babylon's local cube maps: the texture's
 * `boundingBoxSize` and `boundingBoxPosition`), use a capture baked in the editor (a prefiltered `.env`
 * file) instead of capturing, and blend with a neighbour near its box's faces (`lookup`'s `blend`,
 * drawn by `probeBlend.ts`).
 */
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture.js";
import { CreateEnvTextureAsync } from "@babylonjs/core/Misc/environmentTextureTools.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { ReflectionProbe as BabylonReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { ReflectionProbe } from "../components";
import { Graphics } from "../Graphics";
import { Assets } from "../../scene/Assets";
import { blendProbes, PROBE_RESOLUTION, type BlendBox } from "../probeBoxes";

interface ProbeEntry {
  probe: BabylonReflectionProbe | null;
  resolution: number;
  /** Frames left to render before the capture counts as done (the first frames may lack materials still compiling). */
  pending: number;
  captured: boolean;
  /** `ReflectionProbe._captureRequests` when last captured. */
  requests: number;
  box: BlendBox;
  /** A baked capture (`refresh: "baked"`), loaded from `bakedMap`. */
  baked: { path: string; texture: CubeTexture | null; failed: boolean } | null;
}

/** What a mesh reflects (`BabylonProbes.lookup`). */
export interface ProbeHit {
  texture: BaseTexture;
  intensity: number;
  /** Near the probe's faces, a neighbour to fade towards: the primary's share is `weight` (ADR 0110). */
  blend: { texture: BaseTexture; intensity: number; weight: number; box: BlendBox | null } | null;
}

/** Set or clear box projection on a probe's texture (ADR 0110). Babylon's setter can't take null. */
function setBoxProjection(texture: BaseTexture, box: BlendBox | null): void {
  const t = texture as BaseTexture & { boundingBoxSize?: Vector3 | null; boundingBoxPosition: Vector3; _boundingBoxSize?: Vector3 | null };
  if (!box) {
    if (t._boundingBoxSize) {
      t._boundingBoxSize = null;
      texture.getScene()?.markAllMaterialsAsDirty(1);
    }
    return;
  }
  const size = new Vector3(box.size.x, box.size.y, box.size.z);
  if (!t._boundingBoxSize || !t._boundingBoxSize.equals(size)) t.boundingBoxSize = size;
  if (!t.boundingBoxPosition.equalsToFloats(box.center.x, box.center.y, box.center.z)) t.boundingBoxPosition = new Vector3(box.center.x, box.center.y, box.center.z);
}

/** Frames a capture renders for, so meshes whose materials compile on the first are in it. */
const CAPTURE_FRAMES = 3;

/** @internal Reflection probes for one Babylon scene. */
export class BabylonProbes {
  private readonly entries = new Map<ReflectionProbe, ProbeEntry>();
  private ids = 0;
  private round = 0;
  /** The probes that have captured, for `lookup`. */
  private boxes: { box: BlendBox; texture: BaseTexture; intensity: number; projected: boolean }[] = [];
  /** Probes to render this frame (see `capture`). */
  private toRender: BabylonReflectionProbe[] = [];

  constructor(private readonly scene: Scene) {}

  /**
   * Step 8: mirror the World's ReflectionProbes. `renderList` is what probes capture; `ready` says the
   * scene has finished loading (models and textures), so a capture now is worth keeping.
   */
  sync(world: World, renderList: AbstractMesh[], ready: boolean): void {
    const resolution = PROBE_RESOLUTION[Graphics.tier.reflectionProbes];
    const seen = new Set<ReflectionProbe>();
    const live: [ReflectionProbe, ProbeEntry][] = [];
    for (const p of world._componentsOfType(ReflectionProbe)) {
      let entry = this.entries.get(p);
      if (!entry) {
        entry = { probe: null, resolution: 0, pending: 0, captured: false, requests: p._captureRequests, box: { id: ++this.ids, center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, blendDistance: 0 }, baked: null };
        this.entries.set(p, entry);
      }
      seen.add(p);
      const m = world.worldMatrix(p.node.entity);
      const o = p.node.entity * 16;
      const c = { x: m[o + 12], y: m[o + 13], z: m[o + 14] };
      const moved = entry.box.center.x !== c.x || entry.box.center.y !== c.y || entry.box.center.z !== c.z;
      entry.box.center = c;
      entry.box.size = { x: Math.abs(p.size.x), y: Math.abs(p.size.y), z: Math.abs(p.size.z) };
      entry.box.blendDistance = Math.max(0, p.blendDistance);
      if (!p.isActiveAndEnabled || !resolution) continue;
      if (this.syncBaked(p, entry)) {
        live.push([p, entry]);
        continue; // a baked capture: nothing to render
      }
      if (entry.probe && entry.resolution !== resolution) {
        entry.probe.dispose();
        entry.probe = null;
        entry.captured = false;
      }
      if (!entry.probe) {
        // Float, linear: the scene renders in linear HDR (the frame graph's finish pass tone maps).
        const probe = new BabylonReflectionProbe(`probe:${p.node.name}`, resolution, this.scene, true, true, true);
        probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE; // rendered by hand in `capture`
        entry.probe = probe;
        entry.resolution = resolution;
      }
      entry.probe.position = new Vector3(c.x, c.y, c.z);
      entry.probe.renderList = renderList;
      if (moved && entry.captured && p.refresh === "onLoad") entry.captured = false; // moved: capture where it is now
      live.push([p, entry]);
    }
    for (const [p, entry] of [...this.entries]) {
      if (seen.has(p)) continue;
      entry.probe?.dispose();
      this.entries.delete(p);
    }
    this.toRender = [];
    if (ready) {
      for (const [p, entry] of live) {
        if (!entry.captured || entry.requests !== p._captureRequests) {
          entry.requests = p._captureRequests;
          entry.captured = true;
          entry.pending = CAPTURE_FRAMES;
        }
        if (entry.pending > 0) {
          entry.pending--;
          this.toRender.push(entry.probe!);
        }
      }
      // everyFrame probes: one recaptured per frame, round-robin.
      const every = live.filter(([p]) => p.refresh === "everyFrame");
      if (every.length) {
        const probe = every[this.round++ % every.length][1].probe!;
        if (!this.toRender.includes(probe)) this.toRender.push(probe);
      }
    }
    this.boxes = [];
    for (const [p, e] of live) {
      const texture = e.baked?.texture?.isReady() ? e.baked.texture : e.captured && e.probe ? e.probe.cubeTexture : null;
      if (!texture) continue;
      setBoxProjection(texture, p.boxProjection ? e.box : null);
      this.boxes.push({ box: e.box, texture, intensity: Math.max(0, p.intensity), projected: p.boxProjection });
    }
  }

  /**
   * A probe set to `baked` with a `bakedMap`: load it once (true while it's used, even loading); false
   * to capture instead (no map, or it failed: warned once).
   */
  private syncBaked(p: ReflectionProbe, entry: ProbeEntry): boolean {
    const path = p.refresh === "baked" ? p.bakedMap.replace(/^asset:/, "") : "";
    if (entry.baked && entry.baked.path !== path) {
      entry.baked.texture?.dispose();
      entry.baked = null;
    }
    if (!path) return false;
    if (!entry.baked) {
      entry.baked = { path, texture: null, failed: false };
      const baked = entry.baked;
      try {
        const url = Assets.url(path);
        baked.texture = CubeTexture.CreateFromPrefilteredData(url, this.scene, ".env");
        baked.texture.onLoadObservable.addOnce(() => baked.texture && (baked.texture.name = `probe:${p.node.name}:baked`));
        const internal = baked.texture.getInternalTexture();
        internal?.onErrorObservable?.addOnce(() => {
          baked.failed = true;
          console.warn(`[myco] reflection probe "${p.node.name}": its baked map "${path}" couldn't load; capturing instead.`);
        });
      } catch {
        baked.failed = true;
        console.warn(`[myco] reflection probe "${p.node.name}": its baked map "${path}" isn't in the project; capturing instead.`);
      }
    }
    if (entry.baked.failed) return false;
    entry.probe?.dispose(); // a capture made before the map loaded (or before it was set)
    entry.probe = null;
    entry.captured = true;
    return true;
  }

  /**
   * Editor (ADR 0110): a probe's current capture as a prefiltered `.env` file, for its `bakedMap`.
   * Rejects when the probe hasn't captured yet (probes off on this tier, or the scene still loading).
   */
  async bake(p: ReflectionProbe): Promise<ArrayBuffer> {
    const e = this.entries.get(p);
    const texture = e?.captured ? (e.probe?.cubeTexture ?? e.baked?.texture ?? null) : null;
    if (!texture) throw new Error(`reflection probe "${p.node.name}" hasn't captured yet (is the quality tier's reflectionProbes off?)`);
    return CreateEnvTextureAsync(texture, { imageType: "image/png" });
  }

  /** Render this frame's captures; call before the frame graph runs, with the camera that draws the view. */
  capture(camera: Camera | null): void {
    if (!this.toRender.length) return;
    const previous = this.scene.activeCamera;
    if (camera) this.scene.activeCamera = camera; // render targets read the scene's camera for culling and LOD
    for (const probe of this.toRender) probe.cubeTexture.render();
    this.scene.activeCamera = previous;
  }

  /** The probes that have captured, as unblended hits: the copies a warm-up draws (ADR 0080). */
  textures(): ProbeHit[] {
    return this.boxes.map((b) => ({ texture: b.texture, intensity: b.intensity, blend: null }));
  }

  /** Whether any probe has captured (so `lookup` can find one). */
  get any(): boolean {
    return this.boxes.length > 0;
  }

  /**
   * The probe a point reflects (the smallest box holding it), with a neighbour to blend towards near
   * its faces (ADR 0110), or null for the scene's environment.
   */
  lookup(x: number, y: number, z: number): ProbeHit | null {
    if (!this.boxes.length) return null;
    const pick = blendProbes({ x, y, z }, this.boxes.map((b) => b.box));
    const hit = pick && this.boxes.find((b) => b.box === pick.primary);
    if (!pick || !hit) return null;
    const other = pick.secondary && this.boxes.find((b) => b.box === pick.secondary);
    return {
      texture: hit.texture,
      intensity: hit.intensity,
      blend: other ? { texture: other.texture, intensity: other.intensity, weight: pick.weight, box: other.projected ? other.box : null } : null,
    };
  }

  /** Tests: how many probes have captured, how many there are, and (set by the renderer) how many meshes reflect one. */
  state(reflecting: number): { captured: number; probes: number; reflecting: number } {
    return { captured: this.boxes.length, probes: this.entries.size, reflecting };
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.probe?.dispose();
      e.baked?.texture?.dispose();
    }
    this.entries.clear();
  }
}
