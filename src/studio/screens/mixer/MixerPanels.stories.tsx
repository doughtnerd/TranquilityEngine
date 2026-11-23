// Stories (ADR 0219, 0344) for the Mixer screen's panels over fixture projects (the prototype's mix, and an empty
// project with Master only): the Buses panel in List and Strips views with the live board, editing a snapshot (faders
// write its offsets, the base level as a ghost tick), running with meters, the Inspector for a bus, a return and a
// VCA with a snapshot's effect overrides, the Snapshots tree, the Trigger dialog with conditions and overlaps, and the
// Gain lanes, Game parameters, Global parameters and Loudness panels, and Automate ◆ opening the shared curve editor.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useMemo } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { UndoToasts } from "../../../editor/ui/UndoToast";
import { createToastQueue } from "../../../editor/ui/undoToastModel";
import type { AudioProject } from "../../../engine/audio/project/types";
import { BusesPanel } from "./BusesPanel";
import { MixerInspector } from "./MixerInspector";
import { emptyMix, mixerFixture } from "./mixerFixture";
import type { MixerSession } from "./mixerScreen";
import { fakeMixer, type FakeOptions } from "./mixerStoryData";
import { GainLanesPanel, LoudnessPanel, ParametersPanel } from "./SidePanels";
import { GlobalParametersPanel } from "./GlobalParametersPanel";
import { sessionParametersHost } from "./globalParametersHost";
import { SnapshotsPanel } from "./SnapshotsPanel";
import { TriggerDialog, TriggerDialogHost } from "./TriggerDialog";
import { NewGlobalParameterHost } from "./newGlobalParameter";
import "../../components/audioParts.css";
import "../../components/studioComponents.css";
import "./mixer.css";

type Which = "buses" | "inspector" | "snapshots" | "trigger" | "gain" | "parameters" | "globalParameters" | "loudness";

interface ScreenArgs {
  readonly which: Which;
  readonly project?: () => AudioProject;
  readonly options?: FakeOptions;
  readonly setup?: (s: MixerSession) => void;
  readonly width?: number;
}

const toasts = createToastQueue();

function Screen(props: ScreenArgs) {
  const session = useMemo(() => {
    const f = fakeMixer((props.project ?? mixerFixture)(), { ...props.options, extra: { ...props.options?.extra, toast: (t) => void toasts.show(t) } });
    props.setup?.(f.session);
    return f.session;
  }, []);
  const p = session.project.value;
  return (
    <div style={{ width: `${props.width ?? 900}px`, height: "560px", display: "flex", flexDirection: "column", overflow: "auto" }}>
      {props.which === "buses" && <BusesPanel session={session} />}
      {props.which === "inspector" && <MixerInspector session={session} />}
      {props.which === "snapshots" && <SnapshotsPanel session={session} />}
      {props.which === "trigger" && <TriggerDialog session={session} snapshot={p.snapshots.find((s) => s.name === "Underwater")!} onClose={() => {}} />}
      {props.which === "gain" && <GainLanesPanel session={session} />}
      {props.which === "parameters" && <ParametersPanel session={session} />}
      {props.which === "globalParameters" && <GlobalParametersPanel host={sessionParametersHost(session)} />}
      {props.which === "loudness" && <LoudnessPanel session={session} />}
      <TriggerDialogHost />
      <NewGlobalParameterHost />
      <UndoToasts queue={toasts} />
    </div>
  );
}

const meta = { title: "Studio/Mixer/Screen", component: Screen } satisfies Meta<ScreenArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BusesList: Story = {
  args: { which: "buses" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = c.getByRole("listbox", { name: "Buses" });
    await expect(within(list).getAllByRole("option").map((o) => o.getAttribute("data-bus-row"))).toEqual(["Master", "SFX", "Vehicles", "Engine", "Footsteps", "Weapons", "Ambience", "Rain", "Dialogue", "Music", "UI"]);
    await expect(c.getByText("Beds 2/2 · 1 sharing")).toBeTruthy();
    // Each row says what's on it; a return its sends, a VCA its buses (spec §4.3.3).
    await expect(canvasElement.querySelector('[data-bus-row="Ambience"] .mx-meta')).toHaveTextContent("fx 1 · auto 2");
    await expect(c.getByText("fx 1 · ← 3 sends")).toBeTruthy();
    await expect(c.getByText("3 buses")).toBeTruthy();
    // Branch colours: SFX's buses share SFX's colour, Ambience's branch has the next one.
    const stripe = (bus: string) => (canvasElement.querySelector(`[data-bus-row="${bus}"] .mx-stripe`) as HTMLElement).style.background;
    await expect(stripe("Engine")).toBe(stripe("SFX"));
    await expect(stripe("Rain")).not.toBe(stripe("SFX"));
    // The bed column in the spec's notation; the VCA's value under the dB field.
    await expect(canvasElement.querySelector('[data-bus-row="Rain"] .mx-bed')).toHaveTextContent("→ Ambience · p60");
    await userEvent.click(c.getByRole("button", { name: "Collapse SFX" }));
    await expect(within(list).queryByText("Engine")).toBeNull();
    await expect(canvasElement.querySelector('[data-bus-row="SFX"] .mx-meta')).toHaveTextContent("+4 inside");
  },
};

/** Strips view is a console: kind, typed dB, voices; right-clicking a strip opens the bus menu (MX-23). */
export const StripsMenu: Story = {
  args: { which: "buses", setup: (s) => void (s.view.value = "strips") },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const music = c.getByRole("group", { name: "Music" });
    await expect(music).toHaveTextContent("Bus · to Master");
    await expect(within(music).getByRole("textbox", { name: "Music level in dB" })).toHaveValue("−10.0");
    await expect(within(c.getByRole("group", { name: "Vehicles" })).getByText("Voices ↑ 48")).toBeTruthy();
    await userEvent.pointer({ keys: "[MouseRight]", target: within(music).getByText("Music", { selector: ".mx-strip-name" }) });
    const menu = await body.findByRole("menu", { name: "Music menu" });
    await expect(within(menu).getByRole("menuitem", { name: "Add child bus" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
  },
};

/** The toolbar keeps the count of the edits made while the game session played ("N edits kept"). */
export const ToolbarEditsKept: Story = {
  args: {
    which: "buses",
    setup: (s) => {
      // The session is live for one edit, then stops.
      let live = true;
      (s.deps as { sessionLive?: () => boolean }).sessionLive = () => live;
      s.sessionLive();
      s.commit({ next: { ...s.project.peek(), buses: s.project.peek().buses.map((b) => (b.name === "UI" ? { ...b, volumeDb: -9 } : b)) } }, "Set level · UI");
      live = false;
    },
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".mx-toolbar [role=status]")).toHaveTextContent("1 edit kept");
  },
};

/** A bus's menu has Move to… (re-route without dragging, for touch) and Undo; the rows don't take a text selection while dragged. */
export const BusMenuMoveTo: Story = {
  args: { which: "buses" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await expect(getComputedStyle(c.getByText("Music", { selector: ".mx-name" })).userSelect).toBe("none");
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Music", { selector: ".mx-name" }) });
    const menu = await body.findByRole("menu", { name: "Music menu" });
    await expect(within(menu).getByRole("menuitem", { name: /^Undo/ })).toBeTruthy();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to…" }));
    const dialog = await body.findByRole("dialog", { name: "Move “Music” to" });
    await userEvent.click(within(dialog).getByText("UI")); // one click on an allowed folder moves
    const list = c.getByRole("listbox", { name: "Buses" });
    const order = within(list).getAllByRole("option").map((o) => o.getAttribute("data-bus-row"));
    await expect(order.slice(order.indexOf("UI"), order.indexOf("UI") + 2)).toEqual(["UI", "Music"]);
  },
};

export const BusesStrips: Story = { args: { which: "buses", setup: (s) => void (s.view.value = "strips") } };

export const EditingASnapshot: Story = {
  args: { which: "buses", setup: (s) => s.editSnapshot("Underwater") },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Every Music fader (the row's and the board's) shows the level in the snapshot.
    for (const fader of c.getAllByRole("slider", { name: "Music level" })) await expect(fader).toHaveAttribute("aria-valuenow", "-16");
  },
};

/** A snapshot edited on a bus under a VCA that isn't at 0 dB: the base-level tick and the VCA tick together. */
export const SnapshotWithVcaTicks: Story = {
  args: {
    which: "buses",
    project: () => {
      const p = mixerFixture();
      return { ...p, vcas: p.vcas.map((v) => (v.name === "Gameplay SFX" ? { ...v, volumeDb: -4 } : v)) };
    },
    setup: (s) => s.editSnapshot("Underwater"),
  },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector('[data-bus-row="Footsteps"]')!;
    await expect(row.querySelector(".studio-fader-ghost.vca")).toHaveAttribute("title", "With VCAs: -22.0 dB");
    await expect(row.querySelector(".studio-fader-ghost.base")).toHaveAttribute("title", "Base level: -6.0 dB");
  },
};

/** Automate ◆ on an effect opens the shared curve editor on every lane of the bus. */
export const AutomateOpensCurves: Story = {
  args: { which: "inspector", width: 360, setup: (s) => s.select("Ambience") },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Automate Low-pass" }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    await expect(dialog).toHaveTextContent("Low-pass cutoff");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  },
};

export const LiveWithMeters: Story = {
  args: {
    which: "buses",
    options: { running: true, readings: { Master: { volume: 1, duckGain: 1, peak: 0.7, activeVoices: 6 }, Music: { volume: 1, duckGain: 0.5, peak: 0.3, activeVoices: 2 }, SFX: { volume: 1, duckGain: 1, peak: 0.9, activeVoices: 4 } } },
  },
};

export const EmptyProject: Story = { args: { which: "buses", project: emptyMix } };

export const InspectorBus: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Dialogue") } };

export const InspectorSnapshotOverrides: Story = {
  args: { which: "inspector", width: 360, setup: (s) => { s.select("Ambience"); s.editSnapshot("Underwater"); } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("group", { name: "Overrides in Underwater" })).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Clear override" }));
    await expect(c.queryByRole("group", { name: "Overrides in Underwater" })).toBeNull();
  },
};

/**
 * A snapshot offset that isn't a round number (a fader drag), in a short, narrow Inspector: the note reads it to 0.1 dB
 * on a row of its own, and no field row overlaps the next (the Bed row wraps; MX-26).
 */
export const InspectorRowsDontOverlap: Story = {
  args: {
    which: "inspector",
    width: 300,
    project: () => {
      const p = mixerFixture();
      return { ...p, snapshots: p.snapshots.map((s) => (s.name === "Underwater" ? { ...s, buses: { ...s.buses, Ambience: -6.02059991 } } : s)) };
    },
    setup: (s) => { s.select("Ambience"); s.editSnapshot("Underwater"); },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(/Underwater: −6\.0 dB on the base level/)).toBeTruthy();
    await expect(canvasElement.textContent).not.toContain("6.0205");
    const rows = [...canvasElement.querySelectorAll<HTMLElement>(".mx-inspector > *")].filter((el) => el.getBoundingClientRect().height > 0);
    for (let i = 1; i < rows.length; i++) {
      const above = rows[i - 1]!.getBoundingClientRect();
      const below = rows[i]!.getBoundingClientRect();
      await expect(below.top, `${rows[i]!.textContent?.slice(0, 30)} starts below ${rows[i - 1]!.textContent?.slice(0, 30)}`).toBeGreaterThanOrEqual(above.bottom - 0.5);
    }
    for (const field of canvasElement.querySelectorAll<HTMLElement>(".mx-ifield")) {
      const box = field.getBoundingClientRect();
      for (const part of field.children) {
        await expect(part.getBoundingClientRect().bottom, `${field.textContent?.slice(0, 30)} holds its content`).toBeLessThanOrEqual(box.bottom + 0.5);
      }
    }
  },
};

export const InspectorReturn: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Reverb") } };

/** "→ X dB": the level automation reaches now at the test values (spec §4.3.4), and Used by lists the playlists routed here. */
export const InspectorAutomatedAndUsedBy: Story = {
  args: {
    which: "inspector",
    width: 360,
    options: { usersOf: (n) => (n === "Music" ? ["audio/music/Theme.playlist.json", "audio/music/Combat.playlist.json", "scenes/a.scene.json"] : []) },
    setup: (s) => { s.select("Music"); s.setTestValue("threat", 1); },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("→ −13.0 dB")).toBeTruthy();
    await expect(c.getByText("→ −13.0 dB").getAttribute("title")).toBe("Driven by threat (now 1)");
    const used = c.getByRole("region", { name: "Used by" });
    await expect([...used.querySelectorAll(".mx-link")].map((b) => b.textContent)).toEqual(["Combat", "Theme"]);
    await expect(canvasElement.querySelector(".mx-ititle")).toHaveTextContent("BusMusic");
  },
};
export const InspectorVca: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Gameplay SFX") } };

export const Snapshots: Story = {
  args: { which: "snapshots", width: 280, setup: (s) => s.setTestValue("depth", 4) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("Underwater"));
    await expect(c.getByRole("treeitem", { name: /Underwater/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.type(c.getByRole("searchbox", { name: "Search snapshots" }), "health");
    await expect(c.getByRole("tree", { name: "Matching snapshots" })).toBeTruthy();
  },
};

/** A new folder renamed, then + New: the snapshot goes into the renamed folder and no "New folder" is left behind (MX-41). */
export const SnapshotsNewFolderRenamed: Story = {
  args: { which: "snapshots", width: 280 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(c.getByRole("button", { name: "More: New snapshot, New folder" }));
    await userEvent.click(within(await body.findByRole("menu", { name: "New" })).getByRole("menuitem", { name: /New folder/ }));
    const input = await c.findByRole("textbox", { name: "Folder name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Combat{Enter}");
    await userEvent.click(c.getByRole("button", { name: "New snapshot" }));
    await userEvent.keyboard("Boss fight{Enter}");
    const tree = c.getByRole("tree", { name: "Snapshots" });
    await expect(within(tree).queryByRole("treeitem", { name: /^New folder/ })).toBeNull();
    const combat = within(tree).getByRole("treeitem", { name: /^Combat/ });
    await expect(within(combat).getByRole("treeitem", { name: /Boss fight/ })).toBeTruthy();
  },
};

/** Renaming a folder keeps it the place + New files into, and a refused name (a folder already there) says why. */
export const SnapshotsRenameKeptFolder: Story = {
  args: { which: "snapshots", width: 280 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(c.getByRole("button", { name: "More: New snapshot, New folder" }));
    await userEvent.click(within(await body.findByRole("menu", { name: "New" })).getByRole("menuitem", { name: /New folder/ }));
    const input = await c.findByRole("textbox", { name: "Folder name" });
    await userEvent.clear(input);
    await userEvent.type(input, "States{Enter}");
    const tree = c.getByRole("tree", { name: "Snapshots" });
    await expect(within(tree).getByRole("treeitem", { name: /^New folder/ })).toBeTruthy();
    await expect(within(tree).getAllByRole("treeitem", { name: /^States/ })).toHaveLength(1);
  },
};

/** The snapshot menu ends with Undo and "Delete snapshot"; a folder's menu has Move to top level (spec §4.3.2, MX-44). */
export const SnapshotMenus: Story = {
  args: { which: "snapshots", width: 280, project: () => { const p = mixerFixture(); return { ...p, snapshots: p.snapshots.map((s) => (s.name === "Cinematic" ? { ...s, folder: "States/Cut" } : s)) }; } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Underwater") });
    let menu = await body.findByRole("menu", { name: "Snapshot menu" });
    await expect(within(menu).getByRole("menuitem", { name: /^Undo/ })).toBeTruthy();
    await expect(within(menu).getByRole("menuitem", { name: /Delete snapshot/ })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByText("Cut") });
    menu = await body.findByRole("menu", { name: "Snapshot menu" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to top level" }));
    const tree = c.getByRole("tree", { name: "Snapshots" });
    await expect(within(tree).getByRole("treeitem", { name: /^Cut/ }).parentElement).toBe(tree);
  },
};

export const Trigger: Story = {
  args: { which: "trigger", setup: (s) => s.setTestValue("depth", 2) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    await expect(c.getByText(/True now with the test values/)).toBeVisible();
    const overlaps = c.getByRole("list", { name: "Overlapping snapshots" });
    await expect(overlaps).toHaveTextContent("Pause menu wins (priority 40 over 20).");
    await expect(overlaps).toHaveTextContent("priority 40 · also changes SFX, Ambience, Music");
    // Every parameter list is an in-app dropdown naming each parameter's type, ending with "+ New parameter…" (J4.1).
    await userEvent.click(c.getAllByRole("button", { name: /^Parameter:/ })[0]!);
    const menu = await c.findByRole("menu", { name: "Parameter" });
    await expect(within(menu).getByRole("menuitemradio", { name: /inCombat/ })).toHaveTextContent("true / false");
    await expect(within(menu).getAllByRole("menuitem").at(-1)!).toHaveTextContent("+ New parameter…");
    // A true / false parameter compares with "is true" / "is false" and needs no value.
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /inCombat/ }));
    const row = c.getByRole("group", { name: "Condition 1" });
    await expect(within(row).getByRole("button", { name: /^Comparison:/ })).toHaveAccessibleName("Comparison: is true");
    await expect(within(row).queryByRole("spinbutton")).toBeNull();
  },
};

/** Two snapshots overriding the same effect parameter: the clash card names it in words, never by an internal id. */
export const TriggerNoInternalIds: Story = {
  args: {
    which: "trigger",
    project: () => {
      const p = mixerFixture();
      return { ...p, snapshots: p.snapshots.map((s) => (s.name === "Pause menu" ? { ...s, effects: { Ambience: { fx1: { cutoff: 400 } } } } : s)) };
    },
  },
  play: async ({ canvasElement }) => {
    const overlaps = within(canvasElement.ownerDocument.body).getAllByRole("list", { name: "Overlapping snapshots" }).at(-1)!;
    await expect(overlaps.closest("li, ul")!.innerHTML).not.toContain("fx1");
    await expect(overlaps.querySelector(".mx-clr")!.getAttribute("title")).toContain("Ambience › Low-pass cutoff");
  },
};

export const GainLanesOfABus: Story = { args: { which: "gain", width: 300, setup: (s) => { s.select("Music"); s.editSnapshot("Underwater"); s.setTestValue("threat", 1); } } };
/** Test values per type: a slider and field for a number, a checkbox for true / false, a dropdown for a state or text. */
export const GameParameters: Story = {
  args: { which: "parameters", width: 320 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const box = c.getByRole("checkbox", { name: "inCombat" });
    await expect(box).not.toBeChecked();
    await userEvent.click(box);
    await expect(box).toBeChecked();
    await expect(c.getByRole("button", { name: "surface: Dirt" })).toBeTruthy();
    await expect(c.getByRole("button", { name: "gameState: Playing" })).toBeTruthy();
  },
};

/** J4.1: a new project has no game parameters; "+ New parameter…" makes one right here (one undo step of audio.json). */
export const GameParametersNewProject: Story = {
  args: { which: "parameters", width: 320, project: emptyMix },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "New parameter…" }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "New parameter" }));
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "rpm");
    await userEvent.clear(dialog.getByRole("spinbutton", { name: "Max" }));
    await userEvent.type(dialog.getByRole("spinbutton", { name: "Max" }), "8000");
    await userEvent.click(dialog.getByRole("button", { name: "Create" }));
    await expect(c.getByText("rpm")).toBeVisible();
    await expect(within(canvasElement.ownerDocument.body).queryByRole("dialog", { name: "New parameter" })).toBeNull();
  },
};

/** J6.5: Automate ◆ on a project with no game parameters asks for one, then opens the curves driven by it. */
export const AutomateNewProject: Story = {
  args: { which: "inspector", width: 360, project: emptyMix, setup: (s) => s.select("Master") },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Automate Master's level" }));
    // (Earlier stories' screens stay mounted in the test page, each with its host: they all show the one request.)
    const ask = within((await body.findAllByRole("dialog", { name: "New parameter" })).at(-1)!);
    await userEvent.click(ask.getByRole("radio", { name: /Labels/ }));
    await expect(ask.getByRole("textbox", { name: "Labels" })).toBeVisible();
    await userEvent.click(ask.getByRole("radio", { name: /Number/ }));
    await userEvent.click(ask.getByRole("button", { name: "Create" }));
    // Dialogs from earlier stories may still be in the page's floating root: the curves are the newest.
    const curves = (await body.findAllByRole("dialog")).at(-1)!;
    await expect(curves).toHaveTextContent("Parameter");
    await userEvent.click(within(curves).getByRole("button", { name: "Cancel" }));
  },
};

export const GlobalParameters: Story = {
  args: { which: "globalParameters", width: 340 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("group", { name: "Parameter depth" })).toBeTruthy();
    await expect(c.getByRole("button", { name: "Remove parameter threat" }).getAttribute("title")).toContain("2 automation lanes");
    await userEvent.click(c.getByRole("button", { name: "+ Parameter" }));
    await expect(c.getByRole("group", { name: "Parameter Parameter" })).toBeTruthy();
  },
};
export const LoudnessNotPlaying: Story = { args: { which: "loudness" } };
export const LoudnessPlaying: Story = { args: { which: "loudness", options: { running: true, loudness: { momentary: -14.2, shortTerm: -15.8, integrated: -16.4, lra: 7.2, maxTruePeak: -0.6, tainted: false } } } };
