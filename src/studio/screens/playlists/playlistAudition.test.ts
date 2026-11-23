// What Trigger plays on the Playlists screen, through the screen's actions over a project in memory and a runtime that
// records what it's asked to play (UI pass Q7, PB4, L2): the open nested playlist itself (served under its audition
// path, where the runtime reads it through `Assets`), not its file's root; nothing on an empty playlist, Trigger off
// with the reason; the player bar's scrub row there before the first trigger.
import { signal } from "@preact/signals";
import type { VNode } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { joinPath, openFolderProject } from "../../../editor/projects";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "../../../editor/sdk/plugins";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { emptyPlaylist, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import { Assets } from "../../../engine/scene/Assets";
import { registerStudioAssetKinds } from "../../../plugins/audio/editor/studioAssets";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { createRouter, type HashLocation } from "../../shell/route";
import { provideStudio } from "../../shell/studioServices";
import { sampleEntry } from "./playlistEdits";
import { filePath } from "./playlistPaths";
import { playlistPlayerSlots } from "./playlistPlayer";
import { auditionTarget, openPlaylist, stopAudition, trigger, triggerOffReason } from "./playlistsScreen";

const plugin: EditorPlugin = { manifest: { name: "studio-playlist-audition-test", version: "1.0.0" } as EditorPlugin["manifest"], activate: registerStudioAssetKinds };
beforeAll(() => activatePlugins([plugin]));
afterAll(() => deactivatePlugin(plugin.manifest.name));

const FILE = "audio/footsteps.playlist.json";
const EMPTY = "audio/empty.playlist.json";

/** footsteps: a Switch-like root whose first entry is an embedded Queue "gravel" of two samples, then a grass sample. */
function footsteps(): PlaylistAsset {
  const root = { ...emptyPlaylist("queue"), output: "Foley" };
  const gravel = { ...emptyPlaylistBody("queue"), entries: [sampleEntry(emptyPlaylistBody("queue"), "audio/step-gravel-1.wav"), sampleEntry(emptyPlaylistBody("queue"), "audio/step-gravel-2.wav")] };
  return { ...root, entries: [{ kind: "embedded", embedded: gravel, volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }, sampleEntry(root, "audio/step-grass-1.wav")] };
}

let played: string[];

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, FILE), JSON.stringify(footsteps()));
  fs.files.set(joinPath(ROOT, EMPTY), JSON.stringify(emptyPlaylist("queue")));
  currentProject.value = await openFolderProject(fs, ROOT);
  played = [];
  const hash: HashLocation = { get: () => "#/playlists", set: () => {}, listen: () => () => {} };
  const runtime = {
    playable: signal(true),
    state: signal({ kind: "running" }),
    audio: { setParameter: () => {}, debug: () => null },
    audition: (path: string) => (played.push(path), { playing: false, stop: () => {} }),
    playClip: (path: string) => (played.push(path), { playing: false, stop: () => {} }),
    stopAll: () => {},
  } as unknown as StudioAudioRuntime;
  provideStudio({ router: createRouter(hash), runtime });
});

afterEach(() => {
  stopAudition();
  currentProject.value = null;
  status.value = null;
});

describe("Trigger on the Playlists screen", () => {
  it("plays the open nested playlist, not its file's root", () => {
    openPlaylist([...filePath(FILE), { entry: 0 }]);
    trigger();
    expect(played).toHaveLength(1);
    expect(played[0]).not.toBe(FILE);
    // What the runtime reads at that path: the nested Queue's own entries, on the bus it inherits.
    const served = Assets.get(played[0]!) as PlaylistAsset;
    expect(served.entries.map((e) => (e.kind === "embedded" && e.embedded.entries[0]?.kind === "sample" ? e.embedded.entries[0].sample : e.kind))).toEqual(["audio/step-gravel-1.wav", "audio/step-gravel-2.wav"]);
    expect(served.output).toBe("Foley");
  });

  it("plays the file itself when the open playlist is the file", () => {
    openPlaylist(filePath(FILE));
    trigger();
    expect(played).toEqual([FILE]);
  });

  it("has nothing to play on an empty playlist: Trigger is off and says why", () => {
    openPlaylist(filePath(EMPTY));
    expect(auditionTarget()).toBeNull();
    expect(triggerOffReason()).toBe("Add entries to this playlist to trigger it");
    trigger();
    expect(played).toEqual([]);
    const slots = playlistPlayerSlots({ title: "empty", subtitle: "Queue", busy: false, release: false, triggerOff: triggerOffReason(), log: [], cursor: null, now: 0 }, { trigger, stop: stopAudition, release: () => {}, seek: () => {} });
    const buttons = ((slots.transport as VNode<{ children: VNode<{ label: string; disabled?: boolean; title?: string }>[] }>).props.children).filter(Boolean);
    const triggerButton = buttons.find((b) => b.props.label === "Trigger")!;
    expect(triggerButton.props.disabled).toBe(true);
    expect(triggerButton.props.title).toBe("Add entries to this playlist to trigger it");
    // The scrub row is there before the first trigger (an idle track), so the bar doesn't grow when the log starts.
    expect(slots.scrub).toBeTruthy();
  });
});
