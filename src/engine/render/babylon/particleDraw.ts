// Internal (ADR 0057, 0075): how simulated particles are drawn on the Babylon backend. One Babylon CPU
// `ParticleSystem` per emitter, with its own emission and update turned off, shows the particle list
// `EffectSimulation` produced (billboards, stretched, flipbook sheets, blending). Shared by the World's
// player (`particles.ts`) and the editor's effect preview (`previews/EffectPreview.ts`).
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Particle } from "@babylonjs/core/Particles/particle.js";
import { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ParticleRenderer as RendererSettings } from "../../scene/particles";
import type { SimEmitter } from "../particles/simulation";

/** One emitter's Babylon particle system. */
export interface Draw {
  name: string;
  emitter: SimEmitter;
  ps: BabylonParticleSystem;
  capacity: number;
  /** Babylon particles taken off the list, reused later. */
  spare: Particle[];
  mode: "billboard" | "stretched" | "horizontal" | "vertical";
  texture: BaseTexture;
}

/** The default dot texture's size in pixels. */
export const DOT_SIZE = 64;

// Babylon's billboard modes (`ParticleSystem.BILLBOARDMODE_*`).
const BILLBOARD_ALL = 7;
const BILLBOARD_Y = 2;
const BILLBOARD_STRETCHED = 8;

/** The soft round dot particles use when they have no texture. */
export function createDotTexture(scene: Scene): RawTexture {
  const size = DOT_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  const dot = new RawTexture(data, size, size, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  dot.hasAlpha = true;
  dot.name = "particle dot";
  return dot;
}

/** A started Babylon particle system for an emitter, holding up to `capacity` particles; `isDot` when `texture` is the default dot. */
export function makeDraw(scene: Scene, name: string, e: SimEmitter, capacity: number, texture: BaseTexture, isDot: boolean): Draw {
  const r: RendererSettings = e.renderer;
  const sheet = r.tiles[0] * r.tiles[1] > 1;
  const ps = new BabylonParticleSystem(name, capacity, scene, null, sheet);
  ps.particleTexture = texture;
  ps.emitter = Vector3.Zero();
  ps.emitRate = 0;
  ps.updateFunction = () => {}; // the simulation owns the list; sync mirrors into it
  ps.renderingGroupId = 0; // draw order among transparent things is left to Babylon (renderOrder isn't used)
  ps.blendMode = r.blending === "additive" ? BabylonParticleSystem.BLENDMODE_ADD : r.blending === "premultiplied" ? Constants.ALPHA_PREMULTIPLIED : BabylonParticleSystem.BLENDMODE_STANDARD;
  const mode: Draw["mode"] = r.mode === "stretched" || r.mode === "horizontal" || r.mode === "vertical" ? r.mode : "billboard";
  ps.isBillboardBased = mode !== "horizontal";
  ps.billboardMode = mode === "stretched" ? BILLBOARD_STRETCHED : mode === "vertical" ? BILLBOARD_Y : BILLBOARD_ALL;
  if (sheet) {
    const size = isDot ? { width: DOT_SIZE, height: DOT_SIZE } : texture.getBaseSize();
    ps.spriteCellWidth = size.width / r.tiles[0];
    ps.spriteCellHeight = size.height / r.tiles[1];
  }
  ps.start();
  return { name, emitter: e, ps, capacity, spare: [], mode, texture };
}

/** Copy the simulation's particles into Babylon's list for drawing (the list must be no larger than `d.capacity`). */
export function copyParticles(d: Draw): void {
  const e = d.emitter;
  const list = d.ps.particles;
  const n = Math.min(e.count, d.capacity);
  while (list.length < n) list.push(d.spare.pop() ?? new Particle(d.ps));
  while (list.length > n) d.spare.push(list.pop()!);
  for (let i = 0; i < n; i++) {
    const p = e.pool[i];
    const b = list[i];
    b.position.set(p.wx, p.wy, p.wz);
    b.color.set(p.r, p.g, p.b, p.a);
    b.cellIndex = p.tile;
    b.size = 1;
    switch (d.mode) {
      case "stretched": {
        const speed = Math.hypot(p.wvx, p.wvy, p.wvz);
        b.angle = 0;
        b.scale.set(p.size, Math.max(p.length, 1e-4));
        if (speed > 1e-6) b.direction.set(p.wvx, p.wvy, p.wvz);
        else b.direction.set(0, 1, 0);
        break;
      }
      case "horizontal":
        b.angle = p.rotation;
        b.scale.set(p.size, p.size);
        b.direction.set(0.001, 1, 0); // the quad's normal; Babylon needs it off the pole
        break;
      default:
        b.angle = p.rotation;
        b.scale.set(p.size, p.size);
    }
  }
}
