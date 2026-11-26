// The editor's Play as a build on the debug link (ADR 0403, plan U3): while the editor plays, a tool (the Audio Studio,
// another editor) can pair with it and read its topics (audio takes and captures, animation) as it would a running
// game. The builds menu shows the code to type and the paired tools (its `playSlot`: `PlayBuildSlot`).
//
// **How tools reach Play: its own listener (design choice (b) of plan U3).** Play starts a `startBuildListener` of its
// own on the play Engine, on the first free port from the editor's port + 1 (7791..7799 by default; the editor's own
// listener keeps 7790), on the LAN when the editor's preferences listen there. The other choice, (a), was to let the
// editor's `DebugLinkListener` take tool-role `pair`s too and hand them a session on the play Engine (one port). The
// engine's listener can't: it answers every tool-role pair with a `role` refusal and has no option to hand such a
// connection on, so (a) needs a change in `src/engine/debugLink/client.ts`, not this task's. A listener of its own also
// keeps Play exactly what a listening build is (`BuildListener`: its token gate, codes and sessions), so a tool can't
// tell Play from an exported game.
//
// The listener runs on the play Engine's frames (a paused Play answers nothing until it resumes, as a paused game
// would) and closes with it. The code changes after each pairing and each expiry, so the signals here are refreshed at
// each frame's end. A tokenless tool from another machine is refused with `no-token` unless a `prompt` is given: on the
// LAN a tool types the code (the editor's accept prompt is for builds, not tools).
//
// C7 (plan §8): U3 fills it and wires it into `EditorDebugLink` (`servePlay`).
import { signal, type ReadonlySignal } from "@preact/signals";
import { h as el } from "preact";
import type { Engine } from "../../engine/core/Engine";
import { DEFAULT_DEBUG_LINK_PORT } from "../../engine/debugLink/config";
import { startBuildListener, type BuildListener, type ConnectedTool, type ToolAtTheDoor } from "../../engine/debugLink/host";
import type { NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";
import { isLocalRemote, remoteHost } from "./debugLinkLogic";

/** Where serving Play stands. */
export type PlayBuildState =
  | { readonly kind: "starting" }
  | { readonly kind: "serving"; readonly address: string; readonly lan: boolean }
  | { readonly kind: "unavailable"; readonly why: string }
  | { readonly kind: "stopped" };

/** The play session as a build, while it lasts. */
export interface PlayBuild {
  /** The code a tool types to pair with this Play (null: no LAN code; same-machine tools need none). */
  readonly code: ReadonlySignal<string | null>;
  /** Tools paired with this Play. */
  readonly tools: ReadonlySignal<readonly ConnectedTool[]>;
  /** Whether it listens yet, where, or why it can't. */
  readonly state: ReadonlySignal<PlayBuildState>;
  /** Ends it (Play stopped): the tools' sessions close. */
  stop(): void;
}

/** How Play listens (the editor's link passes its preferences; tests a loopback transport). */
export interface PlayBuildOptions {
  /**
   * The listening transport's name (default `websocket`), or null when this host can't listen (a plain browser page):
   * the build is then `unavailable`.
   */
  readonly transport?: string | null;
  /** Extra transport options (the loopback's clock in tests). */
  readonly transportOptions?: Readonly<Record<string, unknown>>;
  /** Listen on every interface, so tools on other machines can pair with the code (default false). */
  readonly lan?: boolean;
  /** The first port to try; the next nine follow (default 7791: the editor's own listener has 7790). */
  readonly port?: number;
  /** This machine's network addresses, for the LAN code (`BuildListenerOptions.interfaces`). */
  readonly interfaces?: () => readonly NetworkInterfaceAddress[];
  /** Whether a remote is this machine (`BuildListenerOptions.sameMachine`). */
  readonly sameMachine?: (remote: string) => boolean;
  /** Asks about a tokenless tool from another machine; absent, it's refused (`BuildListenerOptions.prompt`). */
  readonly prompt?: (tool: ToolAtTheDoor) => Promise<boolean>;
  /** The token gate's clock and random source (tests). */
  readonly now?: () => number;
  readonly randomToken?: (bits: number) => number;
  /** Where the listener's messages go (default `console.warn`). */
  readonly log?: (line: string) => void;
}

const sameTools = (a: readonly ConnectedTool[], b: readonly ConnectedTool[]) =>
  a.length === b.length && a.every((t, i) => t.name === b[i]!.name && t.kind === b[i]!.kind && t.remote === b[i]!.remote);

/** Starts serving `engine` (the play Engine) as build `name`. */
export function servePlayBuild(engine: Engine, name: string, options: PlayBuildOptions = {}): PlayBuild {
  const code = signal<string | null>(null);
  const tools = signal<readonly ConnectedTool[]>([]);
  const state = signal<PlayBuildState>({ kind: "starting" });
  let listener: BuildListener | null = null;
  let removeHook: (() => void) | null = null;
  let stopped = false;

  const refresh = () => {
    if (!listener) return;
    code.value = listener.code;
    const now = listener.tools;
    if (!sameTools(now, tools.peek())) tools.value = now;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeHook?.();
    removeHook = null;
    listener?.close();
    listener = null;
    code.value = null;
    tools.value = [];
    state.value = { kind: "stopped" };
  };

  if (options.transport === null) {
    state.value = { kind: "unavailable", why: "Play can't be paired with here: a browser page can't open a server socket. The desktop editor can." };
  } else {
    const lines: string[] = [];
    const log = options.log ?? ((line: string) => console.warn(line));
    void startBuildListener(engine, {
      debug: { listen: true, lan: options.lan === true, port: options.port ?? DEFAULT_DEBUG_LINK_PORT + 1 },
      name,
      platform: "editor",
      transport: options.transport ?? "websocket",
      transportOptions: options.transportOptions,
      interfaces: options.interfaces,
      sameMachine: options.sameMachine,
      prompt: options.prompt,
      now: options.now,
      randomToken: options.randomToken,
      log: (line) => {
        lines.push(line);
        log(line);
      },
    }).then(
      (made) => {
        if (stopped) return made?.close();
        if (!made) {
          state.value = { kind: "unavailable", why: lines.at(-1)?.replace(/^\[myco\] debug link: /, "") ?? "Play couldn't listen for tools." };
          return;
        }
        listener = made;
        removeHook = engine._addFrameHook({ end: refresh, dispose: stop }); // the Engine's end closes the listener too
        state.value = { kind: "serving", address: made.address, lan: made.lan };
        refresh();
      },
      (err) => {
        if (!stopped) state.value = { kind: "unavailable", why: `Play couldn't listen for tools (${(err as Error)?.message ?? err}).` };
      },
    );
  }

  return { code, tools, state, stop };
}

/** A tool's line in the slot: its name, then where it runs when it isn't this machine. */
function toolLabel(t: ConnectedTool): string {
  return isLocalRemote(t.remote) ? t.name : `${t.name} (${remoteHost(t.remote)})`;
}

/** What the slot says about serving Play. */
function stateText(build: PlayBuild): string {
  const s = build.state.value;
  if (s.kind === "starting") return "Opening Play to tools…";
  if (s.kind === "unavailable") return s.why;
  if (s.kind === "stopped") return "Play is closed to tools.";
  const where = s.address.replace("127.0.0.1", "localhost").replace("0.0.0.0", "localhost").replace(/^ws:\/\//, "").replace(/\/.*$/, "");
  const c = build.code.value;
  if (c) return `Play is open to tools: pair with code ${c} (tools on this machine connect to ${where}).`;
  return `Play is open to tools on this machine at ${where}.`;
}

/**
 * The builds menu's `playSlot` (C7): while the editor plays, Play's code and the tools paired with it; nothing when
 * `build` is null. Mount it as `playSlot={<PlayBuildSlot build={editorDebugLink().play.value} />}`.
 */
export function PlayBuildSlot({ build }: { readonly build: PlayBuild | null }) {
  if (!build) return null;
  const tools = build.tools.value;
  return el(
    "div",
    { class: "debug-link-play", "aria-label": "Play as a build" },
    el("div", { class: "debug-link-state" }, stateText(build)),
    ...tools.map((t) => el("div", { key: `${t.remote}\n${t.name}`, class: "debug-link-row" }, `Paired: ${toolLabel(t)}`)),
    el("div", { class: "debug-link-separator", role: "separator" }),
  );
}
