// The build session (ADR 0417): everything the Studio does with one connected game build, made when the build connects
// and disposed when it leaves or another is chosen, by the one effect on `studioBuild` (`installBuildSession`). It owns
// the build's audio link client (`plugins/audio/editor/debugLink/audioLinkClient.ts`) and, through it:
//
// - the take recorder (`BuildTakeRecorder`, ADR 0403/0408): Start, Mark, Stop and Save, and the build's take followed
//   (a take F10 or the game's script starts shows as recording; one it stops is saved where the Studio keeps takes);
// - the live take (ADR 0408): the take recording on the build as it grows, for the Take screen;
// - the capture follow (`BuildFollow`, ADR 0408): the Profiler is live while a build is connected, on every screen;
// - the take picture width (ADR 0411): the preference, sent on connect and whenever it changes;
// - the recording clock: one recording state for the player bar, the Take screen and the Profiler (idle, recording
//   since a time, or ended once the link to the build has).
//
// The Take and Profiler screens read it: `takeOnShow` says whether they show the build live or a file (ADR 0408: always
// live while connected; one recording for both screens). On dispose it hands the last take it saved to the project's
// recordings (`keep`, `shell/projectRecordings.ts`, ADR 0412), so the recording just made stays on screen once the build
// leaves. A session whose link ended stays as `buildSession` (ended) until another build connects: its recorder's
// failure and its follow's end say why.
import { computed, effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import type { ConnectedBuild } from "../../editor/debugLink/editorLink";
import { audioLinkClient, type AudioLinkClient, type LiveTakeFollowOptions, type LiveTakeSnapshot } from "../../plugins/audio/editor/debugLink/audioLinkClient";
import { BuildFollow, type BuildFollowSeams } from "../screens/profiler/remoteLiveHost";
import { BuildTakeRecorder, type BuildTakeSeams } from "../screens/take/recordFromBuild";
import { takePictureWidth, takePictureWidthOf, type TakePictureWidthResult } from "./takePictures";

/** A connected build, as far as a session needs it (`studioBuild`'s `ConnectedBuild`). */
export type SessionBuild = Pick<ConnectedBuild, "name" | "peer">;

/** The connected build's take as it stands (the live take). */
export interface LiveTake extends LiveTakeSnapshot {
  /** The build it records on (its name). */
  readonly build: string;
}

/** The build's recording: none running, one running since `since` (`Date.now()`), or the link to the build ended. */
export type RecordingState =
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly since: number }
  /** The link ended (the build left or another was chosen); `reason` is the link's when it closed. */
  | { readonly kind: "ended"; readonly reason: string | null };

/** What the Take screen and the Profiler show: the build live (its take, null before the first), or a file. */
export type TakeOnShow = { readonly kind: "live"; readonly build: string; readonly take: LiveTake | null } | { readonly kind: "file" };

export interface BuildSessionSeams {
  /** The take recorder's seams (where takes are written, whether a stopped take saves at once, …). */
  readonly recorder: Omit<BuildTakeSeams, "pictureWidth">;
  /** The capture follow's seams (the Profiler's store; tests: the Worker and timers). */
  readonly follow: BuildFollowSeams;
  /** The take picture width preference (any value, read through `takePictureWidthOf`; default `takePictureWidth`). */
  readonly pictureWidth?: ReadonlySignal<unknown>;
  /** The live take follow's options. */
  readonly liveTake?: LiveTakeFollowOptions;
  /** The clock of `recording.since` (default `Date.now`). */
  readonly now?: () => number;
  /** The session ended: the last take it saved, to keep on screen (ADR 0412). Also called for a save that ends after. */
  readonly keep?: (path: string) => void;
}

const FILE: TakeOnShow = { kind: "file" };

/** One connected build's session. */
export class BuildSession {
  readonly client: AudioLinkClient;
  readonly recorder: BuildTakeRecorder;
  readonly follow: BuildFollow;
  /** The build's recording (ended once the session is disposed). */
  readonly recording: ReadonlySignal<RecordingState>;
  /** The live take: the take recording on the build (or its last one), null before the first. */
  readonly liveTake: ReadonlySignal<LiveTake | null>;
  /** What the Take screen and the Profiler show: the build live while the session is open, then a file. */
  readonly show: ReadonlySignal<TakeOnShow>;
  /** What the build answered the last time the take picture width was sent; null before. */
  readonly pictureWidth: ReadonlySignal<TakePictureWidthResult | null>;

  private readonly ended = signal<{ reason: string | null } | null>(null);
  private readonly since = signal<number | null>(null);
  private readonly live = signal<LiveTake | null>(null);
  private readonly widthResult = signal<TakePictureWidthResult | null>(null);
  private readonly stops: (() => void)[] = [];
  private lastSaved: string | null = null;

  constructor(
    readonly build: SessionBuild,
    private readonly seams: BuildSessionSeams,
  ) {
    const now = seams.now ?? Date.now;
    const preference = seams.pictureWidth ?? takePictureWidth;
    const client = (this.client = audioLinkClient(build.peer));
    this.recorder = new BuildTakeRecorder(
      build,
      {
        ...seams.recorder,
        pictureWidth: () => takePictureWidthOf(preference.peek()),
        saved: (path, auto) => {
          this.lastSaved = path;
          seams.recorder.saved?.(path, auto);
          if (this.ended.peek()) seams.keep?.(path); // saved after the build left
        },
      },
      client,
    );
    this.follow = new BuildFollow({ name: build.name, peer: build.peer, client }, seams.follow);
    this.recording = computed<RecordingState>(() => {
      const ended = this.ended.value;
      if (ended) return { kind: "ended", reason: ended.reason };
      const since = this.since.value;
      return since === null ? { kind: "idle" } : { kind: "recording", since };
    });
    this.liveTake = this.live;
    this.show = computed<TakeOnShow>(() => (this.ended.value ? FILE : { kind: "live", build: build.name, take: this.live.value }));
    this.pictureWidth = this.widthResult;

    untracked(() => {
      // The recording clock: however the take started (here, the Take screen, F10, the game).
      this.stops.push(
        effect(() => {
          const recording = this.recorder.state.value.kind === "recording";
          if (!recording) this.since.value = null;
          else if (this.since.peek() === null) this.since.value = now();
        }),
      );
      // The take picture width: on connect and whenever the preference changes.
      let run = 0;
      this.stops.push(
        effect(() => {
          const width = takePictureWidthOf(preference.value);
          const mine = ++run;
          client.frames(width).then(
            (w) => {
              if (mine === run) this.widthResult.value = { build: build.name, width: w };
            },
            (e: unknown) => {
              if (mine === run) this.widthResult.value = { build: build.name, error: e instanceof Error ? e.message : String(e) };
            },
          );
        }),
        () => void run++,
      );
      this.stops.push(client.followLiveTake((l) => (this.live.value = l ? { ...l, build: build.name } : null), seams.liveTake));
      this.recorder.watch();
      void this.follow.start();
    });
  }

  /** True until the session is disposed. */
  get open(): boolean {
    return this.ended.peek() === null;
  }

  /** Start a take on the build (the Take screen's Start, Record session). */
  start(): Promise<void> {
    return this.recorder.start();
  }

  /** Stop the build's take (it keeps it for Save). */
  stop(): Promise<void> {
    return this.recorder.stop();
  }

  /** A marker with `text` at the take's present moment. */
  mark(text: string): Promise<void> {
    return this.recorder.mark(text);
  }

  /**
   * The build left or another was chosen: whatever runs on a closed link fails with why, the follows end, and the last
   * take saved is handed to `keep`. A recorder's failure and an ended capture follow stay to say why; a running capture
   * follow on a link still open stops (its live view closes).
   */
  dispose(): void {
    if (this.ended.peek()) return;
    const peer = this.build.peer;
    const closed = peer.state === "closed";
    const reason = closed ? peer.closedReason : null;
    for (const stop of this.stops.splice(0)) stop();
    if (closed) {
      this.recorder.linkClosed(reason ?? undefined);
      this.follow.linkClosed(reason ?? undefined);
      this.client.linkClosed(`the link to ${this.build.name} closed${reason ? ` (${reason})` : ""}`);
    }
    this.recorder.dispose();
    if (this.follow.state.peek().kind !== "ended") this.follow.stop();
    this.live.value = null;
    this.since.value = null;
    this.ended.value = { reason };
    if (this.lastSaved) this.seams.keep?.(this.lastSaved);
  }
}

const current = signal<BuildSession | null>(null);

/** The connected build's session; an ended one (the link ended) until another build connects; null before any. */
export const buildSession: ReadonlySignal<BuildSession | null> = current;

/** What the Take screen and the Profiler show (ADR 0408): the connected build live, or a file. */
export const takeOnShow: ReadonlySignal<TakeOnShow> = computed(() => current.value?.show.value ?? FILE);

/**
 * Follows `builds` with one session per build: a new build disposes the last session and makes its own; a build leaving
 * disposes its session, which stays (ended) to say why. Returns the stop, which disposes the session and clears it.
 */
export function followBuildSessions(builds: ReadonlySignal<SessionBuild | null>, seamsFor: (build: SessionBuild) => BuildSessionSeams): () => void {
  const stop = effect(() => {
    const build = builds.value;
    untracked(() => {
      const was = current.peek();
      if (was?.open ? was.build.peer === build?.peer : !build) return;
      was?.dispose();
      if (build) current.value = new BuildSession(build, seamsFor(build));
    });
  });
  return () => {
    stop();
    current.peek()?.dispose();
    current.value = null;
  };
}
