/**
 * The editor's component icons on the Babylon backend (ADR 0022, 0043, 0075 stage 8, 0128): every
 * camera, light and particle system in the edited scene shows as a clickable icon facing the view, a
 * constant size on screen. Cameras and lights also draw a wireframe (what a camera sees, a light's
 * direction, cone or range), in the selection colour when selected. One loop draws all three kinds
 * (`ICON_KINDS`); the icons are painted in software, so they work headless.
 *
 * Editor Worlds only. Lives in the overlay scene (`editorBatches.ts`): wireframes in `OVERLAY_GROUP.wires`,
 * icons in `OVERLAY_GROUP.icons`.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Vector3 as EngineVector3 } from "../../core/math";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { frustumSegments } from "../cameraGizmo";
import { Camera, Light, ParticleSystem } from "../components";
import type { EditorColors } from "../editorViewport";
import { b8, g8, LineBatch, OVERLAY_GROUP, overlayMaterial, r8, type View } from "./editorBatches";
import type { BabylonEditorContext } from "./editorContext";

/** The click radius around an icon, CSS pixels. */
const ICON_PICK_RADIUS = 16;

type Seg = [[number, number, number], [number, number, number]];

// --- Icons ---------------------------------------------------------------------------------------

type Sdf = (x: number, y: number) => number;

const circle = (cx: number, cy: number, r: number): Sdf => (x, y) => Math.hypot(x - cx, y - cy) - r;
const roundBox = (x0: number, y0: number, x1: number, y1: number, r: number): Sdf => {
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return (x, y) => {
    const dx = Math.abs(x - cx) - hx, dy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  };
};
/** Signed distance to a convex polygon (clockwise or counter-clockwise), exact outside its vertices. */
const polygon = (pts: [number, number][]): Sdf => (x, y) => {
  let inside = true, best = Infinity;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    const cross = ex * (y - ay) - ey * (x - ax);
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign && cross !== 0) inside = false;
  }
  return inside ? -best : best;
};
const segment = (ax: number, ay: number, bx: number, by: number, r: number): Sdf => (x, y) => {
  const ex = bx - ax, ey = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(x - ax - ex * t, y - ay - ey * t) - r;
};

const ICON_SIZE = 64;
const OUTLINE_RGB: [number, number, number] = [0x1b, 0x1d, 0x21];

/** An icon drawn in software (no 2D canvas, so it works headless): shapes with a dark outline, light fill. Row 0 is the top. */
function paintIcon(layers: { shape: Sdf; fill: [number, number, number]; stroke?: number; alpha?: number }[]): Uint8Array {
  const data = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  for (let py = 0; py < ICON_SIZE; py++) {
    for (let px = 0; px < ICON_SIZE; px++) {
      const x = px + 0.5, y = py + 0.5;
      let r = 0, g = 0, b = 0, a = 0;
      const over = (cr: number, cg: number, cb: number, ca: number): void => {
        const outA = ca + a * (1 - ca);
        if (outA <= 0) return;
        r = (cr * ca + r * a * (1 - ca)) / outA;
        g = (cg * ca + g * a * (1 - ca)) / outA;
        b = (cb * ca + b * a * (1 - ca)) / outA;
        a = outA;
      };
      for (const layer of layers) {
        const d = layer.shape(x, y), k = layer.alpha ?? 1;
        const stroke = (layer.stroke ?? 6) / 2;
        const sc = Math.min(1, Math.max(0, stroke + 0.5 - d)) * k;
        if (sc > 0) over(OUTLINE_RGB[0], OUTLINE_RGB[1], OUTLINE_RGB[2], sc);
        const fc = Math.min(1, Math.max(0, 0.5 - d)) * k;
        if (fc > 0) over(layer.fill[0], layer.fill[1], layer.fill[2], fc);
      }
      const o = (py * ICON_SIZE + px) * 4;
      data[o] = Math.round(r); data[o + 1] = Math.round(g); data[o + 2] = Math.round(b); data[o + 3] = Math.round(a * 255);
    }
  }
  return data;
}

const LIGHT_FILL: [number, number, number] = [0xff, 0xe0, 0x8a];
const CAMERA_FILL: [number, number, number] = [0xe8, 0xea, 0xed];

/** A camera glyph: a body and lens, like three.js's icon. */
function cameraIconPixels(): Uint8Array {
  return paintIcon([
    { shape: roundBox(6, 18, 42, 46, 5), fill: CAMERA_FILL },
    { shape: polygon([[42, 27], [58, 18], [58, 46], [42, 37]]), fill: CAMERA_FILL },
  ]);
}

/** A light's icon: a sun (directional), a bulb (point), a lamp shade (spot) or a soft disc (ambient). */
function lightIconPixels(type: string): Uint8Array {
  const layers: Parameters<typeof paintIcon>[0] = [];
  if (type === "directional") {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
      layers.push({ shape: segment(32 + c * 21, 32 + s * 21, 32 + c * 27, 32 + s * 27, 2), fill: LIGHT_FILL, stroke: 5 });
    }
    layers.push({ shape: circle(32, 32, 13), fill: LIGHT_FILL });
  } else if (type === "spot") {
    layers.push({ shape: polygon([[24, 10], [40, 10], [54, 46], [10, 46]]), fill: LIGHT_FILL });
    layers.push({ shape: circle(32, 52, 6), fill: LIGHT_FILL, stroke: 4 });
  } else if (type === "ambient") {
    layers.push({ shape: circle(32, 32, 22), fill: LIGHT_FILL, alpha: 0.9 });
    layers.push({ shape: segment(24, 41, 32, 22, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 }); // an "A"
    layers.push({ shape: segment(40, 41, 32, 22, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 });
    layers.push({ shape: segment(27, 35, 37, 35, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 });
  } else {
    layers.push({ shape: circle(32, 26, 17), fill: LIGHT_FILL });
    layers.push({ shape: roundBox(24, 42, 40, 54, 3), fill: LIGHT_FILL, stroke: 4 });
  }
  return paintIcon(layers);
}

const PARTICLE_FILL: [number, number, number] = [0xff, 0x9a, 0x5c];

/** A particle system's icon: a burst of dots of different sizes around a larger core. */
function particleIconPixels(): Uint8Array {
  const dots: [number, number, number][] = [[32, 34, 9], [18, 20, 5], [46, 18, 4], [50, 40, 5], [16, 46, 4], [33, 12, 3], [30, 54, 3]];
  return paintIcon(dots.map(([x, y, r]) => ({ shape: circle(x, y, r), fill: PARTICLE_FILL })));
}

// --- Light wireframes ------------------------------------------------------------------------

/**
 * A light's wireframe in world space, given to `emit` segment by segment: a directional light's arrow,
 * a spot light's cone, a point light's range (when selected). `m` is the node's world matrix, 16
 * numbers column by column starting at `offset`.
 */
export function emitLightSegments(
  l: Pick<Light, "type" | "range" | "spotAngle">,
  m: ArrayLike<number>,
  offset: number,
  selected: boolean,
  emit: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void,
): void {
  const o = offset;
  const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
  const unit = (i: number, sign: number): [number, number, number] => {
    const x = m[o + i], y = m[o + i + 1], z = m[o + i + 2];
    const n = Math.hypot(x, y, z) || 1;
    return [(x / n) * sign, (y / n) * sign, (z / n) * sign];
  };
  const [xx, xy, xz] = unit(0, 1), [yx, yy, yz] = unit(4, 1), [fx, fy, fz] = unit(8, 1);
  const ring = (cx: number, cy: number, cz: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, r: number, n = 32): void => {
    let qx = cx + ux * r, qy = cy + uy * r, qz = cz + uz * r;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
      const nx = cx + ux * c + vx * s, ny = cy + uy * c + vy * s, nz = cz + uz * c + vz * s;
      emit(qx, qy, qz, nx, ny, nz);
      qx = nx; qy = ny; qz = nz;
    }
  };
  const spokes: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (l.type === "directional") {
    // Four parallel rays around the node and an arrowhead on the middle one.
    const tx = px + fx * 2, ty = py + fy * 2, tz = pz + fz * 2;
    emit(px, py, pz, tx, ty, tz);
    for (const [dx, dy] of spokes) {
      const ox = px + xx * dx * 0.3 + yx * dy * 0.3, oy = py + xy * dx * 0.3 + yy * dy * 0.3, oz = pz + xz * dx * 0.3 + yz * dy * 0.3;
      emit(ox, oy, oz, ox + fx * 1.2, oy + fy * 1.2, oz + fz * 1.2);
      emit(tx, ty, tz, tx - fx * 0.3 + xx * dx * 0.12 + yx * dy * 0.12, ty - fy * 0.3 + xy * dx * 0.12 + yy * dy * 0.12, tz - fz * 0.3 + xz * dx * 0.12 + yz * dy * 0.12);
    }
  } else if (l.type === "spot") {
    const d = l.range > 0 ? l.range : 5;
    const r = d * Math.tan((Math.min(Math.max(l.spotAngle, 1), 179) / 2) * (Math.PI / 180));
    const bx = px + fx * d, by = py + fy * d, bz = pz + fz * d;
    for (const [dx, dy] of spokes) emit(px, py, pz, bx + xx * dx * r + yx * dy * r, by + xy * dx * r + yy * dy * r, bz + xz * dx * r + yz * dy * r);
    ring(bx, by, bz, xx, xy, xz, yx, yy, yz, r);
  } else if (l.type === "point" && selected && l.range > 0) {
    ring(px, py, pz, xx, xy, xz, yx, yy, yz, l.range);
    ring(px, py, pz, xx, xy, xz, fx, fy, fz, l.range);
    ring(px, py, pz, yx, yy, yz, fx, fy, fz, l.range);
  }
}

/** @see emitLightSegments: the wireframe as a list of segments (for tests and tools). `m` holds the world matrix column by column. */
export function lightSegments(l: Pick<Light, "type" | "range" | "spotAngle">, m: ArrayLike<number>, selected: boolean): Seg[] {
  const out: Seg[] = [];
  emitLightSegments(l, m, 0, selected, (ax, ay, az, bx, by, bz) => out.push([[ax, ay, az], [bx, by, bz]]));
  return out;
}
// --- Icon kinds --------------------------------------------------------------------------------

type IconComponent = Camera | Light | ParticleSystem;
type Emit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void;

/** One kind of component with an icon (and maybe a wireframe). */
interface IconKind<C extends IconComponent> {
  readonly type: abstract new () => C;
  /** The icon mesh's name. */
  readonly mesh: string;
  /** Icon size: a fraction of the view's height, as three.js's constant-size sprites. */
  readonly size: number;
  /** Which picture a component shows now (one material per look, made on first use). */
  look(c: C): string;
  /** A look's material name and its pixels. */
  materialName(look: string): string;
  pixels(look: string): Uint8Array;
  /** A wireframe: its batch's mesh name, whether its draws count as overlay objects drawn (`EditorDrawing.drawnObjects`), and one component's segments (world matrix `m` at `o`). */
  readonly wires?: {
    readonly mesh: string;
    readonly counted: boolean;
    emit(c: C, m: ArrayLike<number>, o: number, selected: boolean, aspect: number, emit: Emit): void;
  };
}

/**
 * Cameras inside the edited scene don't draw the editor's view: each shows an icon and a wireframe of
 * what it sees at the game's aspect ratio.
 */
const CAMERA_ICONS: IconKind<Camera> = {
  type: Camera,
  mesh: "myco.editor.cameraGizmo",
  size: 0.065,
  look: () => "",
  materialName: () => "myco.editor.cameraIcon",
  pixels: cameraIconPixels,
  wires: {
    mesh: "myco.editor.cameraWires",
    counted: false,
    emit(c, m, o, _selected, aspect, emit) {
      const local = frustumSegments({ projection: c.projection, orthographicSize: c.orthographicSize, fieldOfView: c.fieldOfView, aspect, near: c.near, far: c.far });
      for (let i = 0; i < local.length; i += 6) emit(...transformPoint(m, o, local[i], local[i + 1], local[i + 2]), ...transformPoint(m, o, local[i + 3], local[i + 4], local[i + 5]));
    },
  },
};

/** Lights show their type's icon and a wireframe: a directional light's direction, a spot light's cone, and (selected) a point light's range. */
const LIGHT_ICONS: IconKind<Light> = {
  type: Light,
  mesh: "myco.editor.lightGizmo",
  size: 0.055,
  look: (l) => l.type,
  materialName: (type) => `myco.editor.lightIcon.${type}`,
  pixels: lightIconPixels,
  wires: { mesh: "myco.editor.lightWires", counted: true, emit: (l, m, o, selected, _aspect, emit) => emitLightSegments(l, m, o, selected, emit) },
};

/** Particle systems have no mesh to click, so the icon is how they're picked. */
const PARTICLE_ICONS: IconKind<ParticleSystem> = {
  type: ParticleSystem,
  mesh: "myco.editor.particleGizmo",
  size: 0.055,
  look: () => "",
  materialName: () => "myco.editor.particleIcon",
  pixels: particleIconPixels,
};

/** Every kind, in picking order for icons equally near a click. */
const ICON_KINDS: readonly IconKind<IconComponent>[] = [CAMERA_ICONS, LIGHT_ICONS, PARTICLE_ICONS];

/** One kind's icons in this scene: each component's icon, the wireframe batch, and one material per look. */
interface IconSet {
  readonly kind: IconKind<IconComponent>;
  readonly icons: Map<IconComponent, Mesh>;
  wires: LineBatch | null;
  readonly materials: Map<string, { material: StandardMaterial; texture: RawTexture }>;
}

/** What the icons take from the selection outlines (`editorGuides.ts`). */
export interface IconStyle {
  /** The editor's colours: wireframes in `cameraGizmo`, or `outline` when selected. */
  readonly colors: EditorColors;
  /** True if the node or an ancestor is selected. */
  isOutlined(node: GameObject): boolean;
  /** Counts one overlay object drawn this frame. */
  readonly countDraw: () => void;
}

/** @internal The camera, light and particle system icons of one Babylon surface's edited scene. */
export class BabylonEditorIcons {
  private readonly utility: Scene;
  private readonly sets: IconSet[];
  private readonly lights: IconSet;
  private readonly seen = new Set<IconComponent>();

  constructor(
    private readonly ctx: BabylonEditorContext,
    private readonly style: IconStyle,
  ) {
    this.utility = ctx.overlay.utilityLayerScene;
    this.sets = ICON_KINDS.map((kind) => ({ kind, icons: new Map(), wires: null, materials: new Map() }));
    this.lights = this.sets.find((s) => s.kind === LIGHT_ICONS)!;
  }

  /** Each editor frame: an icon (and wireframe) per component in the edited scene, facing `view`; icons of removed components go. */
  sync(world: World, view: View | null): void {
    const aspect = this.ctx.settings.display.width / this.ctx.settings.display.height;
    for (const set of this.sets) this.syncSet(world, view, set, aspect);
  }

  private syncSet(world: World, view: View | null, set: IconSet, aspect: number): void {
    const { kind, icons } = set, seen = this.seen;
    seen.clear();
    const wireKind = kind.wires;
    const wires = wireKind ? (set.wires ??= new LineBatch(this.utility, wireKind.mesh, OVERLAY_GROUP.wires, true, wireKind.counted ? this.style.countDraw : undefined)) : null;
    wires?.begin();
    for (const c of world._componentsOfType(kind.type)) {
      if (!world.inEditMode(c.node.entity)) continue; // the editor's own camera has no icon
      seen.add(c);
      const material = this.material(set, kind.look(c));
      let icon = icons.get(c);
      if (!icon) icons.set(c, (icon = this.makeIcon(kind.mesh, material)));
      else if (icon.material !== material) icon.material = material;
      const visible = c.node.activeInHierarchy;
      icon.isVisible = visible;
      if (!visible) continue;
      const e = c.node.entity, m = world.worldMatrix(e), o = e * 16;
      placeIcon(icon, view, m[o + 12], m[o + 13], m[o + 14], kind.size);
      if (wires && wireKind) {
        const selected = this.style.isOutlined(c.node);
        const rgb = selected ? this.style.colors.outline : this.style.colors.cameraGizmo;
        const r = r8(rgb), g = g8(rgb), b = b8(rgb);
        wireKind.emit(c, m, o, selected, aspect, (ax, ay, az, bx, by, bz) => wires.line(ax, ay, az, bx, by, bz, r, g, b, 0.85));
      }
    }
    wires?.end();
    for (const [c, icon] of icons) {
      if (seen.has(c) && c.node.isValid) continue;
      icon.dispose(false, false);
      icons.delete(c);
    }
  }

  private material(set: IconSet, look: string): StandardMaterial {
    let made = set.materials.get(look);
    if (!made) {
      const name = set.kind.materialName(look);
      const texture = new RawTexture(set.kind.pixels(look), ICON_SIZE, ICON_SIZE, Constants.TEXTUREFORMAT_RGBA, this.utility, false, true, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
      texture.hasAlpha = true;
      texture.name = name;
      const material = overlayMaterial(this.utility, name);
      material.emissiveColor = Color3.White();
      material.emissiveTexture = texture;
      material.opacityTexture = texture;
      set.materials.set(look, (made = { material, texture }));
    }
    return made.material;
  }

  private makeIcon(name: string, material: StandardMaterial): Mesh {
    const icon = new Mesh(name, this.utility);
    icon.setVerticesData(VertexBuffer.PositionKind, [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], false, 3);
    icon.setVerticesData(VertexBuffer.UVKind, [0, 0, 1, 0, 1, 1, 0, 1], false, 2);
    icon.setIndices([0, 1, 2, 0, 2, 3], 4);
    icon.material = material;
    icon.renderingGroupId = OVERLAY_GROUP.icons;
    icon.isPickable = false;
    icon.alwaysSelectAsActiveMesh = true;
    icon.rotationQuaternion = new Quaternion();
    return icon;
  }

  /** Where each shown light icon is on the canvas (CSS pixels); icons behind the camera are left out. */
  lightIcons(): { node: GameObject; x: number; y: number }[] {
    const out: { node: GameObject; x: number; y: number }[] = [];
    this.onCanvas(this.lights, (node, x, y) => out.push({ node, x, y }));
    return out;
  }

  /** Icons within a click's reach of a canvas point (CSS pixels), nearest first. */
  iconsAt(x: number, y: number): GameObject[] {
    const hits: { node: GameObject; distance: number }[] = [];
    for (const set of this.sets) {
      this.onCanvas(set, (node, sx, sy) => {
        const distance = Math.hypot(sx - x, sy - y);
        if (distance <= ICON_PICK_RADIUS) hits.push({ node, distance });
      });
    }
    return hits.sort((a, b) => a.distance - b.distance).map((h) => h.node);
  }

  /** Each shown icon of a set in front of the view camera, at its canvas point. */
  private onCanvas(set: IconSet, visit: (node: GameObject, x: number, y: number) => void): void {
    const view = this.ctx.viewCameras()[0];
    if (!view) return;
    for (const [c, icon] of set.icons) {
      if (!icon.isVisible) continue;
      const p = icon.position;
      const s = view.worldToScreenPoint(new EngineVector3(p.x, p.y, p.z));
      if (s.z >= view.near && s.z <= view.far) visit(c.node, s.x, s.y);
    }
  }

  /** Light wireframe segments the last frame drew. */
  lightWireCount(): number {
    const wires = this.lights.wires;
    return wires?.visible ? wires.count / 2 : 0;
  }

  dispose(): void {
    for (const set of this.sets) {
      for (const icon of set.icons.values()) icon.dispose(false, false);
      set.wires?.dispose();
      for (const m of set.materials.values()) m.material.dispose(false, true);
      set.icons.clear();
      set.materials.clear();
      set.wires = null;
    }
  }
}

/** Face an icon to the view, a constant size on screen (`size`, a fraction of the view's height). */
function placeIcon(icon: Mesh, v: View | null, x: number, y: number, z: number, size: number): void {
  icon.position.set(x, y, z);
  if (!v) return;
  const s = v.ortho ? size * 2 * v.camera.orthographicSize : size * Math.max((x - v.px) * v.fx + (y - v.py) * v.fy + (z - v.pz) * v.fz, 1e-3);
  icon.scaling.set(s, s, 1);
  icon.rotationQuaternion!.copyFrom(v.q);
}

/** A point of the column-major matrix at `o`, applied to (x, y, z). */
function transformPoint(m: ArrayLike<number>, o: number, x: number, y: number, z: number): [number, number, number] {
  return [m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12], m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13], m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14]];
}
