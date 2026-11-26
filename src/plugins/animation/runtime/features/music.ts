// Musical timing (ADR 0372; T72): `at: "beat" | "bar" | "exit"` and `align: "start" | "hit"` on plays, crossfades,
// travels and requests, read through the audio plugin's public API only (`AudioPlaylistHandle`, `Audio.time`). Playback
// (`playback.ts`) and the graph API (`graph.ts`) hand an action with `at` here; it is held on the host and released by
// `animation.Gather` (`releaseMusic`, from `stages/gather/music.ts`) on the first frame whose heard clock has reached its
// boundary, then sent to the core in that same frame. A play released late starts that far into its clip, so its
// playhead is where it would be had it started on the boundary.
//
// - `beat` / `bar`: the boundary is `music.nextGrid(at)` (moved on by whole beats or bars at the music's tempo when the
//   first one is too close for a hit to land on it), re-read each frame until it arrives, so a tempo change is followed.
// - `exit`: the next Exit marker the playlist reports passing (`onMarker("exit")`). Exit points can't be seen ahead
//   through the public API, so a play aligned on its hit starts at the hit's phase: that far into its clip.
// - `align: "hit"`: a play is released early by the time from its start to its clip's first `hit` marker (at its
//   speed), so the hit lands on the boundary, choosing the first boundary far enough away for that. A clip without a
//   hit marker aligns its start (one warning). Travels and requests have no clip of their own: they align their start.
//
// Without the audio plugin (ADR 0374: `features/music/register.ts` turns this on when `myco.audio` is active), without a
// `music` handle, or with music that has no beat grid (for `beat` / `bar`), `at` is refused with one warning and the
// action happens at once; music that stops while an action waits releases it at once, with one warning. Every play's
// promise still resolves exactly once: from the play it becomes, or `stopped` when its Animator goes away first (a
// travel: `interrupted`).
import type { Audio as AudioApi, AudioPlaylistHandle } from "../../../audio/runtime";
import type { World } from "../../../../engine/core/World";
import type { Animator } from "../components/Animator";
import type { AnimationFrame } from "../stages/frame";
import type { AnimationPlayResult, AnimatorMusicTiming, AnimatorTravelResult } from "../types";
import { readClipCues, readClipHits, sectionRange } from "./graph/clipCues";
import { animatorRuntime, clipUsers, type AnimatorRuntime, type ClipEntry } from "./instances";
import { boundaryAtOrAfter, boundaryPeriod, hitLead, isDue, startShift } from "./music/musicTimingLogic";

// Audio is an optional dependency (ADR 0374), so its module is loaded with `import()` when it's active, never statically
// (ADR 0133/0136: a value import would need it in the manifest's hard dependencies). Only `Audio.time` is read from it.
let active = false;
let audio: typeof AudioApi | null = null;
let loading: Promise<void> | null = null;
let loadFailed = false;

/** @internal Whether musical timing is on: set at each activation (loads the audio module the first time it's on). */
export function setMusicTiming(on: boolean): void {
  active = on;
  if (on && !audio && !loading) {
    loadFailed = false;
    loading = import("../../../audio/runtime").then(
      (m) => {
        audio = m.Audio;
      },
      (err: unknown) => {
        loading = null;
        loadFailed = true;
        console.warn(`[myco] Animation: musical timing (\`at\`) can't wait for the music: the audio module failed to load (${String(err)}); actions happen at once.`);
      },
    );
  }
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** What a play aligned on its hit needs: its clip and where (clip seconds) and how fast it starts. */
export interface HitClip {
  readonly clip: ClipEntry;
  /** The play's start: clip seconds, or a fraction of the clip (`normalized`), or a section (cue name or clip seconds). */
  readonly start: { readonly normalized: number } | { readonly section: string | { readonly start: number } };
  readonly speed: number;
}

/** One action waiting for its music boundary. */
interface Held {
  readonly rt: AnimatorRuntime;
  readonly what: string;
  readonly at: "beat" | "bar" | "exit";
  readonly music: AudioPlaylistHandle;
  /** Clip speed, to turn heard lateness into clip seconds (0: not a play, nothing to shift). */
  readonly speed: number;
  /** The clip whose hit lands on the boundary; null aligns the start. */
  readonly hit: HitClip | null;
  /** Sends the action, its start moved on by `shift` clip seconds; queued commands go to the core in `frame`. */
  readonly release: (frame: AnimationFrame | null, shift: number) => void;
  /** Its Animator went away first: end its promise. */
  readonly cancel: () => void;
  /** Heard seconds from release to the boundary (the hit's lead); undefined until known (the clip loads). */
  lead: number | undefined;
  /** The boundary (heard seconds; NaN until chosen) and the earliest a boundary may be (now plus the lead, when first seen). */
  target: number;
  earliest: number;
  /** `exit`: the heard time of the Exit marker that passed (NaN until one does), and the listener to drop. */
  exitAt: number;
  unsubscribe: (() => void) | null;
  done: boolean;
}

const heldByWorld = new WeakMap<World, Held[]>();
// A held play's hit clip is read until its lead is known: an Animator rebinding to another skeleton keeps it till then.
clipUsers.add(function* (rt) {
  for (const h of heldByWorld.get(rt.world) ?? []) if (h.rt === rt && !h.done && h.hit) yield h.hit.clip;
});
/** The latest held play per Animator (`onFinished`), until a later play replaces it. */
const latestHeld = new WeakMap<Animator, Promise<AnimationPlayResult>>();

/**
 * @internal Whether `timing` asks to wait for music. False (with one warning for a bad request) when it doesn't, or can't:
 * the caller then acts at once.
 */
export function wantsMusic(animator: Animator, what: string, timing: AnimatorMusicTiming): boolean {
  const who = animator.node?.name ?? "Animator";
  if (timing.at === undefined) {
    if (timing.align !== undefined && timing.align !== "start") warnOnce(`align-alone:${what}`, `[myco] ${who}: Animator.${what}: \`align\` needs \`at\` (a music boundary); it starts at once.`);
    return false;
  }
  if (timing.at !== "beat" && timing.at !== "bar" && timing.at !== "exit") {
    warnOnce(`at:${what}:${String(timing.at)}`, `[myco] ${who}: Animator.${what}: \`at\` is "beat", "bar" or "exit", not ${JSON.stringify(timing.at)}; it happens at once.`);
    return false;
  }
  if (!active || loadFailed) {
    warnOnce(`inactive:${what}`, `[myco] ${who}: Animator.${what}: musical timing (\`at\`) needs the audio plugin (myco.audio), which isn't enabled; it happens at once.`);
    return false;
  }
  if (!timing.music || typeof timing.music.onMarker !== "function") {
    warnOnce(`nomusic:${what}`, `[myco] ${who}: Animator.${what}: \`at\` needs \`music\` (the AudioPlaylistHandle of the music to follow); it happens at once.`);
    return false;
  }
  if (!timing.music.playing) {
    warnOnce(`stopped:${what}`, `[myco] ${who}: Animator.${what}: the music for \`at: "${timing.at}"\` isn't playing; it happens at once.`);
    return false;
  }
  if (timing.at !== "exit" && !timing.music.music) {
    warnOnce(`nogrid:${what}`, `[myco] ${who}: Animator.${what}: the music has no tempo, so it has no ${timing.at}s to wait for; it happens at once.`);
    return false;
  }
  if (timing.align !== undefined && timing.align !== "start" && timing.align !== "hit") {
    warnOnce(`align:${what}:${String(timing.align)}`, `[myco] ${who}: Animator.${what}: \`align\` is "start" or "hit", not ${JSON.stringify(timing.align)}; its start lands on the boundary.`);
  }
  return true;
}

/** Holds `held` until its boundary (the caller checked `wantsMusic`). */
function hold(held: Held): void {
  let list = heldByWorld.get(held.rt.world);
  if (!list) heldByWorld.set(held.rt.world, (list = []));
  list.push(held);
  if (held.at === "exit") {
    held.unsubscribe = held.music.onMarker("exit", (e) => {
      if (!held.done && Number.isNaN(held.exitAt) && Number.isFinite(e.time)) held.exitAt = e.time;
    });
  }
}

function newHeld(rt: AnimatorRuntime, what: string, timing: AnimatorMusicTiming, speed: number, hit: HitClip | null, release: Held["release"], cancel: Held["cancel"]): Held {
  return {
    rt, what, at: timing.at!, music: timing.music!, speed, hit, release, cancel,
    lead: hit ? undefined : 0, target: Number.NaN, earliest: Number.NaN, exitAt: Number.NaN, unsubscribe: null, done: false,
  };
}

/**
 * @internal Holds a play until its music boundary (the caller checked `wantsMusic`). `send(shift)` queues the play, its
 * start moved on by `shift` clip seconds, and returns its promise; `flush` sends what was queued to the core in the frame.
 * `hit`: the play's clip and start when `align: "hit"`.
 */
export function holdPlay(
  animator: Animator,
  what: string,
  timing: AnimatorMusicTiming,
  speed: number,
  hit: HitClip | null,
  send: (shift: number) => Promise<AnimationPlayResult>,
  flush: (frame: AnimationFrame, rt: AnimatorRuntime) => void,
): Promise<AnimationPlayResult> {
  const rt = animatorRuntime(animator)!;
  let resolve!: (r: AnimationPlayResult) => void;
  const promise = new Promise<AnimationPlayResult>((r) => (resolve = r));
  let settled = false;
  const settle = (r: AnimationPlayResult) => {
    if (settled) return;
    settled = true;
    resolve(r);
  };
  hold(
    newHeld(
      rt, what, timing, speed, timing.align === "hit" ? hit : null,
      (frame, shift) => {
        void send(shift).then(settle);
        if (frame) flush(frame, rt);
      },
      () => settle({ reason: "stopped" }),
    ),
  );
  latestHeld.set(animator, promise);
  return promise;
}

/** @internal Holds a travel until its music boundary (the caller checked `wantsMusic`); it aligns its start. */
export function holdTravel(
  animator: Animator,
  timing: AnimatorMusicTiming,
  send: () => Promise<AnimatorTravelResult>,
  flush: (frame: AnimationFrame, rt: AnimatorRuntime) => void,
): Promise<AnimatorTravelResult> {
  const rt = animatorRuntime(animator)!;
  alignStartOnly(animator, "travel", timing);
  let resolve!: (r: AnimatorTravelResult) => void;
  const promise = new Promise<AnimatorTravelResult>((r) => (resolve = r));
  let settled = false;
  const settle = (r: AnimatorTravelResult) => {
    if (settled) return;
    settled = true;
    resolve(r);
  };
  hold(newHeld(rt, "travel", timing, 0, null, (frame) => {
    void send().then(settle);
    if (frame) flush(frame, rt);
  }, () => settle({ reason: "interrupted" })));
  return promise;
}

/** @internal Holds a request until its music boundary (the caller checked `wantsMusic`); it aligns its start. */
export function holdRequest(animator: Animator, timing: AnimatorMusicTiming, send: () => void, flush: (frame: AnimationFrame, rt: AnimatorRuntime) => void): void {
  const rt = animatorRuntime(animator)!;
  alignStartOnly(animator, "request", timing);
  hold(newHeld(rt, "request", timing, 0, null, (frame) => {
    send();
    if (frame) flush(frame, rt);
  }, () => {}));
}

function alignStartOnly(animator: Animator, what: string, timing: AnimatorMusicTiming): void {
  if (timing.align === "hit") warnOnce(`hit-${what}`, `[myco] ${animator.node.name}: Animator.${what}: \`align: "hit"\` aligns a played clip's hit marker; a ${what} has no clip of its own, so its start lands on the boundary.`);
}

/** @internal The latest held play's promise of `animator` (for `onFinished`), or null. */
export function latestHeldPlay(animator: Animator): Promise<AnimationPlayResult> | null {
  return latestHeld.get(animator) ?? null;
}

/** @internal A play that isn't held was asked for: it is now the latest (`onFinished`). */
export function forgetHeldPlay(animator: Animator): void {
  latestHeld.delete(animator);
}

// ------------------------------------------------------------------------------------------------ release

/** The hit's lead in heard seconds once the clip has loaded (0 with a warning when it has no hit), undefined while it loads. */
function leadOf(h: Held): number | undefined {
  const hit = h.hit;
  if (!hit) return 0;
  const clip = hit.clip;
  if (clip.handle === undefined) return undefined;
  if (!clip.handle || !h.rt.ns) return 0; // it can't load: the play ends when sent
  const bytes = h.rt.ns.core.assetBytes(clip.handle);
  const duration = clip.info?.duration ?? 0;
  let start = 0;
  if ("normalized" in hit.start) start = Math.min(1, Math.max(0, hit.start.normalized)) * duration;
  else if (typeof hit.start.section === "object") start = Number.isFinite(hit.start.section.start) ? Math.max(0, hit.start.section.start) : 0;
  else start = (bytes ? sectionRange(readClipCues(bytes), hit.start.section)?.start : undefined) ?? 0;
  const lead = bytes ? hitLead(readClipHits(bytes), start, hit.speed) : null;
  if (lead === null) {
    warnOnce(`nohit:${clip.path}`, `[myco] ${h.rt.animator.node.name}: Animator.${h.what}: the clip "${clip.path}" has no hit marker after its start; its start lands on the boundary.`);
    return 0;
  }
  return lead;
}

function finish(h: Held): void {
  h.done = true;
  h.unsubscribe?.();
  h.unsubscribe = null;
}

/** Releases `h` now, moving its start on by `shift` clip seconds. */
function release(h: Held, frame: AnimationFrame | null, shift: number): void {
  finish(h);
  h.release(frame, h.speed ? shift : 0);
}

/** Releases `h` at once, its music gone (one warning). */
function fallBack(h: Held, frame: AnimationFrame | null, why: string): void {
  warnOnce(`fallback:${h.what}:${why}`, `[myco] ${h.rt.animator.node.name}: Animator.${h.what}: ${why}; what waited for \`at: "${h.at}"\` happens now.`);
  release(h, frame, 0);
}

/** One held action's frame: false while it keeps waiting. */
function step(h: Held, frame: AnimationFrame, now: number): boolean {
  if (!h.music.playing) {
    fallBack(h, frame, "the music stopped");
    return true;
  }
  h.lead ??= leadOf(h);
  if (h.lead === undefined) return false; // the clip loads
  const lead = h.lead;
  if (h.at === "exit") {
    if (Number.isNaN(h.exitAt)) return false;
    // An Exit marker can't be seen coming: a hit-aligned play starts at its hit's phase.
    release(h, frame, startShift(now, h.exitAt, h.speed, lead));
    return true;
  }
  const m = h.music.music;
  const next = m?.nextGrid(h.at)?.time;
  if (!m || next === undefined || !Number.isFinite(next)) {
    fallBack(h, frame, `the music has no ${h.at}s to wait for any more`);
    return true;
  }
  if (Number.isNaN(h.earliest)) h.earliest = now + lead;
  // The grid's next point at or before the boundary chosen so far: choose again from it (a tempo change moves it).
  if (Number.isNaN(h.target) || next <= h.target) {
    const t = boundaryAtOrAfter(next, boundaryPeriod(h.at, m.tempo, m.beatsPerBar), h.earliest);
    h.target = Number.isFinite(t) ? t : next;
  }
  if (!isDue(now, h.target, lead)) return false;
  release(h, frame, startShift(now, h.target - lead, h.speed));
  return true;
}

/**
 * @internal `animation.Gather`: releases the held actions of `frame`'s World (of its pass's update mode) whose boundary
 * the heard clock has reached, and sends them to the core in this frame.
 */
export function releaseMusic(frame: AnimationFrame): void {
  const list = heldByWorld.get(frame.world);
  if (!list?.length) return;
  for (let i = 0; i < list.length; i++) {
    const h = list[i]!;
    if (h.done) continue;
    if (h.rt.detached || !h.rt.active || animatorRuntime(h.rt.animator) !== h.rt) {
      finish(h);
      h.cancel();
      continue;
    }
    if ((h.rt.animator.updateMode === "fixed") !== frame.fixed) continue;
    if (!active || loadFailed) {
      fallBack(h, frame, "the audio plugin was turned off");
      continue;
    }
    if (!audio) continue; // the audio module loads
    step(h, frame, audio.time);
  }
  let w = 0;
  for (const h of list) if (!h.done) list[w++] = h;
  list.length = w;
}
