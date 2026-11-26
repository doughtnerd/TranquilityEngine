// The live take over a real link to a build (the Profiler's link test support): a take the game starts itself shows in
// `liveTake` as it grows, its state follows the build's take, a new take starts the picture over, and disconnecting
// clears it.
import { signal } from "@preact/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../../plugins/audio/runtime/Audio";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../plugins/audio/runtime/capture/capture";
import type { CaptureChunkControl } from "../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, type LinkedBuild } from "../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import { followLiveTake, liveTake, liveTakeState, type LiveTakeBuild } from "./liveTake";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../plugins/audio/runtime/capture/save", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  Audio.take.stop();
  releaseCapture();
  setAudioBackend(null);
});

async function rig() {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const connected = signal<LiveTakeBuild | null>({ name: "Smoke game", peer: build.peer });
  undo.push(followLiveTake(connected));
  /** Runs `p` to the end, the build stepping and the tool polling meanwhile. */
  const run = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    p.then(() => (done = true), () => (done = true));
    await build.until(() => done, 2000);
    return p;
  };
  return { build, connected, run };
}

describe("the live take", () => {
  it("shows the take a build records as it grows, its state, a new take from scratch, and nothing once disconnected", async () => {
    const { build, connected, run } = await rig();
    for (let i = 0; i < 5; i++) build.round();
    expect(liveTake.value).toBeNull();
    expect(liveTakeState.value).toBe("idle");

    // The game starts a take itself (as its script or F10 would) and marks it.
    await run(Audio.take.start());
    await build.until(() => liveTakeState.value === "recording", 2000);
    expect(liveTake.value).toMatchObject({ build: "Smoke game", state: "recording", message: null });
    expect(liveTake.value!.take.keyframes.length).toBeGreaterThan(0);
    const first = liveTake.value!.id;

    Audio.take.mark("first");
    build.feed(10);
    await build.until(() => liveTake.value!.take.marks().length === 1, 5000);
    Audio.take.mark("second");
    await build.until(() => liveTake.value!.take.marks().length === 2, 5000);
    expect(liveTake.value!.take.marks().map((m) => m.text)).toEqual(["first", "second"]);
    expect(liveTake.value!.take.meta).toMatchObject({ engine: "myco", audioHash: expect.stringMatching(/^[0-9a-f]{8}$/) });

    Audio.take.stop();
    await build.until(() => liveTakeState.value === "stopped", 2000);
    expect(liveTake.value!.state).toBe("stopped");
    expect(liveTake.value!.take.marks().map((m) => m.text)).toEqual(["first", "second"]);
    expect(liveTake.value!.take.meta.duration).toBeCloseTo(Audio.take.seconds, 2);

    // A new take: the picture starts over.
    await run(Audio.take.start());
    await build.until(() => liveTakeState.value === "recording" && liveTake.value!.id !== first, 2000);
    expect(liveTake.value!.take.marks()).toEqual([]);
    Audio.take.mark("third");
    await build.until(() => liveTake.value!.take.marks().length === 1, 5000);

    connected.value = null;
    expect(liveTake.value).toBeNull();
    expect(liveTakeState.value).toBe("idle");
  });

  it("shows a build's last take when it connects after the take stopped", async () => {
    const { build, connected, run } = await rig();
    connected.value = null;
    await run(Audio.take.start());
    Audio.take.mark("kept");
    Audio.take.stop();
    connected.value = { name: "Smoke game", peer: build.peer };
    await build.until(() => liveTakeState.value === "stopped", 2000);
    expect(liveTake.value!.take.marks().map((m) => m.text)).toEqual(["kept"]);
  });
});
