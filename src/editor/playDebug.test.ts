import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { playPaused, stepFrame, togglePause } from "./playDebug";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, playing, sceneCamera } from "./state";
import { sampleProject } from "./testing";

// The play bar's paused state follows the play session, whoever paused it (ADR 0022).

let play: PlaySession;

beforeEach(async () => {
  Input.reset();
  const project = sampleProject();
  useProjectAssets(project);
  const editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, project.mainScene!);
  play = await startPlay({ editor, scene: openScene.value!, project });
  playing.value = play;
});

afterEach(() => {
  playing.value = null;
  play.stop();
});

describe("play debug: paused", () => {
  it("shows a pause made by the session's own step and setPaused, not only by its actions", () => {
    expect(playPaused.value).toBe(false);
    play.step(); // pauses first
    expect(playPaused.value).toBe(true);
    play.setPaused(false);
    expect(playPaused.value).toBe(false);
  });

  it("Pause toggles and Step pauses", () => {
    togglePause();
    expect(playPaused.value).toBe(true);
    togglePause();
    expect(playPaused.value).toBe(false);
    stepFrame();
    expect(playPaused.value).toBe(true);
  });

  it("is false while editing", () => {
    play.setPaused(true);
    playing.value = null;
    expect(playPaused.value).toBe(false);
  });
});
