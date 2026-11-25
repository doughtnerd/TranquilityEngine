// The take picture resolution: how wide the pictures of the game view a connected build records with each take are (the
// Take screen shows them beside the timeline). A per-user preference, sent to each build the Studio connects to (the
// audio topic's `take.frames`) and again when it changes while one is connected; the build uses it from its next take.
// A build that doesn't know the request (an older one) keeps its own width.
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { ConnectedBuild } from "../../editor/debugLink/editorLink";
import { persisted } from "../../editor/preferences";
import { AUDIO_TOPIC, AudioRequest, type TakeFramesParams, type TakeFramesReply } from "../../plugins/audio/runtime/debugLink/schema";
import { studioBuild } from "../debugLink/studioLink";

/** The widths offered, pixels. */
export const TAKE_PICTURE_WIDTHS = [320, 640, 960, 1280] as const;
export type TakePictureWidth = (typeof TAKE_PICTURE_WIDTHS)[number];
/** The width until the user picks one. */
export const DEFAULT_TAKE_PICTURE_WIDTH: TakePictureWidth = 640;

/** The preference as stored (any value; read it through `takePictureWidthOf`). */
export const takePictureWidth = persisted<number>("myco.studio.takePictureWidth", DEFAULT_TAKE_PICTURE_WIDTH);

/** `value` if it is one of the widths offered, else the default. */
export function takePictureWidthOf(value: unknown): TakePictureWidth {
  return TAKE_PICTURE_WIDTHS.includes(value as TakePictureWidth) ? (value as TakePictureWidth) : DEFAULT_TAKE_PICTURE_WIDTH;
}

/** A connected build, as far as sending the width needs it. */
export type TakePicturesBuild = Pick<ConnectedBuild, "name" | "peer">;

/** What the last send answered: the width the build now uses, or why it didn't take it. Null before any (or with no build). */
export type TakePictureWidthResult = { readonly build: string; readonly width: number } | { readonly build: string; readonly error: string };

const resultSignal = signal<TakePictureWidthResult | null>(null);
/** What the connected build answered the last time the width was sent. */
export const takePictureWidthResult: ReadonlySignal<TakePictureWidthResult | null> = resultSignal;

/** Sends `width` (default: the preference) to `build` for its next takes; resolves with the width it now uses. Rejects with the build's message. */
export async function sendTakePictureWidth(build: Pick<ConnectedBuild, "peer">, width: number = takePictureWidthOf(takePictureWidth.peek())): Promise<number> {
  const params: TakeFramesParams = { width };
  const reply = (await build.peer.request(AUDIO_TOPIC, AudioRequest.frames, params)) as TakeFramesReply;
  return reply.width;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Sends the preference to whichever build `builds` holds: when one connects and whenever the preference changes while
 * it is connected; `takePictureWidthResult` says how it answered. Returns the stop.
 */
export function followTakePictureWidth(builds: ReadonlySignal<TakePicturesBuild | null>): () => void {
  let run = 0;
  const dispose = effect(() => {
    const build = builds.value;
    const width = takePictureWidthOf(takePictureWidth.value);
    const mine = ++run;
    if (!build) {
      resultSignal.value = null;
      return;
    }
    sendTakePictureWidth(build, width).then(
      (w) => {
        if (mine === run) resultSignal.value = { build: build.name, width: w };
      },
      (e: unknown) => {
        if (mine === run) resultSignal.value = { build: build.name, error: messageOf(e) };
      },
    );
  });
  return () => {
    run++;
    dispose();
    resultSignal.value = null;
  };
}

/** Sends the preference to the Studio's connected build (`studioBuild`); main.tsx calls it once at start. Returns the stop. */
export function installTakePictureWidth(): () => void {
  return followTakePictureWidth(studioBuild);
}
