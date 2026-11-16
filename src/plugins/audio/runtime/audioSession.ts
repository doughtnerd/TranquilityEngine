// ADR 0218: the audio runtime's page state ends with the Engines that used it. The editor's Engine going (a project closed
// or switched), or a game's Engine going with no editor Engine alive (an exported game exits), **releases** the audio
// session: every listener forgets what it held for the project that just went (the capture's ring and take, the event
// runtime's instances, groups, curves and parameters, the music players and their groups, the files' loop points, the
// warn-once keys, the core fallback's warning). The editor's per-Play runtime Engine going is a Play stop instead, which
// keeps the session. The rule was the capture's (ADR 0171/0172 record change 33); this file is its one copy.
import { onEngineLifecycle } from "../../../engine/core/engineLifecycle";

const listeners: (() => void)[] = [];
let editorEngines = 0;

onEngineLifecycle((event, kind) => {
  if (kind === "editor") editorEngines = Math.max(0, editorEngines + (event === "created" ? 1 : -1));
  if (event !== "disposed") return;
  if (kind === "editor" || (kind === "runtime" && editorEngines === 0)) releaseAudioSession();
});

/** @internal Runs `listener` each time the audio session is released, in the order listeners were added. Returns the removal. */
export function onAudioSessionReleased(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Tells every listener; one that throws is logged and doesn't stop the others. */
function releaseAudioSession(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[myco] audio: a session release listener failed:", err);
    }
  }
}
