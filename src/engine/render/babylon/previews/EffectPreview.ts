/**
 * @internal Editor: a live preview of a particle effect (ADR 0060) on the Babylon backend (ADR 0075 stage 7): a
 * preview stage of its own (ADR 0300: the engine, the default light rig, the orbit camera turned by dragging and zoomed
 * by the wheel, the loop), a ground grid, and one effect player (`effectPlayer.ts`, ADR 0153) at the origin, the same
 * player a World's ParticleSystems play through: CPU and kernel systems, their draws and fallbacks, delays, events and
 * restarts. Material assets and textures come from the preview scene's material library (ADR 0127).
 *
 * The engine starts asynchronously (WebGPU needs `initAsync`), so the constructor returns at once; a
 * program set before that is built when it's up.
 */
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder.js";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ParticleProgram } from "../../../scene/particleCompile";
import type { ParticleEffectPreviewApi, PreviewBackground } from "../../previewTypes";
import type { GraphShared } from "../graphMaterial";
import { EffectPlayer, EffectResources, libraryEffectHost } from "../effectPlayer";
import { previewMaterials } from "./common";
import type { BabylonMaterialLibrary } from "../materialLibrary";
import { PreviewStage } from "./previewStage";

export type { PreviewBackground } from "../../previewTypes";

const BACKGROUNDS: Record<PreviewBackground, { clear: string; grid: [string, string] | null }> = {
  dark: { clear: "#17191d", grid: null },
  light: { clear: "#c9cdd4", grid: null },
  grid: { clear: "#17191d", grid: ["#4a505a", "#2d3138"] },
};

/** A finished one-shot effect plays again after this many seconds (when looping is on). */
const REPEAT_GAP = 0.6;
/** Seconds between checks of what the effect draws with (a texture or model loading, a material appearing). */
const RETRY_INTERVAL = 0.25;

/** A GridHelper(20, 20): a line every unit over [-10, 10] on the ground, the two through the origin in `center`. */
function gridLines(scene: Scene, center: string, other: string): LinesMesh {
  const lines: Vector3[][] = [];
  const colors: Color4[][] = [];
  const c = Color4.FromColor3(Color3.FromHexString(center), 1);
  const o = Color4.FromColor3(Color3.FromHexString(other), 1);
  for (let i = 0; i <= 20; i++) {
    const v = i - 10;
    const color = i === 10 ? c : o;
    lines.push([new Vector3(-10, 0, v), new Vector3(10, 0, v)], [new Vector3(v, 0, -10), new Vector3(v, 0, 10)]);
    colors.push([color, color], [color, color]);
  }
  const grid = CreateLineSystem("preview.grid", { lines, colors }, scene);
  grid.isPickable = false;
  return grid;
}

export class ParticleEffectPreview implements ParticleEffectPreviewApi {
  readonly canvas: HTMLCanvasElement;
  /** Playback speed multiplier. */
  speed = 1;
  /** Force one-shot effects to repeat after a short gap. */
  looping = true;
  /** Called when the playing state changes (play, pause). */
  onChange: (() => void) | null = null;

  private readonly stage: PreviewStage;
  private grid: LinesMesh | null = null;
  /** The scene's materials and textures (ADR 0127). */
  private library: BabylonMaterialLibrary | null = null;
  private resources: EffectResources | null = null;
  private readonly shared: GraphShared = { time: 0, resolution: [1, 1] };

  private program: ParticleProgram | null = null;
  private player: EffectPlayer | null = null;
  private retry = 0;
  private _playing = true;
  private disposed = false;
  private _background: PreviewBackground = "grid";

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.stage = new PreviewStage(this.canvas, {
      name: "particle preview",
      host: container,
      // Around a point a unit up, from in front, a little to the right and above (ADR 0300's orbit).
      orbit: { fov: 40, near: 0.1, far: 200, target: [0, 1, 0], start: { yaw: Math.PI - 0.6, pitch: 0.4, distance: 6 }, minDistance: 0.5, maxDistance: 60 },
      onUp: (stage) => {
        // Lit by the stage's default rig (ADR 0277), for lit material assets (Babylon's particle systems and the unlit material ignore it).
        this.library = previewMaterials(stage.scene!, this.shared);
        this.resources = new EffectResources(libraryEffectHost(stage.scene!, this.library), (message) => console.warn(`[myco] preview: ${message}`));
        this.background = this._background;
        this.build();
      },
      frame: (dt) => {
        this.step(dt);
        this.stage.draw();
      },
    });
  }

  // --- public ----------------------------------------------------------------------------------------

  get playing(): boolean {
    return this._playing;
  }

  get background(): PreviewBackground {
    return this._background;
  }

  set background(value: PreviewBackground) {
    this._background = value;
    const scene = this.stage.scene;
    if (!scene) return; // applied when the scene is made
    const b = BACKGROUNDS[value];
    scene.clearColor = Color4.FromColor3(Color3.FromHexString(b.clear), 1); // sRGB, written as it is
    this.grid?.dispose();
    this.grid = b.grid ? gridLines(scene, b.grid[0], b.grid[1]) : null;
  }

  /** Particles alive and seconds played. */
  get stats(): { particles: number; time: number } {
    return { particles: this.player?.count ?? 0, time: this.player?.time ?? 0 };
  }

  /** Show a compiled effect graph (null clears). Rebuilds the emitters and plays from the start. */
  setProgram(program: ParticleProgram | null): void {
    this.program = program;
    this.clearEmitters();
    this.retry = 0;
    this.build();
  }

  /** Send a custom event (as `ParticleSystem.sendEvent`), starting and stopping the systems wired to it. */
  sendEvent(name: string): void {
    if (this.player?.built) this.player.event(name);
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this.onChange?.();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    this.onChange?.();
  }

  restart(): void {
    this.player?.restart();
    this._playing = true;
    this.onChange?.();
  }

  resize(w?: number, h?: number): void {
    this.stage.resize(w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEmitters();
    this.resources?.dispose();
    this.library?.dispose();
    this.stage.dispose(); // the grid, textures, particle systems and meshes go with its scene
  }

  // --- building --------------------------------------------------------------------------------------

  private clearEmitters(): void {
    this.player?.dispose();
    this.player = null;
  }

  /** Make the effect's player once the scene is up, and build it (again when what it draws with has changed). */
  private build(): void {
    if (!this.resources || !this.program) return;
    this.player ??= new EffectPlayer(this.resources, this.program, { name: "particles:preview" });
    this.player.build();
    this.retry = RETRY_INTERVAL;
  }

  // --- frame -----------------------------------------------------------------------------------------

  private step(realDt: number): void {
    this.retry -= realDt;
    if (this.retry <= 0) this.build(); // a texture or model finished loading, a material appeared
    const player = this.player;
    if (!player?.built) return;
    const dt = this._playing ? realDt * Math.max(0, this.speed) : 0;
    player.step(dt);
    this.shared.time += realDt; // graph materials' Time node
    player.repeatWhenFinished(dt, REPEAT_GAP, this._playing && this.looping);
  }
}
