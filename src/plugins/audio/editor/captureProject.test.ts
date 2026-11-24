// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §5.2): the editor's audio plugin tells the capture which project it
// records, so META names it (the page title stands in otherwise). The project is read when a capture begins, not when the plugin
// activates, so a project opened afterwards is the one named.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorPluginContext } from "../../../editor/sdk";
import { currentProject } from "../../../editor/state";
import type { EditorProject } from "../../../editor/projects";
import { Audio } from "../runtime/Audio";
import { setAudioBackend } from "../runtime/backend";
import { releaseCapture, setCaptureProject } from "../runtime/capture/capture";
import type { CaptureChunkControl } from "../runtime/capture/testSupport";

/** The save chunk is the real one, wrapped: each save goes through the test's fakes. */
const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../runtime/capture/save", async (real) => (await import("../runtime/capture/testSupport")).captureSaveModule(await real(), chunk));
import { openCapture } from "../runtime/capture/reader";
import { defaultSaveEnv } from "../runtime/capture/save";
import { makeFakeBackend } from "../runtime/testing";
import { audioEditorPlugin } from "./index";

const fakeProject = (name: string, settings: Record<string, unknown> = {}): EditorProject => ({ name, settings }) as unknown as EditorProject;

/** A capture of the fake core backend, saved: its META's project. */
async function recordedProject(): Promise<{ name: string; version: string }> {
  const fb = makeFakeBackend();
  setAudioBackend(fb);
  const downloads: Uint8Array[] = [];
  chunk.saveEnv = ({
    tauri: false,
    fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
    storageRoot: async () => "/data",
    download: (bytes) => void downloads.push(bytes),
    compress: defaultSaveEnv().compress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  });
  await Audio.capture.start();
  await Audio.capture.save();
  const c = await openCapture(downloads[0]!);
  return c.meta.project;
}

afterEach(() => {
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
  currentProject.value = null;
  setCaptureProject(() => ({ name: "", version: "" }));
});

describe("the audio editor plugin names the project in a capture", () => {
  it("META carries the open project's name, and the version when project.json keeps one; none open: empty", async () => {
    const ctx = new Proxy({} as object, { get: () => () => () => {} }) as unknown as EditorPluginContext;
    audioEditorPlugin.activate(ctx);

    currentProject.value = fakeProject("Flappy", { version: "2.0.1" });
    expect(await recordedProject()).toEqual({ name: "Flappy", version: "2.0.1" });

    releaseCapture();
    currentProject.value = fakeProject("Pirates", { version: 3 }); // not a string: no version
    expect(await recordedProject()).toEqual({ name: "Pirates", version: "" });

    releaseCapture();
    currentProject.value = null;
    expect(await recordedProject()).toEqual({ name: "", version: "" });
  });
});
