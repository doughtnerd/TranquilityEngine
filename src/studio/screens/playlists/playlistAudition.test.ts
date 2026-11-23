// What Trigger plays on the Playlists screen, through the screen's actions over a project in memory and a runtime that
// records what it's asked to play (UI pass Q7, PB4, L2): the open nested playlist itself (served under its audition
// path, where the runtime reads it through `Assets`), not its file's root; nothing on an empty playlist, Trigger off
// with the reason; the player bar's scrub row there before the first trigger. Wave 3: a nested audition keeps its
// parents' playlist effects; Pause pauses the audition's playbacks (ADR 0362 §1) and freezes the views; a Switch's
// label change while it plays notes the rule that applies.
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
import { auditionTarget, frozen, lastChange, openPlaylist, pauseAudition, resumeAudition, setTestValue, stopAudition, trigger, triggerOffReason, voiceLog } from "./playlistsScreen";
import { bindSequence, playSequence, stopSequence } from "./sequence/sequenceState";

const plugin: EditorPlugin = { manifest: { name: "studio-playlist-audition-test", version: "1.0.0" } as EditorPlugin["manifest"], activate: registerStudioAssetKinds };
beforeAll(() => activatePlugins([plugin]));
afterAll(() => deactivatePlugin(plugin.manifest.name));

const FILE = "audio/footsteps.playlist.json";
const EMPTY = "audio/empty.playlist.json";
const WET = "audio/wet.playlist.json";
const OWN = "audio/own.playlist.json";
const SWITCH = "audio/surface.playlist.json";

const LOWPASS = { id: "fx1", type: "lowpass" as const, on: true, params: { cutoff: 800 } };

/** footsteps with a Low-pass on its root (the nested gravel plays through it inside the file). */
function wet(): PlaylistAsset {
  return { ...footsteps(), effects: [LOWPASS] };
}

/** wet whose nested gravel has an output of its own: it leaves the root's mix, so the root's Low-pass doesn't apply. */
function own(): PlaylistAsset {
  const f = wet();
  const e = f.entries[0]!;
  return { ...f, entries: [e.kind === "embedded" ? { ...e, embedded: { ...e.embedded, output: "UI" } } : e, ...f.entries.slice(1)] };
}

/** A Switch over a local labelled parameter, with a rule Grass → Metal. */
function surface(): PlaylistAsset {
  const root = emptyPlaylist("switch");
  const a = sampleEntry(root, "audio/step-grass-1.wav"), b = sampleEntry(root, "audio/step-metal-1.wav");
  return {
    ...root,
    parameters: [{ name: "Surface", labels: ["Grass", "Metal"], default: "Grass" }],
    entries: [a, b],
    switch: { ...root.switch!, parameter: "Surface", map: { Grass: 0, Metal: 1 }, rules: [{ from: "Grass", to: "Metal", when: "bar", how: "crossfade", length: { beats: 2 } }] },
  };
}

/** footsteps: a Switch-like root whose first entry is an embedded Queue "gravel" of two samples, then a grass sample. */
function footsteps(): PlaylistAsset {
  const root = { ...emptyPlaylist("queue"), output: "Foley" };
  const gravel = { ...emptyPlaylistBody("queue"), entries: [sampleEntry(emptyPlaylistBody("queue"), "audio/step-gravel-1.wav"), sampleEntry(emptyPlaylistBody("queue"), "audio/step-gravel-2.wav")] };
  return { ...root, entries: [{ kind: "embedded", embedded: gravel, volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} }, sampleEntry(root, "audio/step-grass-1.wav")] };
}

let played: string[];
/** What `Audio.debug()` answers (null: nothing to read). */
let debug: () => unknown = () => null;
/** What the audition's handles were asked to do: pause, resume, stop. */
let calls: string[];

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, FILE), JSON.stringify(footsteps()));
  fs.files.set(joinPath(ROOT, EMPTY), JSON.stringify(emptyPlaylist("queue")));
  fs.files.set(joinPath(ROOT, WET), JSON.stringify(wet()));
  fs.files.set(joinPath(ROOT, OWN), JSON.stringify(own()));
  fs.files.set(joinPath(ROOT, SWITCH), JSON.stringify(surface()));
  currentProject.value = await openFolderProject(fs, ROOT);
  played = [];
  calls = [];
  const hash: HashLocation = { get: () => "#/playlists", set: () => {}, listen: () => () => {} };
  const runtime = {
    playable: signal(true),
    state: signal({ kind: "running" }),
    audio: { setParameter: () => {}, debug: () => debug() },
    audition: (path: string) => (played.push(path), { playing: true, stop: () => calls.push("stop"), pause: () => calls.push("pause"), resume: () => calls.push("resume"), setParameter: () => {} }),
    playClip: (path: string) => (played.push(path), { playing: false, stop: () => {} }),
    stopAll: () => {},
  } as unknown as StudioAudioRuntime;
  provideStudio({ router: createRouter(hash), runtime });
});

afterEach(() => {
  debug = () => null;
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

  it("keeps the parents' playlist effects on a nested audition (it sounds as it does inside them)", () => {
    openPlaylist([...filePath(WET), { entry: 0 }]);
    trigger();
    const served = Assets.get(played[0]!) as PlaylistAsset;
    // A one-entry Layer carrying the root's Low-pass, playing the nested gravel Queue.
    expect(served.effects.map((e) => [e.type, e.params.cutoff])).toEqual([["lowpass", 800]]);
    expect(served.type).toBe("layer");
    const inner = served.entries[0]!;
    expect(inner.kind === "embedded" && inner.embedded.type).toBe("queue");
    expect(inner.kind === "embedded" && inner.embedded.entries).toHaveLength(2);
    expect(served.output).toBe("Foley");
  });

  it("leaves the parents' effects off a nested playlist with an output of its own", () => {
    openPlaylist([...filePath(OWN), { entry: 0 }]);
    trigger();
    const served = Assets.get(played[0]!) as PlaylistAsset;
    expect(served.effects).toEqual([]);
    expect(served.type).toBe("queue");
    expect(served.output).toBe("UI");
  });
});

describe("Pause on the Playlists screen", () => {
  it("pauses the audition's playbacks and freezes the views; Resume continues them; Trigger while paused starts fresh", () => {
    openPlaylist(filePath(FILE));
    trigger();
    pauseAudition();
    expect(frozen.value).not.toBeNull();
    expect(calls).toEqual(["pause"]);
    pauseAudition(); // already paused
    expect(calls).toEqual(["pause"]);
    resumeAudition();
    expect(frozen.value).toBeNull();
    expect(calls).toEqual(["pause", "resume"]);
    pauseAudition();
    trigger();
    expect(frozen.value).toBeNull();
    expect(calls).toEqual(["pause", "resume", "pause", "stop"]);
    expect(played).toEqual([FILE, FILE]);
  });

  it("the player bar shows Pause while it plays and Resume (its paused state) while paused", () => {
    const state = { title: "footsteps", subtitle: "Queue", busy: true, release: false, triggerOff: null, log: [], cursor: null, now: 0 };
    const actions = { trigger, stop: stopAudition, release: () => {}, pause: pauseAudition, resume: resumeAudition, seek: () => {} };
    const labels = (paused: boolean) => {
      const slots = playlistPlayerSlots({ ...state, paused }, actions);
      return { buttons: ((slots.transport as VNode<{ children: VNode<{ label: string; icon: string }>[] }>).props.children).filter(Boolean).map((b) => [b.props.label, b.props.icon]), status: slots.status };
    };
    expect(labels(false).buttons).toContainEqual(["Pause", "pause"]);
    expect(labels(true).buttons).toContainEqual(["Resume", "play"]);
    expect(labels(true).buttons).not.toContainEqual(["Pause", "pause"]);
    expect(labels(true).status).toMatch(/^Paused at/);
  });

});

describe("A sequence's play in the Voices log (J6.3)", () => {
  it("logs the voices the sequence's transport plays, as Trigger's are", () => {
    const SEQ = "audio/brake.playlist.json";
    debug = () => ({ time: 1, events: [{ id: 7, asset: SEQ, voices: 1 }], voices: [{ id: 3, clip: "audio/brake_skid.wav", bus: "SFX", state: "playing", gain: 1, playheadSeconds: 0.5, event: 7 }] });
    bindSequence("audition-test", { file: SEQ, title: "brake", seq: { length: 2, tempo: null, tracks: [], loops: [], markers: [] }, plays: "oneShot", sourceOf: () => null });
    playSequence();
    expect(played).toEqual([SEQ]);
    expect(voiceLog.value.map((r) => [r.clip, r.status])).toEqual([["audio/brake_skid.wav", "playing"]]);
    stopSequence();
  });
});

describe("A Switch's label change while it plays", () => {
  it("notes the change rule that applies (the rules table lights it, Plays now shows the transition)", () => {
    openPlaylist(filePath(SWITCH));
    trigger();
    setTestValue("Surface", 1);
    expect(lastChange.value).toMatchObject({ from: "Grass", to: "Metal", rule: 0 });
    setTestValue("Surface", 0);
    // Metal → Grass has no rule of its own: When it changes (-1) applies.
    expect(lastChange.value).toMatchObject({ from: "Metal", to: "Grass", rule: -1 });
  });
});
