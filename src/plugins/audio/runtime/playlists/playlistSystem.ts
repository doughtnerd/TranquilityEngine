/**
 * The playlist runtime (ADR 0343): plays `*.playlist.json` assets, and samples as one-sample Clip playlists, as instances
 * of ordinary voices. Hosted by `host.ts` (`PlaylistHost`), whose automation sink, curve table, global parameters,
 * instance groups, per-World generators and frame it uses. An audio event (`*.audioevent.json`, the format the playlists
 * replaced) is refused with a message naming the migration.
 *
 * A trigger runs the gate (cooldown, chance, max instances with steals; `engine/audio/playlist/gate.ts`), then resolves
 * the tree (`nodes.ts`). Refused triggers are counted with their reason and the latest are kept for `Audio.debug()`.
 */
import { World } from "../../../../engine/core/World";
import { mixer } from "../../../../engine/audio/mixer";
import { gateTrigger, STEAL_FADE_SECONDS, type GateCandidate } from "../../../../engine/audio/playlist/gate";
import { newPickState, type PickState } from "../../../../engine/audio/playlist/picks";
import { isLabelled, type ParameterDef } from "../../../../engine/audio/parameters";
import { Camera } from "../../../../engine/render/components";
import type { Vec3Like } from "../../../../engine/core/math";
import { AudioListener, listenerPose } from "../AudioListener";
import { audioEventRefusal, isAudioEventPath } from "../../../../engine/audio/retiredAudioEvent";
import { isPlaylistPath } from "../../../../engine/audio/playlist/format";
import { isGeneratorPath } from "../../../../engine/audio/generators/format";
import { playlistHost, type HostedRuntime } from "./host";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { playCause } from "./cause";
import { generatorPlaylist, loadPlaylist, samplePlaylist } from "./loader";
import { PlaylistInstance, type InstanceSystem, type PlaylistOptions, type StingerOutcome } from "./instance";
import { musicRowOf } from "./musicRows";
import type { PlaylistAsset } from "../../../../engine/audio/playlist/types";
import { watchCaption } from "../localisation/captions";
import type { MusicDebugRow } from "../debugTypes";

/** A row of `Audio.debug().events`: one playlist instance (`asset` is the playlist's path) and its late-start count. */
export interface EventDebugRow {
  id: number;
  asset: string;
  world: number;
  voices: number;
  parameters: Record<string, number | string>;
  /** Entries of a continuous Queue this instance started on the previous one's end, one frame late. */
  lateStarts: number;
}

/** Why a trigger played nothing. */
export type PlaylistRefusalReason = "cooldown" | "chance" | "maxInstances" | "missing" | "unsupported";

/** One refused trigger, for `Audio.debug()`. */
export interface PlaylistRefusal {
  playlist: string;
  world: number;
  reason: PlaylistRefusalReason;
  /** The audio clock when it was refused. */
  time: number;
}

/** One stolen instance, for `Audio.debug()`. */
export interface PlaylistSteal {
  playlist: string;
  /** The stolen instance's id and the one that took its place. */
  victim: number;
  thief: number;
  rule: "stealOldest" | "stealQuietest" | "stealFarthest";
  time: number;
}

/** The playlist runtime's session figures for `Audio.debug().playlistTotals`. */
export interface PlaylistTotals {
  /** Refused triggers by reason, since the page began. */
  refused: Record<PlaylistRefusalReason, number>;
  /** The latest refusals, newest last (at most 32). */
  recentRefusals: PlaylistRefusal[];
  /** The latest steals, newest last (at most 32). */
  recentSteals: PlaylistSteal[];
  /** Entries a continuous Queue started one frame late (its previous entry's length was unknown). */
  lateStarts: number;
}

const RECENT = 32;
const LINGERING_MAX = 64;

interface Timer { at: number; run: () => void; instance: PlaylistInstance }

const emptyRefused = (): Record<PlaylistRefusalReason, number> => ({ cooldown: 0, chance: 0, maxInstances: 0, missing: 0, unsupported: 0 });
const emptyStingers = (): Record<StingerOutcome, number> => ({ played: 0, late: 0, skipped: 0, dropped: 0 });

export class PlaylistSystem implements HostedRuntime, InstanceSystem {
  private readonly live = new Set<PlaylistInstance>();
  /** Retired instances whose voices still fade: they keep their group until the last one ends. */
  private holding: PlaylistInstance[] = [];
  /** Retired instances `debugRows` keeps while the backend still lists their voices. */
  private lingering: PlaylistInstance[] = [];
  private readonly timers: Timer[] = [];
  private readonly lastAccepted = new Map<string, number>();
  private readonly picks = new Map<number, Map<string, PickState>>();
  private refusedCounts = emptyRefused();
  private readonly refusals: PlaylistRefusal[] = [];
  private readonly steals: PlaylistSteal[] = [];
  private lateStarts = 0;
  private stingerTotals = emptyStingers();
  private endsSeen = 0;
  /** Audio event paths already warned about (one warning each per session). */
  private readonly refusedEvents = new Set<string>();

  /**
   * Plays a playlist (or a sample, as a one-sample Clip playlist); null when the trigger played nothing (its reason is
   * recorded). An audio event file is refused (`unsupported`) with one warning naming the migration.
   */
  play(path: string, options: PlaylistOptions, world: number, sourceKey?: string, given?: PlaylistAsset): PlaylistInstance | null {
    const host = playlistHost();
    host.host(this);
    host.syncSettings(); // the seed, globals and backend as the project has them now (the generator is seeded here)
    this.reapIfEnded();
    if (!given && isAudioEventPath(path)) {
      if (!this.refusedEvents.has(path)) { this.refusedEvents.add(path); console.warn(`[myco] ${audioEventRefusal("Audio.play", path)}`); }
      return this.refuse(path, world, "unsupported");
    }
    // `given`: a playlist the runtime made (ADR 0354 §5: a line's implicit Clip), played under `path` for the rows.
    // ADR 0360 §1: a generator plays as a one-generator Clip playlist, as a sample does.
    const asset = given ?? (isPlaylistPath(path) ? loadPlaylist(path) : isGeneratorPath(path) ? generatorPlaylist(path) : samplePlaylist(path));
    if (!asset) return this.refuse(path, world, "missing");
    const key = `${world}:${sourceKey ?? path}`;
    const now = host.now();
    const same: GateCandidate<PlaylistInstance>[] = [];
    let listener: Vec3Like | null | undefined;
    for (const i of this.live) {
      if (i.path !== path || i.world !== world || !i.playing) continue;
      if (asset.playback.whenFull === "stealFarthest" && listener === undefined) listener = listenerPosition();
      same.push({ ref: i, startedAt: i.startedAt, loudness: i.loudness, distance: distanceTo(i.position, listener ?? null) });
    }
    const g = gateTrigger(asset.playback, this.lastAccepted.get(key) ?? null, now, () => host.random(world), same);
    if (!g.ok) return this.refuse(path, world, g.reason);
    this.lastAccepted.set(key, now);
    const group = host.takeGroup();
    const instance = new PlaylistInstance(this, asset, path, world, group, options, now);
    for (const victim of g.steal) {
      this.note(this.steals, { playlist: path, victim: victim.group, thief: group, rule: asset.playback.whenFull as PlaylistSteal["rule"], time: host.clock() });
      victim.stop(STEAL_FADE_SECONDS);
    }
    this.live.add(instance);
    // ADR 0435: with the cause (the request, its node, the running behaviour hook and system) for "Why it played".
    if (taps.sink !== NULL_PROFILE_SINK) taps.sink.eventStart(group, path, playCause(options.trigger ?? "Audio.play", options.triggerNode));
    instance.start();
    // ADR 0357 §4: a playlist with a caption reports its instances' start and end (`Audio.onCaption`).
    if (asset.caption) watchCaption(instance, asset.caption);
    return instance;
  }

  /** Global parameter reads for `Audio.getParameter` go through the host; this only forwards changes. */
  onGlobal(name: string): void {
    for (const i of this.live) i.onParameter(name, true);
  }

  update(dt: number): void {
    if (this.live.size === 0 && this.timers.length === 0 && this.holding.length === 0) return;
    this.reapIfEnded();
    const t = playlistHost().clock();
    while (this.timers.length > 0 && this.timers[0]!.at <= t) {
      // A stopped instance's timer still runs its wrapper, which only counts it down (`PlaylistInstance.schedule`).
      this.timers.shift()!.run();
    }
    for (const i of this.live) i.update(dt);
    this.reap();
  }

  resend(): void {
    for (const i of this.live) i.resend();
  }

  stopAll(): void {
    for (const i of [...this.live]) i.stop(0);
    this.live.clear();
    this.lingering.length = 0;
    this.timers.length = 0;
  }

  release(): void {
    this.stopAll();
    this.holding.length = 0;
    this.lastAccepted.clear();
    this.picks.clear();
    this.refusedCounts = emptyRefused();
    this.refusals.length = 0;
    this.steals.length = 0;
    this.lateStarts = 0;
    this.stingerTotals = emptyStingers();
    this.endsSeen = mixer.voicesEnded;
    this.refusedEvents.clear();
  }

  forgetWorld(key: number): void {
    this.picks.delete(key);
  }

  sweep(): void {
    this.reap();
    this.releaseHeld();
  }

  // --- InstanceSystem ---------------------------------------------------------------------------------------------

  random(world: number): number { return playlistHost().random(world); }

  pickState(world: number, key: string): PickState {
    let m = this.picks.get(world);
    if (!m) this.picks.set(world, (m = new Map()));
    let s = m.get(key);
    if (!s) m.set(key, (s = newPickState()));
    return s;
  }

  schedule(at: number, instance: PlaylistInstance, run: () => void): void {
    const timer = { at, run, instance };
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1]!.at > at) i--;
    this.timers.splice(i, 0, timer);
  }

  takeTimers(instance: PlaylistInstance): { at: number; run: () => void }[] {
    const taken: { at: number; run: () => void }[] = [];
    let w = 0;
    for (const t of this.timers) {
      if (t.instance === instance) taken.push({ at: t.at, run: t.run });
      else this.timers[w++] = t;
    }
    this.timers.length = w;
    return taken;
  }

  noteLateStart(instance: PlaylistInstance): void {
    instance.lateStarts++;
    this.lateStarts++;
  }

  retire(instance: PlaylistInstance): void {
    if (!this.live.delete(instance)) return;
    if (taps.sink !== NULL_PROFILE_SINK) taps.sink.eventStop(instance.group);
    if (instance.group > 0) {
      if (this.lingering.length >= LINGERING_MAX) this.lingering.splice(0, LINGERING_MAX >> 1);
      this.lingering.push(instance);
    }
    if (instance.hasVoices && instance.group > 0) this.holding.push(instance);
    else playlistHost().giveGroup(instance.group);
  }

  noteStinger(outcome: StingerOutcome): void {
    this.stingerTotals[outcome]++;
  }

  noteParameter(name: string, def: ParameterDef, value: number, instance: number | null): void {
    const sink = taps.sink;
    if (sink === NULL_PROFILE_SINK) return;
    sink.parameter(name, value, instance);
    if (isLabelled(def)) sink.stateChange(name, def.labels[value] ?? String(value));
  }

  // --- rows -------------------------------------------------------------------------------------------------------

  /**
   * Rows for `Audio.debug().events` (ADR 0249): every playing instance, and one whose voices the backend still lists
   * (`listed`: voices per instance id), so a row goes with its last voice. `asset` is the playlist path.
   */
  debugRows(listed?: ReadonlyMap<number, number>, out?: EventDebugRow[]): EventDebugRow[] {
    const rows = out ?? [];
    rows.length = 0;
    const pooled = out !== undefined;
    this.shown.clear();
    for (const i of this.live) if (i.playing) this.row(rows, pooled, i, i.voiceCount);
    if (!listed) return rows;
    for (const i of this.live) if (!i.playing && this.stillListed(i, listed)) this.row(rows, pooled, i, listed.get(i.group)!);
    let w = 0;
    for (const i of this.lingering) {
      if (this.live.has(i) || !this.stillListed(i, listed)) continue;
      this.row(rows, pooled, i, listed.get(i.group)!);
      this.lingering[w++] = i;
    }
    this.lingering.length = w;
    return rows;
  }

  /** The groups `debugRows` has shown this call (one Set, cleared per call). */
  private readonly shown = new Set<number>();
  /** Row objects `debugRows(listed, out)` reuses (the keyframe source's per-keyframe read). */
  private readonly rowPool: EventDebugRow[] = [];

  private stillListed(i: PlaylistInstance, listed: ReadonlyMap<number, number>): boolean {
    return i.group > 0 && !this.shown.has(i.group) && (listed.get(i.group) ?? 0) > 0;
  }

  /** Appends one row: pooled (a reused row and the instance's reused parameter record), else fresh objects to keep. */
  private row(rows: EventDebugRow[], pooled: boolean, i: PlaylistInstance, voices: number): void {
    if (i.group > 0) this.shown.add(i.group);
    if (!pooled) {
      rows.push({ id: i.group, asset: i.path, world: i.world, voices, parameters: i.parameterValues(), lateStarts: i.lateStarts });
      return;
    }
    const row = (this.rowPool[rows.length] ??= { id: 0, asset: "", world: 0, voices: 0, parameters: {}, lateStarts: 0 });
    row.id = i.group;
    row.asset = i.path;
    row.world = i.world;
    row.voices = voices;
    row.parameters = i.parameterValuesShared();
    row.lateStarts = i.lateStarts;
    rows.push(row);
  }

  /**
   * Rows for `Audio.debug().music` (`musicRows.ts`): every playing instance whose playing entry has a musical clock with
   * a tempo, heard now. Fresh objects; debug only.
   */
  musicRows(): MusicDebugRow[] {
    const rows: MusicDebugRow[] = [];
    for (const i of this.live) {
      if (!i.playing) continue;
      // ADR 0362 §1: on the instance's own clock (a paused one holds).
      const r = musicRowOf(i, i.clock());
      if (r) rows.push(r);
    }
    return rows;
  }

  /** Stinger outcomes over the session, ended instances included (`Audio.debug().musicTotals.stingers`). */
  stingerOutcomes(): Record<StingerOutcome, number> {
    return { ...this.stingerTotals };
  }

  totals(): PlaylistTotals {
    return {
      refused: { ...this.refusedCounts },
      recentRefusals: this.refusals.map((r) => ({ ...r })),
      recentSteals: this.steals.map((s) => ({ ...s })),
      lateStarts: this.lateStarts,
    };
  }

  // --- internals --------------------------------------------------------------------------------------------------

  private refuse(path: string, world: number, reason: PlaylistRefusalReason, message?: string): null {
    this.refusedCounts[reason]++;
    this.note(this.refusals, { playlist: path, world, reason, time: playlistHost().clock() });
    if (message) console.warn(message);
    return null;
  }

  private note<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > RECENT) list.splice(0, list.length - RECENT);
  }

  private reap(): void {
    for (const i of this.live) if (!i.playing) this.retire(i);
    this.releaseHeld();
  }

  /** After a voice ended somewhere (one number compared per call), retire instances that have finished. */
  private reapIfEnded(): void {
    const ends = mixer.voicesEnded;
    if (ends === this.endsSeen) return;
    this.endsSeen = ends;
    this.reap();
  }

  private releaseHeld(): void {
    if (this.holding.length === 0) return;
    let w = 0;
    for (const i of this.holding) {
      if (i.hasVoices) this.holding[w++] = i;
      else playlistHost().giveGroup(i.group);
    }
    this.holding.length = w;
  }
}

/** The listener's position in the active World (an enabled `AudioListener`, else the main camera), or null. */
function listenerPosition(): Vec3Like | null {
  const world = World.active;
  if (!world) return null;
  for (const l of world._componentsOfType(AudioListener)) if (l.isActiveAndEnabled) return listenerPose(l.node)?.position ?? null;
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
  return best ? listenerPose(best.node)?.position ?? null : null;
}

/** Distance from `p` to the listener; 0 for a flat instance or with no listener. */
function distanceTo(p: Vec3Like | null, listener: Vec3Like | null): number {
  if (!p || !listener) return 0;
  const dx = p.x - listener.x, dy = p.y - listener.y, dz = p.z - listener.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

let system: PlaylistSystem | null = null;

/** The page's playlist runtime if anything has started it (debug readers ask without starting it). */
export function playlistsIfStarted(): PlaylistSystem | null {
  return system;
}

/** The page's playlist runtime (hosted by the playlist host on first use). */
export function playlists(): PlaylistSystem {
  if (!system) {
    system = new PlaylistSystem();
    playlistHost().host(system);
  }
  return system;
}
