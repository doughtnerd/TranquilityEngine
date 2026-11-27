// The Profiler following a connected build (plan U5) through `BuildFollow` and `remoteLiveHost`: a headless build serves
// the real `audio` topic over the loopback link (as the link smoke does), the Profiler's store shows its capture feed
// live through the in-process capture Worker; a build whose ring can't be joined (`captureLost`), the link closing and
// the build going quiet (Play stopped) each say so. Timers (the view's update window, the quiet check) are manual.
import { afterEach, describe, expect, it, vi } from "vitest";
import { inProcessWorker } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import type { LiveScheduler } from "../../../plugins/audio/editor/mix/liveFollow";
import { setAudioBackend } from "../../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../../plugins/audio/runtime/capture/capture";
import type { CaptureChunkControl } from "../../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, SECOND, type LinkedBuild } from "../../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import { ProfilerStore } from "./profilerStore";
import { BuildFollow, buildFollowStatus } from "./remoteLiveHost";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../../plugins/audio/runtime/capture/save", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

/** A scheduler that runs timers only when told. */
function manualScheduler(): LiveScheduler & { fire(): void } {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout(fn) {
      const h = next++;
      timers.set(h, fn);
      return h;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const fn of all) fn();
    },
  };
}

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
});

async function rig() {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const store = new ProfilerStore({ open: () => Promise.reject(new Error("no files here")), readFile: () => Promise.reject(new Error("no files here")) });
  const view = manualScheduler();
  const quiet = manualScheduler();
  const follow = new BuildFollow(
    { name: "Smoke game", peer: build.peer },
    { store, liveOptions: { scheduler: view, sourceOptions: () => ({ worker: inProcessWorker() }) }, remote: { scheduler: quiet, stallMs: 3000 } },
  );
  undo.push(() => follow.dispose());
  /** Rounds with the view's update window firing each time, until `done`. */
  const until = (done: () => boolean) =>
    build.until(() => {
      view.fire();
      return done();
    });
  return { build, store, follow, quiet, until };
}

describe("the Profiler following a connected build", () => {
  it("Follow opens the build's capture live; its segments grow the timeline; Stop closes the view", async () => {
    const r = await rig();
    expect(buildFollowStatus(r.follow.state.value, "Smoke game")).toBeNull();
    const started = r.follow.start();
    expect(r.follow.state.value.kind).toBe("starting");
    await r.until(() => r.store.state.value.kind === "open");
    await started;
    expect(r.store.state.value).toMatchObject({ kind: "open", origin: "live", title: "Live from Smoke game" });
    expect(r.follow.state.value).toEqual({ kind: "following", stalled: null });
    expect(buildFollowStatus(r.follow.state.value, "Smoke game")).toBe("● Live from Smoke game");
    for (let s = 0; s < 3; s++) {
      r.build.feed(SECOND + 2);
      r.build.round();
    }
    await r.until(() => (r.store.data.value?.duration ?? 0) > 2);
    expect(r.store.source?.live).toBe(true);
    r.follow.stop();
    expect(r.follow.state.value).toEqual({ kind: "idle" });
    expect(r.store.state.value).toEqual({ kind: "none" });
  });

  it("a build whose capture ring can't be joined ends the follow with captureLost's message and opens nothing", async () => {
    const r = await rig();
    setAudioBackend(null); // the build's audio can't record: its topic answers captureLost at once
    void r.follow.start();
    await r.until(() => r.follow.state.value.kind === "ended");
    const s = r.follow.state.value;
    expect(s.kind === "ended" && s.message).toMatch(/Smoke game's capture ring dropped a segment/);
    expect(buildFollowStatus(s, "Smoke game")).toMatch(/live view stopped/);
    expect(r.store.state.value.kind).toBe("none");
  });

  it("the link closing ends the follow with why; the view keeps what came", async () => {
    const r = await rig();
    void r.follow.start();
    await r.until(() => r.store.state.value.kind === "open");
    r.build.feed(SECOND + 2);
    await r.until(() => (r.store.data.value?.duration ?? 0) > 0.5);
    r.follow.linkClosed("the game quit");
    const s = r.follow.state.value;
    expect(s.kind === "ended" && s.message).toBe("The link to Smoke game closed (the game quit); the live view stopped here.");
    expect(r.store.state.value).toMatchObject({ kind: "open", origin: "live" });
  });

  it("a build closed from its side is noticed by the quiet check", async () => {
    const r = await rig();
    void r.follow.start();
    await r.until(() => r.store.state.value.kind === "open");
    r.build.closeBuild();
    expect(r.build.peer.state).toBe("closed");
    r.quiet.fire();
    const s = r.follow.state.value;
    expect(s.kind === "ended" && s.message).toMatch(/^The link to Smoke game closed/);
  });

  it("a build that goes quiet (its Play stopped) says so, and the note clears when segments come again", async () => {
    const r = await rig();
    void r.follow.start();
    await r.until(() => r.store.state.value.kind === "open");
    r.quiet.fire(); // 3 s with no segment
    expect(r.follow.state.value).toEqual({ kind: "following", stalled: "Nothing from Smoke game for 3 s: its Play may have stopped." });
    expect(buildFollowStatus(r.follow.state.value, "Smoke game")).toMatch(/Play may have stopped/);
    r.build.feed(SECOND + 2);
    await r.until(() => r.follow.state.value.kind === "following" && r.follow.state.value.stalled === null);
  });
});
