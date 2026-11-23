// ADR 0343 §6: the Play toolbar's Subtitles overlay mounts the subtitles plugin's `SubtitleDisplay` (editor-only, never
// saved) on the play session's World, under its root so it survives scene loads, and removes it when turned off.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { SubtitleDisplay } from "../plugins/subtitles/runtime";
import { startPlay, type PlaySession } from "./playMode";
import { subtitlesOverlayUnavailable, syncSubtitlesOverlay } from "./playSubtitles";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { currentProject, openScene } from "./state";
import { closeTestProject, openTestProject } from "./testing";

describe("the Play toolbar's Subtitles overlay", () => {
  let editor: Engine;
  let play: PlaySession | null = null;

  beforeEach(async () => {
    const { project } = await openTestProject({
      "project.json": JSON.stringify({ name: "Subs" }),
      "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@4", nodes: [] }),
    });
    useProjectAssets(project);
    editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    openSceneFile(editor, "scenes/main.scene.json");
    play = await startPlay({ editor, scene: openScene.value!, project: currentProject.value! });
  });

  afterEach(() => {
    play?.stop();
    play = null;
    closeTestProject();
  });

  const displays = () => play!.engine.world._componentsOfType(SubtitleDisplay);

  it("adds a display under the play World's root while on, once, and removes it when off", () => {
    expect(subtitlesOverlayUnavailable()).toBeNull(); // the plugin is on in new projects
    syncSubtitlesOverlay(play!.engine, true);
    syncSubtitlesOverlay(play!.engine, true);
    play!.engine.step(1 / 60);
    expect(displays()).toHaveLength(1);
    expect(displays()[0].node.parent).toBe(play!.engine.world.root);
    syncSubtitlesOverlay(play!.engine, false);
    play!.engine.step(1 / 60);
    expect(displays()).toHaveLength(0);
  });

  it("does nothing outside Play", () => {
    expect(() => syncSubtitlesOverlay(null, true)).not.toThrow();
  });
});
