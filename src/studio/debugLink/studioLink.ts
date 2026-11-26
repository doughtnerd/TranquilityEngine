// The Audio Studio's debug link (ADR 0403, plan U4): the Studio listens (the desktop app, through the shared Tauri
// commands crate) and connects out by code (everywhere), with the editor's link class (`EditorDebugLink`), accept
// prompt, builds menu and Connect dialog. The Profiler (U5), Take (U5) and Mixer (U8) screens read the build chosen
// here and talk to it through its `DebugLinkPeer` (the `audio` topic).
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import { isTauri } from "../../engine/platform/FileSystem";
import { createTransport, transportCanListen } from "../../engine/net/Transport";
import "../../engine/net/transport/websocket";
import { listeningTransport } from "../../engine/debugLink/rendezvous/nativeHost";
import { DEFAULT_DEBUG_LINK_PREFERENCES, cleanPreferences, type DebugLinkPreferences } from "../../editor/debugLink/debugLinkLogic";
import { EditorDebugLink, type ConnectedBuild } from "../../editor/debugLink/editorLink";
import { persisted } from "../../editor/preferences";

const linkSignal = signal<EditorDebugLink | null>(null);

/** The Studio's link once started (null before `startStudioDebugLink`, and in tests that don't start it). */
export const studioLink: ReadonlySignal<EditorDebugLink | null> = linkSignal;

/** The build the Studio's screens read: the link's active build, or null (the Studio's own runtime then). */
export const studioBuild: ReadonlySignal<ConnectedBuild | null> = computed(() => linkSignal.value?.active.value ?? null);

/** The Studio's debug link preferences (per user, apart from the editor's): listening on for this machine, the LAN off. */
export const studioDebugLinkPreferences = persisted<DebugLinkPreferences>("myco.studio.debugLink", DEFAULT_DEBUG_LINK_PREFERENCES);

/**
 * Starts the Studio's link (listening as its preferences say, again when they change); returns the stop. In the
 * desktop app the native listening transport is registered first (dynamic import); in a browser page the link can't
 * listen (the settings say so) but can still connect out.
 */
export function startStudioDebugLink(): () => void {
  let stopped = false;
  let dispose: (() => void) | null = null;
  const register = isTauri() ? () => import("../../engine/debugLink/tauriListener").then((m) => m.registerTauriWebSocketTransport()) : () => Promise.resolve();
  void register()
    .catch((err) => console.warn("[studio] the native debug-link listener didn't register:", err))
    .then(() => {
      if (stopped) return;
      const link = new EditorDebugLink({
        name: "Audio Studio",
        // The desktop Studio's listener also answers the rendezvous at `/myco-rendezvous` (ADR 0403).
        transport: () => (transportCanListen("websocket") ? listeningTransport(createTransport("websocket")) : null),
      });
      linkSignal.value = link;
      dispose = effect(() => void link.apply(cleanPreferences(studioDebugLinkPreferences.value)));
    });
  return () => {
    stopped = true;
    dispose?.();
    linkSignal.peek()?.stop();
    linkSignal.value = null;
  };
}
