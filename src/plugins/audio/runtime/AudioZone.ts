/**
 * An audio zone (ADR 0347): an area that plays a sound — rain over a field, a river, wind on a ridge — without scripting.
 * The zone is an upright box: `center` (an offset from the node, local units), `width` (local x) by `depth` (local z),
 * turned by `yaw` degrees about the vertical on top of the node's own turn (positive turns right, clockwise seen from
 * above, ADR 0164), from `bottom` to `top` (heights above the centre). The node's world scale scales it.
 *
 * - `heard: "edge"`: outside the box the sound plays from the box's nearest point, so walls between that point and the
 *   listener muffle it (occlusion) and the playlist's attenuation curves apply to that distance; its spread narrows with
 *   distance as `min(180°, 40° + 600°/max(3 m, d))`. Inside, it surrounds the listener: spread all round, in its bus's
 *   ambisonic bed.
 * - `heard: "inside"`: it plays around the listener, spread all round in its bus's ambisonic bed (equal-power where the
 *   bus has none), at full level inside and falling linearly to silence over `feather` metres outside. A playlist
 *   without a spatial block is positioned for it all the same, with no distance loss.
 *
 * A playlist the zone plays has the built-in local parameter `zoneDepth`: 0 at the edge (and outside), 1 at the centre,
 * set each frame, so a playlist can bind a layer or a filter to how deep the listener is. `volume` (dB) sets its level.
 * Give an edge zone's playlist a `spatial` block (it plays flat otherwise). A zone plays while it is enabled, in the World
 * that has the view; a playlist that ends by itself (a oneShot) is not restarted.
 */
import { Component } from "../../../engine/core/Component";
import { Vector3, type Vec3Like } from "../../../engine/core/math";
import { AssetRef, component, field } from "../../../engine/core/registry";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import { Camera } from "../../../engine/render/components";
import { isPlaylistPath } from "../../../engine/audio/playlist/format";
import { dbToGain } from "../../../engine/audio/decibels";
import { AudioListener, listenerPose } from "./AudioListener";
import { worldKeyOf, worldPlays } from "./AudioSource";
import type { AudioVoice } from "./backend";
import { clipRequest, clipVolume } from "./clipResolver";
import { playSampleVoice } from "./sampleVoice";
import { audioZoneEdgeSpread, DEFAULT_ROLLOFF_ATTENUATION, UprightBox } from "./core/spatial";
import { warnOnce } from "./core/handle";
import { playlists } from "./playlists/playlistSystem";
import type { PlaylistInstance } from "./playlists/instance";

/** How a zone is heard (ADR 0347). */
export const AUDIO_ZONE_HEARD = ["edge", "inside"] as const;
export type AudioZoneHeard = (typeof AUDIO_ZONE_HEARD)[number];


/** The loudest a zone's `volume` plays, in dB. */
const MAX_ZONE_DB = 24;

@component("engine.AudioZone")
export class AudioZone extends Component {
  @field(AssetRef, { kind: ["playlist", "audio"], description: "The sound the zone plays: a playlist (`*.playlist.json`) or a sample, looping." }) sound = "";
  @field(String, { choices: AUDIO_ZONE_HEARD, description: "edge: heard from the zone's nearest point outside it and all around inside; inside: heard only inside, fading out over the feather." }) heard: AudioZoneHeard = "edge";
  @field(Number, { description: "Inside zones: the distance outside the box over which the sound fades to silence, metres." }) feather = 5;
  @field(Number, { description: "Level, dB (0 = as authored)." }) volume = 0;
  @field(Vector3, { description: "Offset of the box from the node, local units." }) center = new Vector3(0, 0, 0);
  @field(Number, { description: "The box's size along its local x, local units." }) width = 10;
  @field(Number, { description: "The box's size along its local z, local units." }) depth = 10;
  @field(Number, { description: "Turns the box about the vertical, degrees, positive to the right (clockwise seen from above), on top of the node's turn." }) yaw = 0;
  @field(Number, { description: "The box's bottom, height above its centre, local units." }) bottom = 0;
  @field(Number, { description: "The box's top, height above its centre, local units (above bottom)." }) top = 10;

  private instance: PlaylistInstance | null = null;
  private voice: AudioVoice | null = null;
  private playing = "";
  /** How the playing sound was started (an inside zone's playlist is positioned even without a spatial block). */
  private playingHeard: AudioZoneHeard = "edge";
  /** The spread and bed the sample voice was last given (a playlist instance takes them each frame). */
  private appliedSpread = NaN;
  private appliedBed = false;
  private readonly box = new UprightBox();
  private readonly near = { x: 0, y: 0, z: 0 };
  private appliedGain = NaN;
  private readonly pos = { x: 0, y: 0, z: 0 };

  /** @internal The zone's box in world space (one object, refreshed by each call): the zone system and the editor gizmo. */
  _worldBox(): UprightBox {
    const t = this.node.transform;
    const p = t?.worldPosition ?? { x: 0, y: 0, z: 0 };
    const s = t?.worldScale ?? { x: 1, y: 1, z: 1 };
    let nodeYaw = 0;
    if (t) {
      const f = listenerPose(this.node).forward;
      nodeYaw = (Math.atan2(f.x, f.z) * 180) / Math.PI;
    }
    const r = (nodeYaw * Math.PI) / 180;
    const ox = this.center.x * s.x, oz = this.center.z * s.z;
    const cx = p.x + ox * Math.cos(r) + oz * Math.sin(r);
    const cz = p.z - ox * Math.sin(r) + oz * Math.cos(r);
    const cy = p.y + this.center.y * s.y;
    const sy = Math.abs(s.y) || 1;
    return this.box.set(cx, cz, Math.abs(this.width * s.x), Math.abs(this.depth * s.z), nodeYaw + this.yaw, cy + this.bottom * sy, cy + Math.max(this.bottom, this.top) * sy);
  }

  /** Whether the zone's sound is playing. */
  get isPlaying(): boolean {
    return this.instance ? this.instance.playing : this.voice !== null && this.voice.playing;
  }

  private spreadNow = 360;
  private distanceNow = 0;

  /**
   * The spread the zone's sound has now, degrees (ADR 0347): `min(180, 40 + 600/max(3, d))` for an edge zone heard
   * from outside, 360 around the listener (inside an edge zone, and for an inside zone). Its voices play with it.
   */
  get spread(): number { return this.spreadNow; }

  /** Distance from the listener to the box, metres (0 inside), as of the last frame. */
  get distance(): number { return this.distanceNow; }

  /** @internal The AudioZone system, each frame: start, place and level the zone's sound for the listener at `listener`. */
  _sync(listener: Vec3Like | null): void {
    const path = this.sound.replace(/^asset:/, "");
    if (path !== this.playing || (this.heard !== this.playingHeard && path !== "")) this.restart(path);
    if (!this.instance && !this.voice) return;
    const box = this._worldBox();
    const l = listener ?? { x: box.cx, y: (box.bottom + box.top) / 2, z: box.cz };
    const d = box.nearest(l.x, l.y, l.z, this.near);
    const inside = d < 0.01;
    this.distanceNow = inside ? 0 : d;
    let level = Number.isFinite(this.volume) ? dbToGain(Math.min(MAX_ZONE_DB, this.volume)) : 1;
    let bed = false;
    if (this.heard === "edge" && !inside) {
      // Outside an edge zone: a source at the nearest point.
      this.place(this.near);
      this.spreadNow = audioZoneEdgeSpread(d);
    } else {
      // Around the listener (inside an edge zone; an inside zone, whose level fades over the feather outside): placed
      // at the listener, spread all round, in its bus's ambisonic bed (ADR 0347; the core's panner pick takes it there).
      this.place(l);
      this.spreadNow = 360;
      bed = true;
      if (this.heard === "inside" && !inside) level *= Math.max(0, 1 - d / Math.max(0.5, this.feather));
    }
    this.setSpatial(this.spreadNow, bed);
    this.setLevel(level);
    this.instance?.setZoneDepth(inside ? box.depth(l.x, l.z) : 0);
  }

  private place(p: Vec3Like): void {
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    if (this.instance) this.instance.position = this.pos;
    else this.voice?.setPosition(this.pos);
  }

  /** ADR 0347: the sound's spread (degrees) and whether it is heard in its bus's bed. */
  private setSpatial(spread: number, bed: boolean): void {
    if (this.instance) {
      this.instance.setZoneSpatial(spread, bed);
      return;
    }
    if (!this.voice || (Math.abs(spread - this.appliedSpread) <= 0.5 && bed === this.appliedBed)) return;
    this.appliedSpread = spread;
    this.appliedBed = bed;
    this.voice.setSpatialOptions({ spread, bed });
  }

  private setLevel(gain: number): void {
    if (Math.abs(gain - this.appliedGain) <= 1e-5) return;
    this.appliedGain = gain;
    if (this.instance) this.instance.fade(Math.min(4, gain), 0);
    else if (this.voice) this.voice.setVolume(gain * clipVolume(this.playing));
  }

  private restart(path: string): void {
    this.stopSound();
    this.playing = path;
    this.playingHeard = this.heard;
    if (!path || !worldPlays(this._world)) return;
    const box = this._worldBox();
    const at = { x: box.cx, y: (box.bottom + box.top) / 2, z: box.cz };
    if (isPlaylistPath(path)) {
      // Placed and levelled in the same frame (`_sync` goes on after this), before the frame's commands go out.
      this.instance = playlists().play(path, { position: at, owner: this.node.name, trigger: "AudioZone", triggerNode: this.owner, zone: true, zoneInside: this.heard === "inside" }, worldKeyOf(this._world));
      return;
    }
    try {
      const req = clipRequest(path, true, "");
      req.volume = 0; // silent until the first frame levels it
      req.world = worldKeyOf(this._world);
      req.owner = this.node.name;
      req.attenuation = DEFAULT_ROLLOFF_ATTENUATION; // a sample has no attenuation of its own
      req.position = at;
      // ADR 0342: the sample's trimmed start, normalisation gain and loop region (endless: a zone has no release).
      this.voice = playSampleVoice(path, req);
    } catch (e) {
      warnOnce(`zone:sample:${path}`, `[myco] AudioZone "${this.node.name}": the sample "${path}" can't play (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  private stopSound(): void {
    this.instance?.stop();
    this.instance = null;
    this.voice?.stop(0.12);
    this.voice = null;
    this.playing = "";
    this.appliedGain = NaN;
    this.appliedSpread = NaN;
    this.appliedBed = false;
  }

  override _onActivate(): void {
    this.playing = "\u0000"; // the next frame starts the sound
  }

  override _onDeactivate(): void {
    this.stopSound();
  }

  override _onDetach(): void {
    this.stopSound();
  }
}

/** The listener's position in `world` (an enabled `AudioListener`, else the main camera), or null. */
function listenerIn(world: World): Vec3Like | null {
  for (const l of world._componentsOfType(AudioListener)) if (l.isActiveAndEnabled) return listenerPose(l.node).position;
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
  return best ? listenerPose(best.node).position : null;
}

/** @internal ADR 0347: places and levels every enabled zone in the World that plays, before the audio frame. */
export const AUDIO_ZONE_SYSTEM: BuiltinSystem = {
  name: "engine.AudioZones",
  phase: "lateUpdate",
  before: ["engine.Audio"],
  run(world: World): void {
    const zones = world._componentsOfType(AudioZone);
    if (zones.length === 0 || !worldPlays(world)) return;
    const listener = listenerIn(world);
    for (const z of zones) if (z.isActiveAndEnabled) z._sync(listener);
  },
};
