// The Audio Studio's debug link (ADR 0380, plan U4): the Studio listens (the desktop app, through the shared Tauri
// commands crate) and connects out by code (everywhere), with the editor's link class (`EditorDebugLink`), accept
// prompt, builds menu and Connect dialog. The Profiler (U5), Take (U5) and Mixer (U8) screens read the build chosen
// here and talk to it through its `DebugLinkPeer` (the `audio` topic).
//
// C7 (plan §8): the signal U5 and U8 read is declared now; U4 fills `startStudioDebugLink`.
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import type { ConnectedBuild, EditorDebugLink } from "../../editor/debugLink/editorLink";

const linkSignal = signal<EditorDebugLink | null>(null);

/** The Studio's link once started (null before `startStudioDebugLink`, and in tests that don't start it). */
export const studioLink: ReadonlySignal<EditorDebugLink | null> = linkSignal;

/** The build the Studio's screens read: the link's active build, or null (the Studio's own runtime then). */
export const studioBuild: ReadonlySignal<ConnectedBuild | null> = computed(() => linkSignal.value?.active.value ?? null);

/** Starts the Studio's link (listening as its preferences say); returns the stop. C7 stub: U4 fills it and sets `linkSignal`. */
export function startStudioDebugLink(): () => void {
  void linkSignal;
  throw new Error("U4: not implemented");
}
