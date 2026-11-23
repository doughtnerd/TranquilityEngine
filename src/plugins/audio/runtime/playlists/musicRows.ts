/**
 * `Audio.debug().music` rows from playlist instances (ADR 0343 retired ADR 0166's music players, whose rows these were;
 * decision log D32 kept the section empty until now). One row per playing instance whose playing entry has a musical
 * clock with a tempo (a Sequence with one, or a Clip whose sample has one), in the row type the players filled:
 *
 * - `segment` is the clock's label (the sequence's playlist path or the clip's sample path), `bar`/`beat`/`tick` and
 *   `tempo`/`beatsPerBar` its position heard now, `time` now; `pass` stays 1 (a playlist counts no passes).
 * - `pending` is the Switch change waiting for its boundary: `to` the label, `time` where it lands as `"bar:beat"` on the
 *   playing clock, the rule's index (-1: `onChange`), `"from>to"` as the rule names them, its tier, the Switch's playlist
 *   path as `parent`, the rule's `when` as `exit` and `"start"` (`"bridge"` while a transition plays and the new entry
 *   waits for its Exit marker) as `enter`.
 * - `groups` are the stingers accepted and not yet ended: `"stamped"` before their start, `"playing"` after (no priming:
 *   playlists start voices directly).
 * - `state` is `ending` once released or stopping, `transitioning` while a change waits, else `playing`.
 * - The ring, prime and recovery figures stay zero: those were the music players' (ADR 0167), which playlists don't use.
 */
import { MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { MusicDebugPending, MusicDebugRow } from "../debugTypes";
import type { PlaylistInstance } from "./instance";
import type { PendingSwitchChange } from "./liveNode";

/** The music row of `instance` heard at `now`, or null when its playing entry has no tempo. */
export function musicRowOf(instance: PlaylistInstance, now: number): MusicDebugRow | null {
  const source = instance.musicalSource();
  if (!source?.hasGrid) return null;
  const pos = source.positionAt(now);
  if (!pos) return null;
  const change = instance.pendingChange();
  const groups: MusicDebugRow["groups"] = instance.stingersQueued().map((s, k) => ({ id: k + 1, state: s.at > now ? "stamped" : "playing", primed: 1, of: 1 }));
  return {
    id: instance.group,
    asset: instance.path,
    state: instance.released || instance.stopped ? "ending" : change ? "transitioning" : "playing",
    segment: source.label,
    pass: 1,
    bar: pos.bar,
    beat: pos.beat,
    tick: Math.min(MUSIC_TICKS_PER_BEAT - 1, Math.max(0, Math.floor(pos.beatFraction * MUSIC_TICKS_PER_BEAT))),
    tempo: pos.tempo,
    beatsPerBar: pos.beatsPerBar,
    time: now,
    pending: change ? pendingRow(change, source.positionAt(change.at)) : null,
    groups,
    stems: [],
    primeLastMs: 0,
    primeEmaMs: 0,
    leadMs: 0,
    replans: {},
    refusals: {},
    lateGroups: 0,
    groupsHeld: 0,
    groupTimeouts: 0,
    lastSlipFrames: 0,
    recoveries: {},
    missedBeats: 0,
    stingers: { ...instance.stingerCounts },
  };
}

function pendingRow(c: PendingSwitchChange, at: { bar: number; beat: number } | null): MusicDebugPending {
  const rule = c.rule >= 0 ? (c.how as { from?: string; to?: string }) : null;
  return {
    to: c.to ?? "",
    time: at ? `${at.bar}:${at.beat}` : "",
    rule: c.rule,
    ruleKey: rule ? `${rule.from}>${rule.to}` : `${c.from ?? "*"}>${c.to ?? "*"}`,
    tier: c.tier,
    parent: c.where,
    exit: c.how.when,
    enter: c.bridging ? "bridge" : "start",
  };
}
