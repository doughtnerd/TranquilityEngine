/**
 * The spatial test scene player (ADR 0347): builds a test scene (`*.audioscene.json`, parsed by the engine's
 * `parseAudioTestScene`) in a World out of the engine's own components, so what it plays is what a game plays.
 *
 * - **Listeners** are nodes with an `AudioListener`; only the active one is enabled (the first enabled listener hears).
 * - **Emitters** are nodes with an `AudioSource` (looping, playing on awake; a sample plays positioned, a playlist by its
 *   own `spatial` block). Moving emitters travel their route by arc length at their speed, at their height, each frame
 *   (`routeTravel.ts`); the runtime's Doppler pass estimates their velocity from that motion, as it does a game's. A
 *   looping route travels a short closing gap (its velocity carries across the wrap) and jumps a long one (the Doppler
 *   pass's teleport guard zeroes the velocity for its frames).
 * - **Obstacles** are nodes with a `BoxCollider` (the 3D physics plugin's, found by its type id so the audio plugin never
 *   imports it) on the first `audio.occlusion.layers` layer, and an `AudioOccluder` with the obstacle's material. The
 *   occlusion pass casts its rays at them when the World runs 3D physics (a scene with `settings.physics: "3d"`);
 *   without the physics plugin or a 3D World they stay data (no collider), and occlusion is open, as in a game.
 * - **Reverb zones** are `AudioReverbZone` boxes (wet in dB as the zone's linear wet), **audio zones** `AudioZone`s and
 *   **2D sounds** flat `AudioSource`s on their output bus.
 * - A **base** game scene the caller loaded into the World first (`loadBaseScene`, `baseScene.ts`) keeps its components; `replace` swaps the sound of each
 *   named component (`"Node/Path/AudioSource"`, `"…/AudioZone"`, `[i]` for the i-th of a type) while the player plays and
 *   puts it back on `dispose`, so the scene file never changes.
 *
 * Every node the player makes is under one root node named after the scene, each named by its object id (the debug rows'
 * Source column). The handle moves objects live (`moveObject`), switches the listener, reads back how each sound is
 * heard (`voices`) from the runtime's own debug rows and the components' public readouts, and where each emitter is now
 * (`motion`).
 */
import type { World } from "../../../../engine/core/World";
import { GameBehavior, type Component } from "../../../../engine/core/Component";
import { getComponentClass } from "../../../../engine/core/registry";
import { GameObject } from "../../../../engine/scene/GameObject";
import { dbToGain } from "../../../../engine/audio/decibels";
import { mixer } from "../../../../engine/audio/mixer";
import { advanceRoute, closeDistance, travelAt, travelPose, travelSpeed, type RouteTravel } from "../../../../engine/audio/spatial/routeTravel";
import type { AudioTestScene, MovingEmitter, SceneBox, TestEmitter, Vec3 } from "../../../../engine/audio/spatial/testSceneTypes";
import { Audio } from "../Audio";
import { AudioListener } from "../AudioListener";
import { AudioOccluder } from "../AudioOccluder";
import { AudioReverbZone } from "../AudioReverbZone";
import { AudioSource } from "../AudioSource";
import { AudioZone } from "../AudioZone";
import type { AudioPanner } from "../backend";

/** A live edit of one object: what changes (absent keys stay). */
export interface TestScenePose {
  /** Listeners and static emitters. */
  position?: Vec3;
  /** Listeners: degrees, 0 faces +z. */
  yaw?: number;
  /** Obstacles, reverb zones and audio zones. */
  box?: SceneBox;
  /** Moving emitters: a new route, path height or place along it (0..1). */
  route?: Vec3[];
  height?: number;
  at?: number;
}

/** How a sound is heard (the Voices table's Rendered column). */
export type TestSceneRendering = "hrtf" | "panned" | "bed" | "ambisonic" | "2d";

/** One row of the readout: one emitter, audio zone or 2D sound of the scene. */
export interface TestSceneVoiceRow {
  readonly id: string;
  readonly kind: "emitter" | "zone" | "sound2d";
  /** Whether its sound is playing. */
  readonly playing: boolean;
  /** How it is rendered, from its voices (null while none plays). */
  readonly rendered: TestSceneRendering | null;
  /** Metres from the active listener (to the box for a zone; null for a 2D sound). */
  readonly distance: number | null;
  /** The smoothed dry occlusion gain (1 open) and, when the debug rows have it, the cutoff and the material hit. */
  readonly occlusion: { gain: number; cutoffHz: number | null; material: string | null } | null;
  /** The Doppler factor folded into its pitch (1 none), and the same in cents; null when the backend doesn't say. */
  readonly doppler: number | null;
  readonly dopplerCents: number | null;
}

/** Where an emitter is now, as the World moves it (the Spatial view draws moving emitters from this while playing). */
export interface TestSceneMotionRow {
  readonly id: string;
  /** World position now. */
  readonly position: Vec3;
  /** Moving emitters: the unit direction it travels (null for a static emitter). */
  readonly direction: Vec3 | null;
  /** The speed it travels at now, m/s: its route speed, 0 once a route that doesn't loop has arrived (0 for a static emitter). */
  readonly speed: number;
}

export interface AudioTestScenePlayer {
  /** The node every object of the scene is under. */
  readonly root: GameObject;
  /** Hear the scene from listener `id`; false when there is none. */
  setActiveListener(id: string): boolean;
  /** Move or reshape object `id` now; false when there is none or the pose doesn't apply to it. */
  moveObject(id: string, pose: TestScenePose): boolean;
  /** How each emitter, audio zone and 2D sound is heard now. */
  voices(): TestSceneVoiceRow[];
  /** Where each emitter is now and how it travels (cheap: read each animation frame). */
  motion(): TestSceneMotionRow[];
  /** Remove every node the player made and put the base scene's replaced sounds back. */
  dispose(): void;
}


/**
 * Moves a node along a moving emitter's route each frame (`routeTravel.ts`: by arc length at its speed; a looping route
 * travels a short closing gap so its velocity carries, and jumps a long one, which the Doppler pass's teleport guard
 * zeroes). The runtime's Doppler pass estimates the velocity from that motion, smoothed, as it does a game's.
 */
class RouteMover extends GameBehavior {
  emitter: MovingEmitter | null = null;
  travel: RouteTravel = travelAt(0);
  readonly pose = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };

  place(): void {
    const e = this.emitter;
    if (!e || !this.node.transform) return;
    travelPose(e.route, e.height, e.loop, this.travel, this.pose);
    const p = this.pose.position;
    this.node.transform.position.set(p.x, p.y, p.z);
  }

  update(): void {
    const e = this.emitter;
    if (!e) return;
    const dt = this._world.time.deltaTime;
    advanceRoute(e.route, e.speed, e.loop, this.travel, dt, closeDistance(mixer.audioSettings.doppler.maxSpeed, dt));
    this.place();
  }
}

/** Sets a node's world pose for a box: at the box's ground centre, turned by its yaw. */
function placeBox(node: GameObject, box: SceneBox): void {
  node.transform!.position.set(box.center.x, 0, box.center.z);
  node.transform!.eulerAngles = [0, (box.yaw * Math.PI) / 180, 0];
}

const PANNERS: Readonly<Record<AudioPanner, TestSceneRendering>> = { hrtf: "hrtf", equalPower: "panned", bed: "bed", ambisonic: "ambisonic", flat: "2d" };

/**
 * A base scene's own sound to read in `voices()` (decision log D43): the row's id, and where its component is, as a
 * `replace` key names it (`"Cave/Campfire/AudioSource"`, `[i]` for the i-th of its type on the node).
 */
export interface BaseSoundRef {
  readonly id: string;
  readonly path: string;
}

export interface PlayAudioTestSceneOptions {
  /** The loaded base scene's emitters and audio zones, read into `voices()` beside the scene's own (after them). */
  readonly base?: readonly BaseSoundRef[];
}

/**
 * Builds `scene` in `world` and plays it. The World plays sound only while it has the view, as any World; the caller
 * steps it. A base scene, when the test scene names one, is the caller's to load first (its `replace` entries apply to
 * what is loaded); `options.base` names its sounds for the Voices readout.
 */
export function playAudioTestScene(world: World, scene: AudioTestScene, options: PlayAudioTestSceneOptions = {}): AudioTestScenePlayer {
  const root = GameObject.create(`Audio test scene${scene.folder ? ` (${scene.folder})` : ""}`, { parent: world.activeScene ?? world.root });
  const listeners = new Map<string, AudioListener>();
  const emitters = new Map<string, { emitter: TestEmitter; source: AudioSource; mover: RouteMover | null }>();
  const boxes = new Map<string, { node: GameObject; apply: (box: SceneBox) => void }>();
  const zones = new Map<string, AudioZone>();
  const sounds2d = new Map<string, AudioSource>();
  const node = (id: string) => GameObject.create(id, { parent: root });

  for (const l of scene.listeners) {
    const n = node(l.id);
    n.transform!.position.set(l.position.x, l.position.y, l.position.z);
    n.transform!.eulerAngles = [0, (l.yaw * Math.PI) / 180, 0];
    const c = n.addBehavior(AudioListener);
    c.enabled = l.id === scene.activeListener;
    listeners.set(l.id, c);
  }

  // Obstacles: colliders on the occlusion layer, when the physics plugin registered its BoxCollider.
  const BoxCollider = getComponentClass("engine.BoxCollider") as (new () => Component) | undefined;
  const layers = mixer.audioSettings.occlusion.layers;
  const occlusionLayer = Array.isArray(layers) && layers.length > 0 ? layers[0]! : null;
  for (const o of scene.obstacles) {
    const n = node(o.id);
    n.addBehavior(AudioOccluder, { material: o.material });
    // TODO(ADR 0347): without the 3D physics plugin there is no collider to cast at; the obstacle stays data.
    const collider = BoxCollider ? (n.addBehavior(BoxCollider as never) as unknown as { size: { set(x: number, y: number, z: number): void }; center: { set(x: number, y: number, z: number): void }; layer: string }) : null;
    if (collider && occlusionLayer) collider.layer = occlusionLayer;
    const apply = (box: SceneBox) => {
      placeBox(n, box);
      collider?.size.set(box.width, box.top - box.bottom, box.depth);
      collider?.center.set(0, (box.bottom + box.top) / 2, 0);
    };
    apply(o.box);
    boxes.set(o.id, { node: n, apply });
  }

  for (const z of scene.reverbZones) {
    const n = node(z.id);
    const c = n.addBehavior(AudioReverbZone, { shape: "box", preset: z.preset, wet: Math.min(2, dbToGain(z.wet)), priority: z.priority, levelDefault: z.levelDefault });
    const apply = (box: SceneBox) => {
      placeBox(n, box);
      c.size.set(box.width, box.top - box.bottom, box.depth);
      c.center.set(0, (box.bottom + box.top) / 2, 0);
    };
    apply(z.box);
    boxes.set(z.id, { node: n, apply });
  }

  for (const z of scene.audioZones) {
    const n = node(z.id);
    const c = n.addBehavior(AudioZone, { sound: z.sound, heard: z.heard, feather: z.feather, volume: z.volume });
    const apply = (box: SceneBox) => {
      n.transform!.position.set(box.center.x, 0, box.center.z);
      Object.assign(c, { width: box.width, depth: box.depth, yaw: box.yaw, bottom: box.bottom, top: box.top });
    };
    apply(z.box);
    boxes.set(z.id, { node: n, apply });
    zones.set(z.id, c);
  }

  for (const e of scene.emitters) {
    const n = node(e.id);
    let mover: RouteMover | null = null;
    if (e.kind === "static") n.transform!.position.set(e.position.x, e.position.y, e.position.z);
    else {
      mover = n.addBehavior(RouteMover);
      mover.emitter = e;
      mover.travel = travelAt(e.start);
      mover.place();
    }
    const source = n.addBehavior(AudioSource, { clip: e.sound, loop: true, spatial: true, volume: dbToGain(e.volume), output: e.output ?? "", playOnAwake: e.sound !== "" });
    emitters.set(e.id, { emitter: e, source, mover });
  }

  for (const s of scene.sounds2d) {
    const n = node(s.id);
    sounds2d.set(s.id, n.addBehavior(AudioSource, { clip: s.sound, loop: true, spatial: false, volume: dbToGain(s.volume), output: s.output, playOnAwake: s.sound !== "" }));
  }

  // A/B replacement in the base scene: remember each original, put it back on dispose.
  const restore: (() => void)[] = [];
  for (const [path, sound] of Object.entries(scene.replace)) {
    const target = componentAt(world, path);
    if (!target) { console.warn(`[myco] audio test scene: replace names "${path}", which isn't in the base scene; ignored.`); continue; }
    if (target instanceof AudioSource) {
      const before = target.clip;
      target.clip = sound;
      if (target.isPlaying) target.play();
      restore.push(() => { target.clip = before; if (target.isPlaying) target.play(); });
    } else if (target instanceof AudioZone) {
      const before = target.sound;
      target.sound = sound;
      restore.push(() => { target.sound = before; });
    }
  }

  // The base scene's own sounds (they play as the game's do; the readout reads them as it reads the scene's).
  const baseSounds: { id: string; component: AudioSource | AudioZone }[] = [];
  for (const ref of options.base ?? []) {
    const component = componentAt(world, ref.path);
    if (component) baseSounds.push({ id: ref.id, component });
  }

  let active = scene.activeListener;
  const activePosition = (): Vec3 | null => {
    const l = listeners.get(active);
    return l?.node.transform ? l.node.transform.worldPosition : null;
  };

  const handle: AudioTestScenePlayer = {
    root,
    setActiveListener(id) {
      if (!listeners.has(id)) return false;
      active = id;
      for (const [lid, l] of listeners) l.enabled = lid === id;
      return true;
    },
    moveObject(id, pose) {
      const l = listeners.get(id);
      if (l) {
        if (pose.position) l.node.transform!.position.set(pose.position.x, pose.position.y, pose.position.z);
        if (pose.yaw !== undefined) l.node.transform!.eulerAngles = [0, (pose.yaw * Math.PI) / 180, 0];
        return pose.position !== undefined || pose.yaw !== undefined;
      }
      const e = emitters.get(id);
      if (e) {
        if (e.mover && e.emitter.kind === "moving") {
          const m = e.emitter;
          e.mover.emitter = { ...m, route: pose.route && pose.route.length >= 2 ? pose.route.map((p) => ({ x: p.x, y: 0, z: p.z })) : m.route, height: pose.height ?? m.height };
          e.emitter = e.mover.emitter;
          if (pose.at !== undefined) e.mover.travel = travelAt(pose.at);
          e.mover.place();
          return pose.route !== undefined || pose.height !== undefined || pose.at !== undefined;
        }
        if (!pose.position) return false;
        e.source.node.transform!.position.set(pose.position.x, pose.position.y, pose.position.z);
        return true;
      }
      const b = boxes.get(id);
      if (b && pose.box) {
        b.apply(pose.box);
        return true;
      }
      return false;
    },
    voices() {
      const rows = Audio.debug().voices;
      const lp = activePosition();
      const out: TestSceneVoiceRow[] = [];
      const read = (id: string, kind: TestSceneVoiceRow["kind"], playing: boolean, distance: number | null, panner: AudioPanner | null, occlusionGain: number | null, owner = id): void => {
        // A voice's owner is its node's name: the scene's nodes are named by id, a base scene's by the game's names.
        const mine = rows.filter((r) => r.owner === owner);
        const row = mine.find((r) => r.state === "playing") ?? mine[0];
        const p = row?.panner ?? panner;
        const doppler = row?.doppler ?? null;
        const occ = row?.occlusion ? { gain: row.occlusion.gain, cutoffHz: row.occlusion.cutoffHz, material: row.occlusion.material || null } : occlusionGain !== null ? { gain: occlusionGain, cutoffHz: null, material: null } : null;
        out.push({
          id, kind, playing, distance,
          rendered: playing && p ? PANNERS[p] ?? null : null,
          occlusion: kind === "sound2d" ? null : occ,
          doppler,
          dopplerCents: doppler !== null && doppler > 0 ? 1200 * Math.log2(doppler) : null,
        });
      };
      for (const [id, e] of emitters) {
        const pos = e.source.node.transform!.worldPosition;
        const d = lp ? Math.hypot(pos.x - lp.x, pos.y - lp.y, pos.z - lp.z) : null;
        read(id, "emitter", e.source.isPlaying, d, e.source.panner, e.source.isPlaying ? e.source.occlusionGain : null);
      }
      for (const [id, z] of zones) read(id, "zone", z.isPlaying, lp ? z.distance : null, null, null);
      for (const [id, s] of sounds2d) read(id, "sound2d", s.isPlaying, null, s.panner, null);
      for (const { id, component: c } of baseSounds) {
        if (!c.node.isValid) continue;
        if (c instanceof AudioZone) {
          read(id, "zone", c.isPlaying, lp ? c.distance : null, null, null, c.node.name);
          continue;
        }
        const pos = c.node.transform?.worldPosition;
        if (!c.spatial) read(id, "sound2d", c.isPlaying, null, c.panner, null, c.node.name);
        else read(id, "emitter", c.isPlaying, lp && pos ? Math.hypot(pos.x - lp.x, pos.y - lp.y, pos.z - lp.z) : null, c.panner, c.isPlaying ? c.occlusionGain : null, c.node.name);
      }
      return out;
    },
    motion() {
      const out: TestSceneMotionRow[] = [];
      for (const [id, e] of emitters) {
        const p = e.source.node.transform!.worldPosition;
        const m = e.mover;
        const em = m?.emitter;
        out.push({
          id,
          position: { x: p.x, y: p.y, z: p.z },
          direction: m ? { ...m.pose.direction } : null,
          speed: m && em ? travelSpeed(em.route, em.speed, em.loop, m.travel) : 0,
        });
      }
      return out;
    },
    dispose() {
      for (const r of restore.splice(0)) r();
      for (const s of [...emitters.values()].map((e) => e.source).concat([...sounds2d.values()])) s.stop();
      GameObject.destroy(root);
    },
  };
  return handle;
}

/** The component a `replace` key names: a node path from the World's scene, then the component's short name (`AudioSource`, `AudioZone`), `[i]` for the i-th. */
function componentAt(world: World, path: string): AudioSource | AudioZone | null {
  const parts = path.split("/").filter(Boolean);
  const last = parts.pop();
  if (!last) return null;
  const m = /^(AudioSource|AudioZone)(?:\[(\d+)\])?$/.exec(last);
  if (!m) return null;
  const scene = world.activeScene ?? world.root;
  const target = parts.length === 0 ? scene : scene.find(parts.join("/"));
  if (!target) return null;
  const list: (AudioSource | AudioZone)[] = m[1] === "AudioZone" ? target.getBehaviors(AudioZone) : target.getBehaviors(AudioSource);
  return list[Number(m[2] ?? 0)] ?? null;
}
