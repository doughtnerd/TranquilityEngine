// Stories (ADR 0219, 0349) for the Spatial screen's side panels on fixture data: the Scenes tree (folders, search, the
// New menu, the empty state), the Outline (groups, counts, filter, eye and lock), the Inspector per kind of object, Scene
// settings over a mix, the Voices table from a readout, and the From take / From game scene / attenuation dialogs.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { AudioProject } from "../../../engine/audio/project/types";
import { mixerFixture } from "../mixer/mixerFixture";
import { InspectorPanel, type InspectorProps } from "./InspectorPanel";
import { OutlinePanel } from "./OutlinePanel";
import { ScenesPanel } from "./ScenesPanel";
import { deleteObject, renameObject, setHidden, setLocked } from "./sceneEdits";
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
    await expect(c.getByRole("tree", { name: "Matching scenes" })).toHaveTextContent(/drone_flyby\s*Moving sources/);
    await userEvent.clear(c.getByRole("searchbox", { name: "Search scenes" }));
    await userEvent.click(c.getByRole("button", { name: "More ways to create a test scene or folder" }));
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
        onLocked={(id, l) => { const r = setLocked(scene, id, l); if ("next" in r) setScene(r.next); }}
        onRename={(id, name) => { const r = renameObject(scene, id, name); if ("next" in r) setScene(r.next); }}
        onDelete={(id) => { const r = deleteObject(scene, id); if ("next" in r) setScene(r.next); }} />
    ));
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("treeitem", { name: "Emitters, 4" })).toBeVisible();
    // Rename and delete from a row (spec §4.4.3): double-click renames in place; the row's menu deletes.
    await userEvent.dblClick(c.getByRole("button", { name: "Generator" }));
    const field = c.getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Hum{Enter}");
    await expect(c.getByRole("button", { name: "Hum" })).toBeVisible();
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByRole("button", { name: "Hum" }) });
    await userEvent.click(within(document.body).getByRole("menuitem", { name: /Delete/ }));
    await expect(c.getByRole("treeitem", { name: "Emitters, 3" })).toBeVisible();
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
  attenuation: { summary: "Min 2.0 m · Max 40.0 m · ∿ Volume", owner: "Preset vehicle.attenuation.json, shared by the playlists that name it.", whyNotEdit: null, rolloff: true },
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

/** J9.2: an emitter playing a playlist that plays flat offers Make it 3D right here, not a trip to Playlists. */
const onMakeSpatial = fn();
export const InspectorFlatPlaylist: Story = {
  render: () => {
    return frame(320, 720, (
      <InspectorPanel
        {...inspector("emitter2", {
          attenuation: { summary: null, owner: "generator.playlist.json plays flat (2D). Make it 3D to hear it in place.", whyNotEdit: "generator.playlist.json plays flat (2D): make it 3D first", rolloff: false, makeSpatial: true },
          onMakeSpatial,
        })}
      />
    ));
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Edit attenuation…" })).toBeDisabled();
    const make = c.getByRole("button", { name: "Make it 3D" });
    await expect(make).toBeEnabled();
    await userEvent.click(make);
    await expect(onMakeSpatial).toHaveBeenCalledWith("emitter2");
    await expect(c.queryByText(/in Playlists/)).toBeNull();
  },
};

/** J9.3: a sound whose own setting turns occlusion off reads Off, never Clear through a wall. */
export const InspectorOcclusionOff: Story = {
  render: () => frame(320, 720, <InspectorPanel {...inspector("emitter1", { occlusionOn: () => false })} />),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Off (this sound)")).toBeVisible();
  },
};

/** UI pass IN2: in the default 300px dock the sound chip, › and × stay on one line; a long name gives way with an ellipsis. */
export const InspectorSoundNarrow: Story = {
  render: () => {
    const long = "audio/ambience/waterfall_distant_canyon_loop_with_birds.playlist.json";
    const scene = fixtureScene();
    const s = { ...scene, emitters: scene.emitters.map((e) => (e.id === "emitter1" ? { ...e, sound: long } : e)) };
    return frame(300, 720, <InspectorPanel {...inspector("emitter1")} scene={s} sounds={() => [{ path: long, kind: "playlist", badge: "QUE" }]} />);
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const chip = c.getByRole("button", { name: /waterfall_distant/ });
    const open = c.getByRole("button", { name: "Open in Playlists" });
    const clear = c.getByRole("button", { name: "Clear the sound" });
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    await expect(Math.abs(mid(open) - mid(chip))).toBeLessThan(2);
    await expect(Math.abs(mid(clear) - mid(chip))).toBeLessThan(2);
    await expect(clear.getBoundingClientRect().right).toBeLessThanOrEqual((canvasElement.firstElementChild as HTMLElement).getBoundingClientRect().right);
  },
};

export const InspectorMovingEmitter: Story = { render: () => frame(320, 720, <InspectorPanel {...inspector("emitter4")} />) };
export const InspectorAudioZone: Story = {
  render: () => frame(320, 720, <InspectorPanel {...inspector("zone1")} />),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/Zone depth/)).toBeVisible();
    await expect(within(canvasElement).getByText(/Heard from its nearest edge/)).toBeVisible();
    await expect(within(canvasElement).getByRole("radio", { name: "From its edge" })).toBeChecked();
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
    await userEvent.click(c.getByRole("button", { name: "Material" }));
    await expect(c.getByRole("textbox", { name: "Material name" })).toHaveValue("Material");
  },
};

/** UI pass SS3: in the default 300px dock the materials table fits: no column is cut off (Wet cut included). */
export const SettingsNarrow: Story = {
  render: () => frame(300, 640, <SettingsPanel mix={mixerFixture()} readOnly={false} onEdit={() => true} onEndDrag={fn()} />),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const table = canvasElement.querySelector<HTMLTableElement>(".sp-materials")!;
    const box = table.parentElement!.getBoundingClientRect();
    await expect(table.scrollWidth).toBeLessThanOrEqual(table.parentElement!.clientWidth);
    for (const name of ["Wet cut", "Low-pass Hz", "Loss dB"]) {
      const th = c.getByRole("columnheader", { name });
      await expect(th.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);
    }
  },
};

const onVoiceSolo = fn();
export const Voices: Story = {
  render: () => frame(640, 260, <VoicesPanel rows={voiceTable(fixtureScene(), fixtureVoices())} playing selected="emitter2" onSelect={fn()} onPlay={fn()} solo={null} muted={(id) => id === "emitter3"} onSolo={onVoiceSolo} onMute={fn()} />),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("row", { name: /Generator/ })).toHaveTextContent("Panned");
    await expect(c.getByRole("row", { name: /Drone/ })).toHaveTextContent("+34 ct");
    // Play and mute per row (spec §4.4.5).
    await expect(c.getByRole("button", { name: "Unmute Campfire" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Play Generator solo" }));
    await expect(onVoiceSolo).toHaveBeenCalledWith("emitter2");
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
  render: () => <TakeDialog takes={["recordings/canyon_run_04.sporesample"]} open={async () => ({ duration: 95, at: () => fixtureScene() })} onCreate={fn()} onCancel={fn()} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    await expect(await c.findByText(/At 0:00 of 1:35/)).toBeVisible();
    await expect(c.getByRole("button", { name: "Create" })).toBeEnabled();
  },
};

/**
 * UI pass SC10: the dialog opens inside a panel, yet its title is a dialog title (not the panel's caps heading); with no
 * takes the only button is a disabled Create, yet focus is in the dialog and Escape closes it.
 */
const cancelNoTakes = fn();
export const FromTakeNoTakes: Story = {
  render: () => (
    <div class="panel">
      <TakeDialog takes={[]} open={async () => ({ duration: 0, at: () => fixtureScene() })} onCreate={fn()} onCancel={cancelNoTakes} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    const dialog = c.getByRole("dialog", { name: "New test scene from a take" });
    await waitFor(() => expect(dialog).toHaveFocus());
    const title = within(dialog).getByRole("heading", { name: "New test scene from a take" });
    await expect(getComputedStyle(title).textTransform).toBe("none");
    await expect(getComputedStyle(title).fontWeight).toBe("600");
    cancelNoTakes.mockClear();
    await userEvent.keyboard("{Escape}");
    await expect(cancelNoTakes).toHaveBeenCalledOnce();
  },
};

export const AttenuationChoice: Story = { render: () => <AttenuationChoiceDialog playlist="audio/sfx/drone.playlist.json" onChoose={fn()} onCancel={fn()} /> };
