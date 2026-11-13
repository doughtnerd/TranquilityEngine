// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §5.2): the editor's audio plugin tells the capture which project it
// records, so META names it (the page title stands in otherwise). The project is read when a capture begins, not when the plugin
// activates, so a project opened afterwards is the one named.
import { afterEach, describe, expect, it } from "vitest";
import type { EditorPluginContext } from "../../../editor/sdk";
import { currentProject } from "../../../editor/state";
import type { EditorProject } from "../../../editor/projects";
import { Audio } from "../runtime/Audio";
import { setAudioBackend } from "../runtime/backend";
import { _setRecorderLoader, _setSaveEnv, releaseCapture, setCaptureProject } from "../runtime/capture/capture";
import { openCapture } from "../runtime/capture/reader";
import { _resetSaveState, deflateRawCompress } from "../runtime/capture/save";
import { makeFakeBackend } from "../runtime/testing";
import { audioEditorPlugin } from "./index";

const fakeProject = (name: string, settings: Record<string, unknown> = {}): EditorProject => ({ name, settings }) as unknown as EditorProject;

/** A capture of the fake core backend, saved: its META's project. */
async function recordedProject(): Promise<{ name: string; version: string }> {
  const fb = makeFakeBackend();
  setAudioBackend(fb);
  const downloads: Uint8Array[] = [];
  _setSaveEnv({
    tauri: false,
    storage: { save: async () => {}, list: async () => [], delete: async () => {} },
    appDataDir: async () => "/data",
    download: (bytes) => void downloads.push(bytes),
    compress: deflateRawCompress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  });
  await Audio.capture.start();
  await Audio.capture.save();
  const c = await openCapture(downloads[0]!);
  return c.meta.project;
}

afterEach(() => {
  releaseCapture();
  _setSaveEnv(null);
  _setRecorderLoader(() => import("../runtime/capture/recorder"));
  setAudioBackend(null);
  currentProject.value = null;
  setCaptureProject(() => ({ name: "", version: "" }));
});

describe("the audio editor plugin names the project in a capture", () => {
  it("META carries the open project's name, and the version when project.json keeps one; none open: empty", async () => {
    _resetSaveState();
    const ctx = new Proxy({} as object, { get: () => () => () => {} }) as unknown as EditorPluginContext;
    audioEditorPlugin.activate(ctx);

    currentProject.value = fakeProject("Flappy", { version: "2.0.1" });
    expect(await recordedProject()).toEqual({ name: "Flappy", version: "2.0.1" });

    releaseCapture();
    _resetSaveState();
    currentProject.value = fakeProject("Pirates", { version: 3 }); // not a string: no version
    expect(await recordedProject()).toEqual({ name: "Pirates", version: "" });

    releaseCapture();
    _resetSaveState();
    currentProject.value = null;
    expect(await recordedProject()).toEqual({ name: "", version: "" });
  });
});
