// The editor's Play as a build on the debug link (ADR 0380, plan U3): while the editor plays, a tool (the Audio Studio,
// another editor) can pair with it and read its topics (audio takes and captures, animation) as it would a running
// game. The editor's own listener accepts tool-role peers for the play Engine; the builds menu shows the code to type
// (its `playSlot`).
//
// C7 (plan §8): U3 fills it and wires it into `EditorDebugLink` (`servePlay`).
import type { ReadonlySignal } from "@preact/signals";
import type { Engine } from "../../engine/core/Engine";
import type { ConnectedTool } from "../../engine/debugLink/host";

/** The play session as a build, while it lasts. */
export interface PlayBuild {
  /** The code a tool types to pair with this Play (null: no LAN code; same-machine tools need none). */
  readonly code: ReadonlySignal<string | null>;
  /** Tools paired with this Play. */
  readonly tools: ReadonlySignal<readonly ConnectedTool[]>;
  /** Ends it (Play stopped): the tools' sessions close. */
  stop(): void;
}

/** Starts serving `engine` (the play Engine) as build `name`. */
export function servePlayBuild(engine: Engine, name: string): PlayBuild {
  void engine;
  void name;
  throw new Error("U3: not implemented");
}
