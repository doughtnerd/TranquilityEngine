// ADR 0357 §6: the Play toolbar's Subtitles overlay mounts the plugin's `SubtitleDisplay` (editor-only, never saved) on
// the play session's World, under its root so it survives scene loads, and removes it when turned off. The toggle is the
// plugin's Play toolbar item, there only while the plugin is on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../../../engine";
import { startPlay, type PlaySession } from "../../../editor/playMode";
import { openSceneFile } from "../../../editor/project";
import { editorSettings, useProjectAssets } from "../../../editor/projects";
import { playToolbarItems } from "../../../editor/sdk";
import { currentProject, openScene } from "../../../editor/state";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import { activatePlugin, deactivatePlugin } from "../../../editor/sdk/plugins";
import { SubtitleDisplay } from "../runtime";
import { subtitlesEditorPlugin } from ".";
import { syncSubtitlesOverlay } from "./playOverlay";

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
    const world = play!.engine.world;
    syncSubtitlesOverlay(world, true);
    syncSubtitlesOverlay(world, true);
    play!.engine.step(1 / 60);
    expect(displays()).toHaveLength(1);
    expect(displays()[0].node.parent).toBe(world.root);
    syncSubtitlesOverlay(world, false);
    play!.engine.step(1 / 60);
    expect(displays()).toHaveLength(0);
    expect(() => syncSubtitlesOverlay(null, true)).not.toThrow();
  });

  it("the toggle is the plugin's Play toolbar item", () => {
    deactivatePlugin(subtitlesEditorPlugin.manifest.name);
    expect(playToolbarItems.list().some((i) => i.id === "myco.subtitles.overlay")).toBe(false);
    activatePlugin(subtitlesEditorPlugin);
    expect(playToolbarItems.list().some((i) => i.id === "myco.subtitles.overlay")).toBe(true);
  });
});
