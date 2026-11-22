// The Studio page's shared services (ADR 0327, 0335): one router, one audio runtime host, one toast queue, one keymap,
// the per-user Studio preferences and the player bar's slots. `main.tsx` makes the router and the runtime when the
// page starts; screens and panels reach them here.
import { computed, signal } from "@preact/signals";
import { persisted } from "../../editor/preferences";
import { createToastQueue } from "../../editor/ui/undoToastModel";
import type { PlayerBarSlots } from "../components/PlayerBar";
import type { OffsetStore } from "../components/deviceOffsets";
import type { StudioAudioHost, StudioAudioRuntime } from "../runtime/studioAudioHost";
import { createKeymap } from "./keymap";
import type { RouteRequest, StudioRouter } from "./route";
import type { ScreenId } from "./screens";

/** Toasts ("Deleted Engine loop · Undo"). */
export const toasts = createToastQueue();

/** Every shortcut, global, per screen and per panel. */
export const keymap = createKeymap();

/** Per user: shortcuts without a modifier (Space, M, ?) work. */
export const singleKeyShortcuts = persisted<boolean>("myco.studio.singleKeyShortcuts", true);

/** Per user: audio and visual offsets per output device. */
export const deviceOffsets = persisted<OffsetStore>("myco.studio.deviceOffsets", {});

/** The keyboard shortcuts dialog is open. */
export const shortcutsOpen = signal(false);

/** Each screen's player bar slots, set by the screen. */
const slots = signal<Partial<Record<ScreenId, PlayerBarSlots>>>({});
export const playerSlots = computed(() => slots.value);

/** Fill (or with null, clear) a screen's player bar slots. */
export function setPlayerSlots(screen: ScreenId, value: PlayerBarSlots | null): void {
  const next = { ...slots.peek() };
  if (value) next[screen] = value;
  else delete next[screen];
  slots.value = next;
}

let router: StudioRouter | null = null;
let runtime: StudioAudioRuntime | null = null;

/** Set once by `main.tsx`. */
export function provideStudio(services: { router: StudioRouter; runtime: StudioAudioRuntime }): void {
  router = services.router;
  runtime = services.runtime;
}

/** The page's router. */
export function studioRouter(): StudioRouter {
  if (!router) throw new Error("The Studio's router isn't set up (main.tsx).");
  return router;
}

/** Go to a screen, on an asset, with something selected (`route.ts`). */
export const openRoute = (request: RouteRequest): void => studioRouter().open(request);

/** The audio host panels play through (ADR 0327 "A seam for the live link"). */
export function audioHost(): StudioAudioHost {
  if (!runtime) throw new Error("The Studio's audio runtime isn't set up (main.tsx).");
  return runtime;
}

/** The runtime with its open and close, for the shell. */
export function audioRuntime(): StudioAudioRuntime {
  if (!runtime) throw new Error("The Studio's audio runtime isn't set up (main.tsx).");
  return runtime;
}
