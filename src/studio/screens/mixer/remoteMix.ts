// The Mixer editing a connected build's mix (ADR 0403, plan U8): while the Studio's `studioBuild` names a build, each
// edit of `audio.json` is also sent as `mix.op` commands (the op plus the name and bus tables it references) through
// the build's audio link client (ADR 0417, `mixOp`); the build applies them at its next frame start through
// its live mixer. The Studio's own runtime still gets the edit (the file stays the source of truth, and the build's mix
// follows it). A command is fire-and-forget: the build's refusal comes back as an unsolicited error, which `report`
// shows. With no build connected, nothing is sent.
import type { ConnectedBuild } from "../../../editor/debugLink/editorLink";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { MixOp } from "../../../engine/audio/mixOps";
import { audioLinkClient } from "../../../plugins/audio/editor/debugLink/audioLinkClient";
import { liveOps } from "./liveMix";

export interface RemoteMixOptions {
  /** The build the Studio's screens read (`studioBuild.value`), or null. Read at each edit. */
  build(): ConnectedBuild | null;
  /** A refusal or a note for the Mixer's status bar. */
  report(kind: "error" | "info", text: string): void;
}

export interface RemoteMix {
  /** The file moved from `before` to `after`: send its ops to the connected build. The number of ops sent (0 with no build). */
  changed(before: AudioProject, after: AudioProject): number;
  /** Sends ops as they are (the audio topic's `mix.op`). The number sent. */
  send(ops: readonly MixOp[]): number;
  dispose(): void;
}

export function createRemoteMix(options: RemoteMixOptions): RemoteMix {
  const listening = new Set<ConnectedBuild["peer"]>();
  const hear = (build: ConnectedBuild) => {
    if (listening.has(build.peer)) return;
    listening.add(build.peer);
    build.peer.onError = (message) => options.report("error", `${build.name} refused the change: ${message}`);
  };
  const send = (ops: readonly MixOp[]): number => {
    const build = options.build();
    if (!build || ops.length === 0) return 0;
    hear(build);
    const client = audioLinkClient(build.peer);
    let sent = 0;
    for (const op of ops) {
      let ok: boolean;
      try {
        ok = client.mixOp(op);
      } catch (err) {
        options.report("error", `Can't send this change to ${build.name}: ${(err as Error).message}`);
        continue;
      }
      if (ok) sent++;
      else options.report("error", `${build.name} isn't connected any more; the change was not sent.`);
    }
    return sent;
  };
  return {
    changed: (before, after) => send(liveOps(before, after).ops),
    send,
    dispose() {
      for (const peer of listening) peer.onError = null;
      listening.clear();
    },
  };
}
