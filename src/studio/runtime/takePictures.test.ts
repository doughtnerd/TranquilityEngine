// The take picture resolution over a real link to a build: the preference is sent when a build connects and when it
// changes, the build takes its next take's pictures at that width (its live take says so), and a bad width is refused
// with the build's message.
import { signal } from "@preact/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../../plugins/audio/runtime/Audio";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../plugins/audio/runtime/capture/capture";
import type { CaptureChunkControl } from "../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, type LinkedBuild } from "../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import { followLiveTake, liveTake, liveTakeState } from "./liveTake";
import {
  DEFAULT_TAKE_PICTURE_WIDTH, followTakePictureWidth, sendTakePictureWidth, takePictureWidth, takePictureWidthOf, takePictureWidthResult, type TakePicturesBuild,
} from "./takePictures";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../plugins/audio/runtime/capture/save", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  Audio.take.stop();
  releaseCapture();
  setAudioBackend(null);
  takePictureWidth.value = DEFAULT_TAKE_PICTURE_WIDTH;
});

async function rig() {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const run = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    p.then(() => (done = true), () => (done = true));
    await build.until(() => done, 2000);
    return p;
  };
  return { build, run };
}

describe("the take picture resolution", () => {
  it("offers 320, 640, 960 and 1280 px, 640 until chosen", () => {
    expect(takePictureWidthOf(960)).toBe(960);
    expect(takePictureWidthOf(500)).toBe(640);
    expect(takePictureWidthOf("1280")).toBe(640);
    expect(takePictureWidthOf(takePictureWidth.value)).toBe(640);
  });

  it("is sent to a build on connect and on change; the build's next take uses it", async () => {
    const { build, run } = await rig();
    const connected = signal<TakePicturesBuild | null>(null);
    undo.push(followTakePictureWidth(connected));
    undo.push(followLiveTake(connected));
    expect(takePictureWidthResult.value).toBeNull();

    connected.value = { name: "Smoke game", peer: build.peer };
    await build.until(() => takePictureWidthResult.value !== null, 2000);
    expect(takePictureWidthResult.value).toEqual({ build: "Smoke game", width: 640 });

    takePictureWidth.value = 1280;
    await build.until(() => (takePictureWidthResult.value as { width?: number } | null)?.width === 1280, 2000);

    await run(Audio.take.start());
    await build.until(() => liveTakeState.value === "recording", 2000);
    expect(liveTake.value).toMatchObject({ pictures: true, pictureWidth: 1280 });
  });

  it("refuses a width the build can't take, with why", async () => {
    const { build, run } = await rig();
    await expect(run(sendTakePictureWidth({ peer: build.peer }, 5000))).rejects.toThrow(/take\.frames: .*from 64 to 1920/);
    await expect(run(sendTakePictureWidth({ peer: build.peer }, 12.5))).rejects.toThrow(/whole number/);
    expect(await run(sendTakePictureWidth({ peer: build.peer }, 320))).toBe(320);
  });
});
