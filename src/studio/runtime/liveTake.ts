// The live take: while the Studio is connected to a game build, the take recording on that build (started by the Studio,
// F10 or the game's script), as it grows. It follows the connected build (`studioBuild`), holds the audio topic's
// `takeLive` subscription while one is connected, reassembles the feed (`TakeLiveStream`) and publishes the take as a
// `Take` (`engine/audio/take/reader.ts`) a few times a second, with its state. It plays nothing: it is a picture of what
// the game asks, for the Take screen's timeline. The build's last take (stopped) shows until a new one starts; a new
// take starts the picture over.
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { ConnectedBuild } from "../../editor/debugLink/editorLink";
import type { Take } from "../../engine/audio/take/reader";
import { AUDIO_TOPIC, type AudioSubscriptionParams } from "../../plugins/audio/runtime/debugLink/schema";
import { TakeLiveStream } from "../../plugins/audio/editor/debugLink/takeLiveStream";
import { studioBuild } from "../debugLink/studioLink";

/** Where the connected build's take stands: none (or no build), recording, or stopped (its last take, kept). */
export type LiveTakeState = "idle" | "recording" | "stopped";

/** The connected build's take as it stands. */
export interface LiveTake {
  /** The build it records on (its name). */
  readonly build: string;
  readonly state: "recording" | "stopped";
  /** The take so far: requests, keyframes and pictures; META's facts (its duration grows while it records). */
  readonly take: Take;
  /** The take's id on the build: a new take, a new id. */
  readonly id: number;
  /** Whether the build takes pictures for it, and how wide. */
  readonly pictures: boolean;
  readonly pictureWidth: number;
  /** Why it stopped by itself (the build's message), or why the feed broke; null otherwise. */
  readonly message: string | null;
}

/** How often the live take is rebuilt while records arrive, at most, ms. */
export const LIVE_TAKE_PUBLISH_MS = 250;

const takeSignal = signal<LiveTake | null>(null);
const stateSignal = signal<LiveTakeState>("idle");

/** The connected build's take as it stands; null with no build connected or before its first take. */
export const liveTake: ReadonlySignal<LiveTake | null> = takeSignal;
/** Its state ("idle" with no build connected or no take yet). */
export const liveTakeState: ReadonlySignal<LiveTakeState> = stateSignal;

/** A connected build, as far as the live take needs it. */
export type LiveTakeBuild = Pick<ConnectedBuild, "name" | "peer">;

/**
 * Follows `builds`: holds the `takeLive` subscription on whichever build is connected (again on each new one) and keeps
 * `liveTake` / `liveTakeState` up to date. Returns the stop (which unsubscribes and clears them).
 */
export function followLiveTake(builds: ReadonlySignal<LiveTakeBuild | null>): () => void {
  let current: { peer: LiveTakeBuild["peer"]; stop: () => void } | null = null;

  const attach = (build: LiveTakeBuild): (() => void) => {
    const stream = new TakeLiveStream();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = -Infinity;
    let closed = false;
    let state: LiveTakeState = "idle";
    let feedError: string | null = null;

    const publish = (): void => {
      timer = null;
      if (closed) return;
      last = Date.now();
      const take = stream.take();
      const facts = stream.facts;
      if (!take || !facts) {
        takeSignal.value = null;
        stateSignal.value = "idle";
        return;
      }
      const s = stream.state === "stopped" ? "stopped" : "recording";
      takeSignal.value = {
        build: build.name, state: s, take, id: facts.take, pictures: facts.pictures, pictureWidth: facts.pictureWidth,
        message: feedError ?? stream.error ?? stream.stopMessage,
      };
      stateSignal.value = s;
    };

    const schedule = (now: boolean): void => {
      if (closed) return;
      const wait = LIVE_TAKE_PUBLISH_MS - (Date.now() - last);
      if (now || wait <= 0) {
        if (timer !== null) clearTimeout(timer);
        publish();
      } else if (timer === null) {
        timer = setTimeout(publish, wait);
      }
    };

    const params: AudioSubscriptionParams = { kind: "takeLive" };
    const sub = build.peer.subscribe(
      AUDIO_TOPIC,
      params,
      (records) => {
        let changed = false;
        for (const r of records) changed = stream.push(r) || changed;
        if (!changed) return;
        // A take starting or stopping shows at once; its growth a few times a second.
        const was = state;
        state = stream.state;
        schedule(state !== was);
      },
      (message) => {
        // An older build without the feed, or the link closed: what was shown stays, with why it stopped following.
        feedError = message;
        if (stream.facts) schedule(true);
      },
    );
    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      sub.unsubscribe();
    };
  };

  const dispose = effect(() => {
    const build = builds.value;
    const peer = build?.peer ?? null;
    if (current?.peer === peer) return;
    current?.stop();
    current = null;
    takeSignal.value = null;
    stateSignal.value = "idle";
    if (build) current = { peer: build.peer, stop: attach(build) };
  });

  return () => {
    dispose();
    current?.stop();
    current = null;
    takeSignal.value = null;
    stateSignal.value = "idle";
  };
}

/** Follows the Studio's connected build (`studioBuild`); main.tsx calls it once at start. Returns the stop. */
export function installLiveTake(): () => void {
  return followLiveTake(studioBuild);
}
