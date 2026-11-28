// The live debugger's source over a build connected through the debug link (ADR 0376; the animation topic, T60): the
// graph editor's overlay, live parameters and recorder read a running build's Animators as they read the play session's
// (`localSource.ts`). The link is asynchronous and the source's interface isn't, so it keeps what it last heard:
//
// - **targets** from the topic's `targets` request, asked again at most every `refreshMs` while the debugger reads them;
// - **frames** from one subscription at a time (the Animator the debugger shows, as the local recorder follows one),
//   every frame the build recorded, kept for the recording's seconds on the build's clock;
// - **parameter edits** as `set` commands, which the build applies at its next frame start.
//
// A build is never paused from here, so recorded poses aren't shown on its character (`show` refuses); the recording
// still scrubs the overlay through the frames received.
import type { CompiledAnimGraph } from "../../../../engine/animation/graphCompile";
import type { DebugLinkPeer, PeerSubscription } from "../../../../engine/debugLink/client";
import type { AnimatorDebugFrame, DebugParamValue } from "../../runtime/features/debug/frame";
import { ANIM_FRAME, decodeFrameRecord } from "../../runtime/features/debug/frameRecord";
import type { AnimationDebugSource, DebugRecording, DebugTarget } from "./source";
import { normalizeAssetPath } from "../../../../engine/scene/assetPath";

/** The topic's name. */
export const ANIMATION_TOPIC = "animation";

/** @internal What the link source reads of a connected build. */
export interface LinkBuild {
  /** The build's name, shown as the source's. */
  readonly name: string;
  readonly peer: DebugLinkPeer;
}

/** @internal The link source; `dispose` ends its subscription. */
export interface LinkDebugSource extends AnimationDebugSource {
  dispose(): void;
}

export interface LinkSourceOptions {
  /** Seconds of frames kept (default 10). */
  readonly seconds?: number;
  /** Milliseconds between `targets` requests (default 500). */
  readonly refreshMs?: number;
  /** Milliseconds clock (default `performance.now()`). */
  readonly now?: () => number;
}

/** @internal A source over `build`'s animation topic. */
export function createLinkSource(build: LinkBuild, options: LinkSourceOptions = {}): LinkDebugSource {
  const now = options.now ?? (() => performance.now());
  const refreshMs = options.refreshMs ?? 500;
  let seconds = Math.max(1, options.seconds ?? 10);
  let targets: DebugTarget[] = [];
  let asked = -Infinity;
  let asking = false;
  let followed: { id: string; sub: PeerSubscription; frames: AnimatorDebugFrame[] } | null = null;
  let disposed = false;

  const refresh = () => {
    if (disposed || asking || build.peer.state !== "accepted" || now() - asked < refreshMs) return;
    asking = true;
    asked = now();
    build.peer.request(ANIMATION_TOPIC, "targets").then(
      (value) => {
        asking = false;
        if (!disposed) targets = readTargets(value);
      },
      () => {
        asking = false;
      },
    );
  };

  const follow = (id: string) => {
    if (followed?.id === id) return followed;
    followed?.sub.unsubscribe();
    const frames: AnimatorDebugFrame[] = [];
    const sub = build.peer.subscribe(ANIMATION_TOPIC, { target: id }, (records) => {
      for (const r of records) {
        if (r.type !== ANIM_FRAME) continue;
        const read = decodeFrameRecord(r.payload);
        if ("frame" in read) frames.push(read.frame);
      }
      const newest = frames.at(-1);
      if (!newest) return;
      let drop = 0;
      while (drop < frames.length - 1 && newest.time - frames[drop]!.time > seconds + 1e-9) drop++;
      if (drop) frames.splice(0, drop);
    });
    followed = { id, sub, frames };
    return followed;
  };

  const source: LinkDebugSource = {
    get name() {
      return build.name;
    },
    get live() {
      return !disposed && build.peer.state === "accepted";
    },
    paused: false,
    targets(graph) {
      refresh();
      return graph === undefined ? targets : targets.filter((t) => t.graph === normalizeAssetPath(graph));
    },
    selected: () => null,
    frame(id) {
      if (disposed || build.peer.state !== "accepted") return null;
      return follow(id).frames.at(-1) ?? null;
    },
    recording(id) {
      if (disposed || build.peer.state !== "accepted") return null;
      const f = follow(id);
      const view: DebugRecording = {
        get frames() {
          return f.frames;
        },
        get seconds() {
          return seconds;
        },
        set seconds(s: number) {
          if (Number.isFinite(s)) seconds = Math.max(1, s);
        },
        isKeyframe: () => false,
        show: (index) => index === null,
        showing: null,
      };
      return view;
    },
    set(id, parameter, value: DebugParamValue) {
      if (!targets.some((t) => t.id === id)) return false;
      return build.peer.command(ANIMATION_TOPIC, "set", { target: id, parameter, value });
    },
    redraw: () => {},
    dispose() {
      disposed = true;
      followed?.sub.unsubscribe();
      followed = null;
    },
  };
  return source;
}

/** The `targets` reply read leniently: entries without an id, label, graph and tables are left out. */
function readTargets(value: unknown): DebugTarget[] {
  if (!Array.isArray(value)) return [];
  const out: DebugTarget[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.label !== "string" || typeof t.graph !== "string" || !t.tables || typeof t.tables !== "object") continue;
    out.push({ id: t.id, label: t.label, graph: t.graph, tables: t.tables as CompiledAnimGraph });
  }
  return out;
}
