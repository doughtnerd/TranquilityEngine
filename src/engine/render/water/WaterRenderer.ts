/**
 * Draws a World's WaterSurfaces (ADR 0072): one grid mesh and one patched MeshPhysicalMaterial per
 * surface, updated each frame from the component and the water clock. Internal to the render
 * backend, which creates it the first time a World has water.
 */
import { BufferGeometry, Color as ThreeColor, FrontSide, Matrix4, Mesh, MeshPhysicalMaterial, PlaneGeometry, SRGBColorSpace, type Scene, type Texture, Vector3 as ThreeVector3 } from "three";
import type { World } from "../../core/World";
import { Graphics } from "../Graphics";
import { MAX_WAVES, WAVE_STRIDE, maxAmplitude } from "./gerstner";
import { patchWaterShader } from "./waterShader";
import { WaterSurface, waterTime } from "./WaterSurface";

/** A reflection probe's map and strength (ADR 0054), or null for the World's environment only. */
export type WaterProbeLookup = (x: number, y: number, z: number) => { texture: Texture; intensity: number } | null;

interface WaterUniforms {
  mycoWaves: { value: Float32Array };
  mycoWaveCount: { value: number };
  mycoWaterTime: { value: number };
  mycoDeepColor: { value: ThreeColor };
  mycoShallowColor: { value: ThreeColor };
  mycoFoamColor: { value: ThreeColor };
  mycoFoamAmount: { value: number };
  mycoNormalDetail: { value: number };
  mycoMaxHeight: { value: number };
}

interface WaterEntry {
  mesh: Mesh<BufferGeometry, MeshPhysicalMaterial>;
  uniforms: WaterUniforms;
  /** The size and vertex count the geometry was built for. */
  built: { size: number; resolution: number };
  probe: Texture | null;
}

/** Program cache key: every water material shares one compiled program. */
const PROGRAM_KEY = "myco-water-1";

/** The vertices per side a surface is drawn with on the active tier ("low" shader level: half). */
export function waterResolution(resolution: number, shaderLevel: string): number {
  const r = Number.isFinite(resolution) ? resolution : 128;
  const scaled = shaderLevel === "low" ? r * 0.5 : r;
  return Math.max(2, Math.min(1024, Math.round(scaled)));
}

/** A flat grid of `size`, `resolution` vertices per side, in the XZ plane facing +Y. */
export function waterGeometry(size: number, resolution: number): BufferGeometry {
  const s = Math.max(Math.abs(size), 1e-3);
  const g = new PlaneGeometry(s, s, resolution - 1, resolution - 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Create a water material with its own uniforms (exported for tests). */
export function createWaterMaterial(): { material: MeshPhysicalMaterial; uniforms: WaterUniforms } {
  const uniforms: WaterUniforms = {
    mycoWaves: { value: new Float32Array(MAX_WAVES * WAVE_STRIDE) },
    mycoWaveCount: { value: 0 },
    mycoWaterTime: { value: 0 },
    mycoDeepColor: { value: new ThreeColor() },
    mycoShallowColor: { value: new ThreeColor() },
    mycoFoamColor: { value: new ThreeColor() },
    mycoFoamAmount: { value: 0 },
    mycoNormalDetail: { value: 0 },
    mycoMaxHeight: { value: 0 },
  };
  const material = new MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.08, side: FrontSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchWaterShader(shader);
  };
  material.customProgramCacheKey = () => PROGRAM_KEY;
  return { material, uniforms };
}

const tmpMatrix = new Matrix4();
const tmpPoint = new ThreeVector3();

export class WaterRenderer {
  private readonly entries = new Map<WaterSurface, WaterEntry>();

  constructor(
    private readonly scene: Scene,
    private readonly probeAt: WaterProbeLookup = () => null,
  ) {}

  /** Bring every surface's mesh up to date for this frame. */
  sync(world: World, surfaces: readonly WaterSurface[]): void {
    const seen = new Set<WaterSurface>();
    const time = waterTime(world);
    const level = Graphics.tier.shaderLevel;
    for (const w of surfaces) {
      seen.add(w);
      const entry = this.entry(w);
      const resolution = waterResolution(w.resolution, level);
      const size = Math.max(Math.abs(w.size), 1e-3);
      if (entry.built.size !== size || entry.built.resolution !== resolution) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = waterGeometry(size, resolution);
        entry.built = { size, resolution };
      }
      const mesh = entry.mesh;
      mesh.visible = w.isActiveAndEnabled;
      if (!mesh.visible) continue;
      const e = w.node.entity;
      if (w.node.transform) mesh.matrix.fromArray(world.worldMatrix(e), e * 16);
      else mesh.matrix.identity();
      mesh.matrixWorldNeedsUpdate = true;
      this.applyUniforms(w, entry, time);
      this.applyMaterial(w, entry);
    }
    for (const w of [...this.entries.keys()]) if (!seen.has(w)) this.release(w);
  }

  private entry(w: WaterSurface): WaterEntry {
    let entry = this.entries.get(w);
    if (!entry) {
      const { material, uniforms } = createWaterMaterial();
      const mesh = new Mesh(new BufferGeometry(), material);
      mesh.matrixAutoUpdate = false;
      // Displaced vertices leave the flat grid's bounds; the grid is usually on screen anyway.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = "myco-water";
      this.scene.add(mesh);
      entry = { mesh, uniforms, built: { size: -1, resolution: -1 }, probe: null };
      this.entries.set(w, entry);
    }
    return entry;
  }

  private applyUniforms(w: WaterSurface, entry: WaterEntry, time: number): void {
    const packed = w._pack(time);
    const u = entry.uniforms;
    u.mycoWaves.value.set(packed.data);
    u.mycoWaveCount.value = packed.count;
    u.mycoWaterTime.value = time % 10000;
    u.mycoDeepColor.value.setRGB(w.deepColor.r, w.deepColor.g, w.deepColor.b, SRGBColorSpace);
    u.mycoShallowColor.value.setRGB(w.shallowColor.r, w.shallowColor.g, w.shallowColor.b, SRGBColorSpace);
    u.mycoFoamColor.value.setRGB(w.foamColor.r, w.foamColor.g, w.foamColor.b, SRGBColorSpace);
    u.mycoFoamAmount.value = clamp01(w.foamAmount);
    u.mycoNormalDetail.value = Math.max(0, w.normalDetail);
    u.mycoMaxHeight.value = maxAmplitude(packed);
  }

  private applyMaterial(w: WaterSurface, entry: WaterEntry): void {
    const m = entry.mesh.material;
    m.roughness = clamp01(w.roughness);
    m.reflectivity = clamp01(w.reflectivity);
    const opacity = clamp01(w.opacity);
    const transparent = opacity < 1;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.needsUpdate = true;
    }
    m.opacity = opacity;
    // A reflection probe whose box holds the surface's centre (ADR 0054).
    tmpMatrix.copy(entry.mesh.matrix);
    tmpPoint.setFromMatrixPosition(tmpMatrix);
    const probe = this.probeAt(tmpPoint.x, tmpPoint.y, tmpPoint.z);
    const tex = probe?.texture ?? null;
    if (entry.probe !== tex) {
      if (!!m.envMap !== !!tex) m.needsUpdate = true;
      m.envMap = tex;
      entry.probe = tex;
    }
    m.envMapIntensity = probe ? probe.intensity : 1;
  }

  /** @internal Tests: the drawn meshes. */
  meshes(): Mesh[] {
    return [...this.entries.values()].map((e) => e.mesh);
  }

  release(w: WaterSurface): void {
    const e = this.entries.get(w);
    if (!e) return;
    this.scene.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.mesh.material.dispose();
    this.entries.delete(w);
  }

  dispose(): void {
    for (const w of [...this.entries.keys()]) this.release(w);
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}
