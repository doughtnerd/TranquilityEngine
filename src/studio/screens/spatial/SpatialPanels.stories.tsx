// Stories (ADR 0219, 0349) for the Spatial screen's side panels on fixture data: the Scenes tree (folders, search, the
// New menu, the empty state), the Outline (groups, counts, filter, eye and lock), the Inspector per kind of object, Scene
// settings over a mix, the Voices table from a readout, and the From take / From game scene / attenuation dialogs.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import { mixerFixture } from "../mixer/mixerFixture";
import { InspectorPanel, type InspectorProps } from "./InspectorPanel";
import { OutlinePanel } from "./OutlinePanel";
import { ScenesPanel } from "./ScenesPanel";
import { setHidden, setLocked } from "./sceneEdits";
import { SettingsPanel } from "./SettingsPanel";
import { AttenuationChoiceDialog, GameSceneDialog, TakeDialog } from "./SpatialDialogs";
import { FIXTURE_SCENE_FILES, fixtureBase, fixtureScene, fixtureVoices } from "./spatialFixture";
import { VoicesPanel } from "./VoicesPanel";
import { baseSoundId, voiceTable } from "./voicesTable";
import "../../components/audioParts.css";
import "../playlists/playlists.css";
import "./spatial.css";

const meta = { title: "Studio/Spatial/Panels" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const frame = (width: number, height: number, child: preact.ComponentChildren) => <div style={{ width: `${width}px`, height: `${height}px`, display: "flex", flexDirection: "column" }}>{child}</div>;

export const Scenes: Story = {
  render: () => {
    const [extra, setExtra] = useState<readonly string[]>([]);
    return frame(280, 420, <ScenesPanel entries={FIXTURE_SCENE_FILES} openPath="audio/scenes/canyon_run.audioscene.json" writable hasOpen extra={extra} setExtra={setExtra}
      actions={{ open: fn(), newScene: fn(), rename: fn(), duplicate: fn(), remove: fn(), setFolders: fn(), refuse: fn() }} />);
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const tree = c.getByRole("tree", { name: "Test scenes" });
    await expect(within(tree).getByRole("treeitem", { name: /canyon_run/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.type(c.getByRole("searchbox", { name: "Search scenes" }), "drone");
    await expect(c.getByRole("tree", { name: "Matching scenes" })).toHaveTextContent("Moving sources › drone_flyby");
    await userEvent.clear(c.getByRole("searchbox", { name: "Search scenes" }));
    await userEvent.click(c.getByRole("button", { name: "+ New" }));
    const menu = within(document.body).getByRole("menu", { name: "New test scene" });
    await expect(within(menu).getByRole("menuitem", { name: /From take/ })).toBeVisible();
    await expect(within(menu).getByRole("menuitem", { name: /From open game scene/ })).toBeVisible();
  },
};

export const ScenesEmpty: Story = {
  render: () => frame(280, 320, <ScenesPanel entries={[]} openPath={null} writable hasOpen={false} extra={[]} setExtra={fn()} actions={{ open: fn(), newScene: fn(), rename: fn(), duplicate: fn(), remove: fn(), setFolders: fn(), refuse: fn() }} />),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("note", { name: "No test scenes yet" })).toBeVisible();
  },
};

export const Outline: Story = {
  render: () => {
    const [scene, setScene] = useState(fixtureScene());
    const [selected, select] = useState<string | null>("emitter1");
    return frame(260, 480, (
      <OutlinePanel scene={scene} selected={selected} readOnly={false} onSelect={select}
        onHidden={(id, h) => { const r = setHidden(scene, id, h); if ("next" in r) setScene(r.next); }}
        onLocked={(id, l) => { const r = setLocked(scene, id, l); if ("next" in r) setScene(r.next); }} />
    ));
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("treeitem", { name: "Emitters, 4" })).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Hide Waterfall" }));
    await expect(c.getByRole("button", { name: "Show Waterfall" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(c.getByRole("searchbox", { name: "Filter the outline" }), "zone");
    await expect(c.getByRole("treeitem", { name: "Audio zones, 2" })).toBeVisible();
  },
};

const inspector = (selected: string, over: Partial<InspectorProps> = {}): InspectorProps => ({
  scene: fixtureScene(),
  selected,
  readOnly: false,
  voices: fixtureVoices(),
  playing: true,
  buses: ["Master", "Music", "SFX", "Ambience"],
  materials: ["none", "cloth", "glass", "wood", "metal", "concrete"],
  attenuation: { summary: "Min 2.0 m · Max 40.0 m · ∿ Volume", owner: "Preset vehicle.attenuation.json, shared by the playlists that name it.", editable: true, rolloff: true },
  solo: null,
  silenced: () => false,
  sounds: () => [{ path: "audio/ambience/waterfall.playlist.json", kind: "playlist", badge: "QUE" }, { path: "audio/sfx/generator_hum.wav", kind: "sample", badge: "SMP" }],
  onEdit: fn(() => true),
  onEndDrag: fn(),
  onSolo: fn(),
  onMute: fn(),
  onEditAttenuation: fn(),
  onRolloff: fn(),
  onListenHere: fn(),
  onEditPath: fn(),
  onDelete: fn(),
  onOpenSound: fn(),
  ...over,
});

export const InspectorEmitter: Story = {
  render: () => frame(320, 720, <InspectorPanel {...inspector("emitter2")} />),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Panned")).toBeVisible();
    await expect(c.getByText(/−9.1 dB · low-pass 1.2 kHz · concrete/)).toBeVisible();
    await expect(c.getByText("Min 2.0 m · Max 40.0 m · ∿ Volume")).toBeVisible();
    await expect(c.getByRole("button", { name: "Edit attenuation…" })).toBeEnabled();
  },
};

export const InspectorMovingEmitter: Story = { render: () => frame(320, 720, <InspectorPanel {...inspector("emitter4")} />) };
export const InspectorAudioZone: Story = {
  render: () => frame(320, 720, <InspectorPanel {...inspector("zone1")} />),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Zone depth")).toBeVisible();
  },
};
export const InspectorReverbZone: Story = { render: () => frame(320, 720, <InspectorPanel {...inspector("reverb1")} />) };
export const InspectorObstacle: Story = { render: () => frame(320, 720, <InspectorPanel {...inspector("obstacle2")} />) };
export const InspectorListener: Story = { render: () => frame(320, 520, <InspectorPanel {...inspector("listener2")} />) };
export const InspectorSound2d: Story = { render: () => frame(320, 520, <InspectorPanel {...inspector("sound1")} />) };
export const InspectorNothing: Story = { render: () => frame(320, 200, <InspectorPanel {...inspector("")} selected={null} />) };

export const Settings: Story = {
  render: () => {
    const [mix, setMix] = useState<AudioProject>(mixerFixture());
    return frame(360, 640, <SettingsPanel mix={mix} readOnly={false} onEdit={(_l, e) => { const r = e(mix); if ("refused" in r) return false; setMix(r.next); return true; }} onEndDrag={fn()} />);
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "+ Material" }));
    await expect(c.getByRole("textbox", { name: "Material name" })).toHaveValue("Material");
  },
};

export const Voices: Story = {
  render: () => frame(640, 260, <VoicesPanel rows={voiceTable(fixtureScene(), fixtureVoices())} playing selected="emitter2" onSelect={fn()} onPlay={fn()} />),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("row", { name: /Generator/ })).toHaveTextContent("Panned");
    await expect(c.getByRole("row", { name: /Drone/ })).toHaveTextContent("+34 ct");
  },
};

/** D43: the base game scene's own well plays underneath, after the scene's sounds, marked "base". */
export const VoicesWithBase: Story = {
  render: () => {
    const base = fixtureBase();
    const well = base.objects.find((o) => o.name === "Well")!;
    const rows = [...fixtureVoices(), { id: baseSoundId(well.key), kind: "emitter" as const, playing: true, rendered: "hrtf" as const, distance: 15.7, occlusion: { gain: 1, cutoffHz: null, material: null }, doppler: 1, dopplerCents: 0 }];
    return frame(640, 300, <VoicesPanel rows={voiceTable(fixtureScene(), rows, undefined, { base })} playing selected={null} onSelect={fn()} onPlay={fn()} />);
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("row", { name: /Well/ })).toHaveTextContent("base");
  },
};

export const VoicesNotPlaying: Story = { render: () => frame(640, 200, <VoicesPanel rows={[]} playing={false} selected={null} onSelect={fn()} onPlay={fn()} />) };

export const FromGameScene: Story = { render: () => <GameSceneDialog scenes={["scenes/canyon.scene.json", "scenes/level_02.scene.json"]} onPick={fn()} onCancel={fn()} /> };

export const FromTake: Story = {
  render: () => <TakeDialog takes={["takes/canyon_run_04.mycotake"]} open={async () => ({ duration: 95, at: () => fixtureScene() })} onCreate={fn()} onCancel={fn()} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    await expect(await c.findByText(/At 0:00 of 1:35/)).toBeVisible();
    await expect(c.getByRole("button", { name: "Create" })).toBeEnabled();
  },
};

export const AttenuationChoice: Story = { render: () => <AttenuationChoiceDialog playlist="audio/sfx/drone.playlist.json" onChoose={fn()} onCancel={fn()} /> };
