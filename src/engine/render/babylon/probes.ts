/**
 * Reflection probes on the Babylon backend (ADR 0054, 0075 stage 6). Each ReflectionProbe component
 * is a Babylon `ReflectionProbe` (a cube render target) at its node, sized by the quality tier.
 * Probes capture once when the scene is ready (again when they move or `capture()` is called), or
 * every frame round-robin; a mesh whose bounds centre lies in one or more probe boxes reflects the
 * smallest (`pickProbe`).
 *
 * Captures render outside the frame graph, before it runs: a render target drawn in the middle of
 * the graph leaves its state wrong (see the stage 3 notes in ADR 0075).
 */
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { ReflectionProbe as BabylonReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { ReflectionProbe } from "../components";
import { Graphics } from "../Graphics";
import { pickProbe, PROBE_RESOLUTION, type ProbeBox } from "../probeBoxes";

interface ProbeEntry {
  probe: BabylonReflectionProbe | null;
  resolution: number;
  /** Frames left to render before the capture counts as done (the first frames may lack materials still compiling). */
  pending: number;
  captured: boolean;
  /** `ReflectionProbe._captureRequests` when last captured. */
  requests: number;
  box: ProbeBox;
}

/** Frames a capture renders for, so meshes whose materials compile on the first are in it. */
const CAPTURE_FRAMES = 3;

/** @internal Reflection probes for one Babylon scene. */
export class BabylonProbes {
  private readonly entries = new Map<ReflectionProbe, ProbeEntry>();
  private ids = 0;
  private round = 0;
  /** The probes that have captured, for `lookup`. */
  private boxes: { box: ProbeBox; texture: BaseTexture; intensity: number }[] = [];
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
        entry = { probe: null, resolution: 0, pending: 0, captured: false, requests: p._captureRequests, box: { id: ++this.ids, center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } } };
        this.entries.set(p, entry);
      }
      seen.add(p);
      const m = world.worldMatrix(p.node.entity);
      const o = p.node.entity * 16;
      const c = { x: m[o + 12], y: m[o + 13], z: m[o + 14] };
      const moved = entry.box.center.x !== c.x || entry.box.center.y !== c.y || entry.box.center.z !== c.z;
      entry.box.center = c;
      entry.box.size = { x: Math.abs(p.size.x), y: Math.abs(p.size.y), z: Math.abs(p.size.z) };
      if (!p.isActiveAndEnabled || !resolution) continue;
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
    this.boxes = live.filter(([, e]) => e.captured && e.probe).map(([p, e]) => ({ box: e.box, texture: e.probe!.cubeTexture, intensity: Math.max(0, p.intensity) }));
  }

  /** Render this frame's captures; call before the frame graph runs, with the camera that draws the view. */
  capture(camera: Camera | null): void {
    if (!this.toRender.length) return;
    const previous = this.scene.activeCamera;
    if (camera) this.scene.activeCamera = camera; // render targets read the scene's camera for culling and LOD
    for (const probe of this.toRender) probe.cubeTexture.render();
    this.scene.activeCamera = previous;
  }

  /** The probe a point reflects (the smallest box holding it), or null for the scene's environment. */
  lookup(x: number, y: number, z: number): { texture: BaseTexture; intensity: number } | null {
    const box = pickProbe({ x, y, z }, this.boxes.map((b) => b.box));
    const hit = box && this.boxes.find((b) => b.box === box);
    return hit ? { texture: hit.texture, intensity: hit.intensity } : null;
  }

  /** Tests: how many probes have captured, how many there are, and (set by the renderer) how many meshes reflect one. */
  state(reflecting: number): { captured: number; probes: number; reflecting: number } {
    return { captured: this.boxes.length, probes: this.entries.size, reflecting };
  }

  dispose(): void {
    for (const e of this.entries.values()) e.probe?.dispose();
    this.entries.clear();
  }
}
