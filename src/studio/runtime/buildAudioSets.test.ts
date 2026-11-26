// ADR 0410: a connected build's audio downloaded into a build audio set, over a real link to a build (the Profiler's
// link test support), into an in-memory takes folder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { joinPath, openTakesFolder } from "../../editor/projects";
import { MemoryFileSystem, ROOT } from "../../editor/testing";
import { Assets } from "../../engine/scene/Assets";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../plugins/audio/runtime/capture/capture";
import type { CaptureChunkControl } from "../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, type LinkedBuild } from "../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import { BUILD_AUDIO_FOLDER, buildAudioSetName, downloadBuildAudioSet, mountBuildAudioFor, mountedBuildAudio, unmountBuildAudio } from "./buildAudioSets";
import { currentProject } from "../../editor/state";
import { provideStudio } from "../shell/studioServices";
import { createRouter } from "../shell/route";
import type { StudioAudioRuntime } from "./studioAudioHost";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../plugins/audio/runtime/capture/save", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  releaseCapture();
  setAudioBackend(null);
});

const WAV = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]);

async function build(): Promise<LinkedBuild> {
  const b = await linkedBuild(chunk);
  undo.push(() => b.dispose());
  Assets.addSource(
    Assets.fromObject({
      "audio.json": { buses: [{ name: "Master" }] },
      "sfx/click.playlist.json": { root: { type: "clip", sample: "sfx/click.wav" } },
      "sfx/click.wav": `data:audio/wav;base64,${Buffer.from(WAV).toString("base64")}`,
    }),
  );
  return b;
}

describe("downloading a build's audio (ADR 0410)", () => {
  it("keeps the build's JSON files and sounds as a set in the takes folder, with its index written last", async () => {
    const b = await build();
    const fs = new MemoryFileSystem();
    const root = joinPath(ROOT, "takes");
    const progress: number[] = [];
    let dir = "";
    const run = downloadBuildAudioSet({ peer: b.peer }, { fs, root }, (p) => void progress.push(p.done)).then((d) => (dir = d));
    await b.until(() => dir !== "", 5000);
    await run;
    expect(dir.replace(/\\/g, "/")).toContain(`${BUILD_AUDIO_FOLDER}/`);
    const index = JSON.parse(await fs.readText(joinPath(dir, "set.json"))) as { files: { kind: string; path: string }[]; audioHash: string };
    expect(index.files.map((f) => f.path)).toEqual(expect.arrayContaining(["audio.json", "sfx/click.playlist.json", "sfx/click.wav", "s.json"]));
    expect(JSON.parse(await fs.readText(joinPath(dir, "project/audio.json")))).toEqual({ buses: [{ name: "Master" }] });
    expect(await fs.readBinary(joinPath(dir, "project/sfx/click.wav"))).toEqual(WAV);
    expect(progress.at(-1)).toBe(index.files.length);

    // A second connect downloads only what changed: nothing here.
    const writes = fs.writes.length;
    let again = "";
    const second = downloadBuildAudioSet({ peer: b.peer }, { fs, root }).then((d) => (again = d));
    await b.until(() => again !== "", 5000);
    await second;
    expect(again).toBe(dir);
    expect(fs.writes.slice(writes).map((w) => w.replace(/\\/g, "/").split("/").pop())).toEqual(["set.json"]);
  });

  it("mounts the set a take in the takes folder matches: its files as assets and the runtime on its audio, until released", async () => {
    const b = await build();
    const fs = new MemoryFileSystem();
    const root = joinPath(ROOT, "takes");
    let dir = "";
    const run = downloadBuildAudioSet({ peer: b.peer }, { fs, root }).then((d) => (dir = d));
    await b.until(() => dir !== "", 5000);
    await run;
    const index = JSON.parse(await fs.readText(joinPath(dir, "set.json"))) as { project: string; audioHash: string };
    b.dispose();
    undo.pop();
    Assets.clearSources();

    const opened: unknown[] = [];
    const runtime = { open: async (s: unknown) => void opened.push(s), close: () => void opened.push("close") } as unknown as StudioAudioRuntime;
    provideStudio({ router: createRouter({ get: () => "#/take", set: () => {}, listen: () => () => {} }), runtime });
    const workspace = await openTakesFolder(fs, root);
    currentProject.value = workspace;
    undo.push(() => (currentProject.value = null));

    expect(await mountBuildAudioFor({ project: "Elsewhere", audioHash: index.audioHash })).toBeNull();
    expect(await mountBuildAudioFor(index)).toBe(buildAudioSetName(index.project, index.audioHash));
    expect(mountedBuildAudio.value).toBe(buildAudioSetName(index.project, index.audioHash));
    expect(Assets.get("sfx/click.playlist.json")).toEqual({ root: { type: "clip", sample: "sfx/click.wav" } });
    expect(String(Assets.get("sfx/click.wav"))).toMatch(/^blob:/);
    expect(opened.at(-1)).toMatchObject({ audio: { buses: [{ name: "Master" }] } });

    unmountBuildAudio();
    expect(mountedBuildAudio.value).toBeNull();
    expect(Assets.has("sfx/click.playlist.json")).toBe(false);
    expect(opened.slice(-2)[0]).toBe("close");
  });

  it("names a set by the project and the mix's hash, made safe", () => {
    expect(buildAudioSetName("Canyon Run!", "0BADF00D")).toBe("canyon-run-0BADF00D");
    expect(buildAudioSetName("", "zz12")).toBe("project-12");
  });
});
