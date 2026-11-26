// The editor's one debug link (ADR 0376) and its preferences (Settings > General > Debug link): listening on by default
// on this machine only; the LAN off by default. `startEditorDebugLink` (called once by `main.tsx`) listens and follows
// the preferences; plugins read the connected builds through the SDK's `editorDebugLink()`.
import { effect } from "@preact/signals";
import { createTransport, transportCanListen } from "../../engine/net/Transport";
import "../../engine/net/transport/websocket";
import { listeningTransport } from "../../engine/debugLink/rendezvous/nativeHost";
import { logMessage } from "../messages";
import { persisted } from "../preferences";
import { DEFAULT_DEBUG_LINK_PREFERENCES, cleanPreferences, type DebugLinkPreferences } from "./debugLinkLogic";
import { currentProject, playing } from "../state";
import { EditorDebugLink } from "./editorLink";

/** The debug link preferences (per user). */
export const debugLinkPreferences = persisted<DebugLinkPreferences>("myco.editor.debugLink", DEFAULT_DEBUG_LINK_PREFERENCES);

let link: EditorDebugLink | null = null;

/** The editor's debug link: the connected builds, the pending ones, the build the debuggers read. */
export function editorDebugLink(): EditorDebugLink {
  // The WebSocket transport listens where this host can open a server socket: Node, and the desktop editor, whose
  // `main.tsx` registers the native-backed transport (`tauriListener.ts`, ADR 0379) first. A plain browser page can't,
  // and Preferences say so.
  return (link ??= new EditorDebugLink({
    // The desktop editor's listener also answers the rendezvous at `/myco-rendezvous` (ADR 0403), so pages and tools on
    // the LAN can pair through it.
    transport: () => (transportCanListen("websocket") ? listeningTransport(createTransport("websocket")) : null),
    playTransport: transportCanListen("websocket") ? "websocket" : null,
    log: logMessage,
  }));
}

/**
 * Listens as the preferences say, and again whenever they change; serves the editor's Play as a build while it runs
 * (ADR 0403, U3: a tool pairs with Play as with a game); returns the stop.
 */
export function startEditorDebugLink(): () => void {
  const l = editorDebugLink();
  const dispose = effect(() => void l.apply(cleanPreferences(debugLinkPreferences.value)));
  const disposePlay = effect(() => {
    const play = playing.value;
    if (!play) return;
    const served = l.servePlay(play.engine, `${currentProject.peek()?.name ?? "Game"} (editor Play)`);
    return () => served.stop();
  });
  return () => {
    disposePlay();
    dispose();
    l.stop();
  };
}
