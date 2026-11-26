// The Profiler following a connected build (ADR 0403, plan U5): a `LiveHost` whose recording is the build's live capture,
// followed through the audio link client (ADR 0417, `plugins/audio/editor/debugLink/audioLinkClient.ts`). The build joins
// its own ring as an owner and sends the ring's head, then each sealed segment; the client puts their pieces back
// together, `join()` resolves once the head is whole, and each segment is posted to the live view as an `appendSegment`, exactly
// as the recorder posts them to the editor's live follow (`LiveFollow`, `editor/mix/liveFollow.ts`), so the capture
// Worker reads a build's feed and the Studio's own the same way.
//
// The feed ends, with a message the Profiler shows, when the build sends `captureLost` (its ring evicted a segment before
// it went out), refuses the subscription, sends a piece out of order, or the link closes (the wiring calls
// `linkClosed`; a closed peer is also noticed on the next quiet check). When Play stops on the build the feed just stops,
// with nothing sent (the plan log, W1a): after `stallMs` with no segment the follow says so, and clears it if segments
// come again. A `BuildFollow` is the Profiler's live view of one build: the host, a `LiveFollow` and the store.
import { signal } from "@preact/signals";
import type { ConnectedBuild } from "../../../editor/debugLink/editorLink";
import { audioLinkClient, type AudioLinkClient, type CaptureFollowEnd } from "../../../plugins/audio/editor/debugLink/audioLinkClient";
import { LiveFollow, type LiveFollowOptions, type LiveHost, type LiveRecording, type LiveScheduler } from "../../../plugins/audio/editor/mix/liveFollow";
import type { ProfileSource } from "../../../plugins/audio/editor/mix/profilerSource";
import type { CaptureWorkerRequest } from "../../../plugins/audio/runtime/capture/format";
import type { ProfilerStore } from "./profilerStore";

/** The build a Profiler follows: its name and its link (`studioBuild`'s `ConnectedBuild`), and its audio link client if it has one. */
export type FollowedBuild = Pick<ConnectedBuild, "name" | "peer"> & { readonly client?: AudioLinkClient };

/** How long without a segment before the follow says the build went quiet (segments seal about once a second). */
const STALL_MS = 3000;

export interface RemoteLiveOptions {
  /** Timers for the quiet check (default: the global timers). */
  readonly scheduler?: LiveScheduler;
  /** Milliseconds without a segment before `onStalled` (default 3000). */
  readonly stallMs?: number;
  /** The feed ended for good, and why (once). */
  onEnded?(message: string): void;
  /** The feed went quiet (a message), or came back (null). */
  onStalled?(message: string | null): void;
}

/** A build's live capture as a `LiveHost`. */
export interface RemoteLiveHost extends LiveHost {
  /** The link to the build closed: the feed ends with `reason`. */
  linkClosed(reason?: string): void;
}

const GLOBAL_SCHEDULER: LiveScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** `build`'s live capture feed as the Profiler's `LiveHost`: one subscription per `join()`. */
export function remoteLiveHost(build: FollowedBuild, opts: RemoteLiveOptions = {}): RemoteLiveHost {
  const scheduler = opts.scheduler ?? GLOBAL_SCHEDULER;
  const stallMs = opts.stallMs ?? STALL_MS;
  const client = build.client ?? audioLinkClient(build.peer);
  /** The recording now (one at a time: `LiveFollow` joins once per start). */
  let current: { end(message: string): void } | null = null;

  return {
    linkClosed(reason) {
      current?.end(`The link to ${build.name} closed${reason ? ` (${reason})` : ""}; the live view stopped here.`);
    },

    join(): Promise<LiveRecording> {
      if (build.peer.state === "closed") return Promise.reject(new Error(`${build.name} is gone (${build.peer.closedReason || "the link closed"}).`));
      return new Promise<LiveRecording>((resolve, reject) => {
        let head: Uint8Array | null = null;
        let post: ((request: CaptureWorkerRequest, transfer: Transferable[]) => void) | null = null;
        /** Segments that arrived before `startLive`. */
        const early: { id: number; bytes: Uint8Array }[] = [];
        let lost = false;
        let released = false;
        let quiet: unknown = null;
        let stalled = false;

        const clearQuiet = (): void => {
          if (quiet !== null) scheduler.clearTimeout(quiet);
          quiet = null;
        };
        const armQuiet = (): void => {
          clearQuiet();
          if (lost || released) return;
          quiet = scheduler.setTimeout(() => {
            quiet = null;
            if (build.peer.state === "closed") return end(`The link to ${build.name} closed (${build.peer.closedReason || "it went away"}); the live view stopped here.`);
            if (!stalled) {
              stalled = true;
              opts.onStalled?.(`Nothing from ${build.name} for ${Math.round(stallMs / 1000)} s: its Play may have stopped.`);
            }
            armQuiet(); // keep checking for a closed link while it stays quiet
          }, stallMs);
        };

        const end = (message: string): void => {
          if (lost || released) return;
          lost = true;
          clearQuiet();
          unfollow?.();
          if (current === me) current = null;
          if (!head) reject(new Error(message));
          opts.onEnded?.(message);
        };
        const me = { end };
        current = me;

        const deliver = (id: number, bytes: Uint8Array): void => {
          if (!post) {
            early.push({ id, bytes });
            return;
          }
          const buffer = bytes.buffer as ArrayBuffer;
          post({ type: "appendSegment", id, bytes: buffer }, [buffer]);
        };

        const heard = (): void => {
          if (stalled) {
            stalled = false;
            opts.onStalled?.(null);
          }
          armQuiet();
        };
        const endedWith = (e: CaptureFollowEnd): string => {
          switch (e.kind) {
            case "lost":
              return `${build.name}'s capture ring dropped a segment before it was sent, so the live view stopped here (the build goes on recording).`;
            case "refused":
              return `${build.name} refused the live capture: ${e.reason}`;
            case "closed":
              return `The link to ${build.name} closed (${e.reason}); the live view stopped here.`;
            case "broken":
              return `The live capture from ${build.name} broke: ${e.reason}.`;
          }
        };

        const recording: LiveRecording = {
          head: () => head!.slice(),
          startLive(o) {
            post = o.post;
            for (const s of early.splice(0)) deliver(s.id, s.bytes);
          },
          stopLive() {
            post = null;
          },
          get liveLost() {
            return lost;
          },
          release() {
            if (released) return;
            released = true;
            post = null;
            clearQuiet();
            if (current === me) current = null;
            unfollow?.();
          },
        };

        let unfollow: (() => void) | null = null;
        unfollow = client.followCapture({
          head(bytes) {
            if (lost || released) return;
            heard();
            head = bytes;
            resolve(recording);
          },
          segment(id, bytes) {
            if (lost || released) return;
            heard();
            deliver(id, bytes);
          },
          ended: (e) => end(endedWith(e)),
        });
        armQuiet();
      });
    },
  };
}

export type BuildFollowState =
  | { readonly kind: "idle" }
  /** Subscribed, waiting for the head. */
  | { readonly kind: "starting" }
  /** The live view grows; `stalled` says the build went quiet. */
  | { readonly kind: "following"; readonly stalled: string | null }
  /** The feed ended: the view keeps what came. */
  | { readonly kind: "ended"; readonly message: string };

export interface BuildFollowSeams {
  readonly store: Pick<ProfilerStore, "openLive" | "refreshLive" | "close">;
  /** `LiveFollow` options (tests: its scheduler and the source's Worker). */
  readonly liveOptions?: Partial<Omit<LiveFollowOptions, "host" | "onUpdate">>;
  /** The quiet check's options. */
  readonly remote?: Pick<RemoteLiveOptions, "scheduler" | "stallMs">;
}

/** The Profiler's live view of a connected build: Follow opens its capture feed on the timeline, Stop ends the hold. */
export class BuildFollow {
  readonly state = signal<BuildFollowState>({ kind: "idle" });
  private follow: LiveFollow | null = null;
  private host: RemoteLiveHost | null = null;
  private shown: ProfileSource | null = null;

  constructor(
    readonly build: FollowedBuild,
    private readonly seams: BuildFollowSeams,
  ) {}

  get following(): boolean {
    const k = this.state.peek().kind;
    return k === "starting" || k === "following";
  }

  /** Follow the build: subscribe to its capture feed and show it live. Again while following does nothing. */
  async start(): Promise<void> {
    if (this.following) return;
    this.release(false);
    this.state.value = { kind: "starting" };
    const host = (this.host = remoteLiveHost(this.build, {
      ...this.seams.remote,
      onEnded: (message) => {
        if (this.host !== host) return;
        this.state.value = { kind: "ended", message };
        this.follow?.notify();
      },
      onStalled: (message) => {
        if (this.host !== host || this.state.peek().kind !== "following") return;
        this.state.value = { kind: "following", stalled: message };
      },
    }));
    const follow = (this.follow = new LiveFollow({
      ...this.seams.liveOptions,
      host,
      onUpdate: (m) => {
        if (this.follow !== follow) return;
        if (m.state === "error" && this.state.peek().kind !== "ended") this.state.value = { kind: "ended", message: m.error ?? `The live capture from ${this.build.name} failed.` };
        if (!m.source) return;
        if (this.state.peek().kind === "starting") this.state.value = { kind: "following", stalled: null };
        if (m.source !== this.shown) {
          this.shown = m.source;
          void this.seams.store.openLive(m.source, `Live from ${this.build.name}`);
        } else void this.seams.store.refreshLive();
      },
    }));
    await follow.start();
    if (this.follow === follow && follow.current.state === "following" && this.state.peek().kind === "starting") this.state.value = { kind: "following", stalled: null };
  }

  /** Stop following: the subscription ends and the live view closes. */
  stop(): void {
    this.release(true);
    this.state.value = { kind: "idle" };
  }

  toggle(): Promise<void> {
    if (this.following) {
      this.stop();
      return Promise.resolve();
    }
    return this.start();
  }

  /** The link to the build closed (it left `studioBuild`): a running follow ends with why; the view keeps what came. */
  linkClosed(reason?: string): void {
    this.host?.linkClosed(reason);
  }

  /** The screen went away or another build was chosen: stop, and close the live view if it shows this build. */
  dispose(): void {
    this.release(true);
  }

  private release(closeView: boolean): void {
    this.follow?.stop();
    this.follow = null;
    this.host = null;
    if (closeView && this.shown) this.seams.store.close();
    this.shown = null;
  }
}

/** What the player bar's status says of a build follow (null: nothing to say). */
export function buildFollowStatus(state: BuildFollowState, name: string): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "starting":
      return `Joining ${name}'s capture…`;
    case "following":
      return state.stalled ?? `● Live from ${name}`;
    case "ended":
      return state.message;
  }
}
