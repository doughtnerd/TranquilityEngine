// The take picture resolution: how wide the pictures of the game view a connected build records with each take are (the
// Take screen shows them beside the timeline). A per-user preference; the build session (`buildSession.ts`, ADR 0417)
// sends it to each build the Studio connects to and again when it changes while one is connected, and the build uses it
// from its next take. A build that doesn't know the request (an older one) keeps its own width.
import { persisted } from "../../editor/preferences";

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

/** What a build answered the last time the width was sent: the width it now uses, or why it didn't take it. */
export type TakePictureWidthResult = { readonly build: string; readonly width: number } | { readonly build: string; readonly error: string };
