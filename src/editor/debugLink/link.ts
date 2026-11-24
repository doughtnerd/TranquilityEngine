// The editor's one debug link (ADR 0376) and its preferences (Settings > General > Debug link): listening on by default
// on this machine only; the LAN off by default. `startEditorDebugLink` (called once by `main.tsx`) listens and follows
// the preferences; plugins read the connected builds through the SDK's `editorDebugLink()`.
import { effect } from "@preact/signals";
import { createTransport, transportCanListen } from "../../engine/net/Transport";
import "../../engine/net/transport/websocket";
import { logMessage } from "../messages";
import { persisted } from "../preferences";
import { DEFAULT_DEBUG_LINK_PREFERENCES, cleanPreferences, type DebugLinkPreferences } from "./debugLinkLogic";
import { EditorDebugLink } from "./editorLink";

/** The debug link preferences (per user). */
export const debugLinkPreferences = persisted<DebugLinkPreferences>("myco.editor.debugLink", DEFAULT_DEBUG_LINK_PREFERENCES);

let link: EditorDebugLink | null = null;

/** The editor's debug link: the connected builds, the pending ones, the build the debuggers read. */
export function editorDebugLink(): EditorDebugLink {
  // The WebSocket transport listens where this host can open a server socket: Node, and the desktop editor, whose
  // `main.tsx` registers the native-backed transport (`tauriListener.ts`, ADR 0379) first. A plain browser page can't,
  // and Preferences say so.
  return (link ??= new EditorDebugLink({ transport: () => (transportCanListen("websocket") ? createTransport("websocket") : null), log: logMessage }));
}

/** Listens as the preferences say, and again whenever they change; returns the stop. */
export function startEditorDebugLink(): () => void {
  const l = editorDebugLink();
  const dispose = effect(() => void l.apply(cleanPreferences(debugLinkPreferences.value)));
  return () => {
    dispose();
    l.stop();
  };
}
