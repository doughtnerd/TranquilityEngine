// Stories (ADR 0219, 0348, 0349) for the Take screen's views over the fixture take (built through the take record
// writers): the timeline replayed by a real `TakeReplay` on a silent target (play, scrub, select an instance, add and
// drag notes with the notes edits), the Takes tree and its empty state, the Inspector's instance and note details and
// the Mixer strip.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useMemo, useState } from "preact/hooks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { performanceClock, TakeReplay, type ReplayTarget } from "../../runtime/takeReplay";
import { addMarker, moveNote, type NotesEdit } from "./notesEdits";
import { InstanceDetails, MixerStrip, NoteDetails, PlayheadValues, PropertyCards } from "./TakeInspector";
import type { PropertyCard } from "./takePlaylists";
import { busStrip, instanceParametersAt, parameterRows } from "./takeInspectorModel";
import { FIXTURE_NOTES, SURFACE_LABELS, fixtureTake } from "./takeFixture";
import { TakeList } from "./TakeList";
import type { TakeSelection } from "./takeScreen";
import { playlistsInTake, takeTimeline } from "./takeTimeline";
import { PlaylistsInTake } from "./PlaylistsInTake";
import { DockLayout } from "../../../editor/layout/DockLayout";
import { screenDock } from "../../shell/studioPanels";
import { TAKE_PANELS } from ".";
import "../../studio.css";
import { TakeTimelineView } from "./TakeTimelineView";
import "./take.css";

/** A target that plays nothing (the stories have no audio runtime). */
const silent: ReplayTarget = {
  play: () => null, setGlobal() {}, busVolume() {}, snapshot() {}, clearSnapshot() {}, masterVolume: () => 1, listener() {}, seed: () => true,
};

function TimelineDemo(props: { start?: number; heatmap?: boolean }) {
  const take = useMemo(() => fixtureTake(), []);
  const replay = useMemo(() => new TakeReplay(take, silent, performanceClock), [take]);
  const timeline = useMemo(() => takeTimeline(take, (name, path) => (name === "Surface" && path === null ? SURFACE_LABELS : null)), [take]);
  const [notes, setNotes] = useState<TakeNotes>(FIXTURE_NOTES);
  const [selected, setSelected] = useState<TakeSelection>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    if (props.start) replay.seek(props.start);
    let id = requestAnimationFrame(function loop() {
      replay.tick();
      id = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(id);
      replay.dispose();
    };
  }, [replay]);
  const apply = (e: NotesEdit, select = false) => {
    if ("refused" in e) return;
    setNotes(e.next);
    if (select) setSelected({ kind: "note", id: e.id });
  };
  return (
    <div style={{ width: "960px" }}>
      <button type="button" onClick={() => replay.toggle()}>{replay.playing.value ? "Pause" : "Replay"}</button>
      <TakeTimelineView
        timeline={timeline}
        heatmap={props.heatmap}
        time={replay.time.value}
        playing={replay.playing.value}
        selected={selected}
        notes={notes}
        notesWritable
        name="canyon_run_03"
        plays={(path) => (path.includes("engine") ? "until stopped · Layer" : "one-shot")}
        drives={(name) => (name === "Speed" ? "Drives pitch, low-pass on engine" : "")}
        muted={replay.muted.value}
        soloed={replay.soloed.value}
        onMute={(path, on) => replay.setMuted(path, on)}
        onSolo={(path, on) => replay.setSoloed(path, on)}
        hovered={hovered}
        onHover={setHovered}
        onSeek={(t) => replay.seek(t)}
        onSelectInstance={(key) => setSelected({ kind: "instance", key })}
        onOpenInstance={fn()}
        onSelectNote={(id) => setSelected({ kind: "note", id })}
        onMoveNote={(id, at) => apply(moveNote(notes, id, at, take.duration))}
        onAddMarker={(at) => apply(addMarker(notes, at, take.duration), true)}
      />
      <output aria-label="Selected">{selected ? (selected.kind === "instance" ? selected.key : selected.id) : ""}</output>
      <output aria-label="Markers">{notes.markers.length}</output>
      <output aria-label="Hovered">{hovered ?? ""}</output>
    </div>
  );
}

const meta: Meta = { title: "Studio/Take/Panels" };
export default meta;
type Story = StoryObj;

export const Timeline: Story = {
  render: () => <TimelineDemo start={20.5} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("listbox", { name: "engine instances" })).toBeVisible());
    await expect(canvasElement.querySelector(".tk-segment[title='Rock']")).not.toBeNull(); // Surface as labelled segments
    await userEvent.click(c.getByRole("option", { name: /Velocity 0.71/ }));
    await expect(c.getByLabelText("Selected").textContent).toMatch(/^4@/);
  },
};

/** Experimental heatmap: each lane's instances coloured by how often its playlist played in the take (here each once: all cold). */
export const Heatmap: Story = {
  render: () => <TimelineDemo heatmap />,
  play: async ({ canvasElement }) => {
    const spans = await waitFor(() => {
      const all = [...canvasElement.querySelectorAll<HTMLElement>(".studio-span.heat")];
      if (all.length === 0) throw new Error("no heat yet");
      return all;
    });
    await expect(spans.map((s) => Number(s.style.getPropertyValue("--heat")))).toEqual(spans.map(() => 0));
    await expect(spans[0]!.title).toMatch(/played once/);
  },
};

export const RulerAndLanes: Story = {
  render: () => <TimelineDemo start={20.48} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The ruler's head reads the playhead; the lanes say how each playlist plays; game lanes say what they drive.
    await waitFor(() => expect(canvasElement.querySelector(".run-readout")?.textContent).toBe("00:20.480"));
    await expect(c.getByRole("slider", { name: "Take time" })).toHaveAttribute("aria-valuetext", "00:20.480");
    await expect(c.getByText("Gameplay take")).toBeVisible();
    await expect(c.getByText("Game · Speed")).toBeVisible();
    await expect(c.getByText("Drives pitch, low-pass on engine")).toBeVisible();
    // Hovering a game lane's head is the link to the Inspector's cards.
    await userEvent.hover(c.getByText("Game · Speed"));
    await expect(c.getByLabelText("Hovered").textContent).toBe("Speed");
  },
};

export const MuteAndSolo: Story = {
  render: () => <TimelineDemo start={2} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const mute = await c.findByRole("button", { name: "Mute engine" });
    await userEvent.click(mute);
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await expect(mute.closest(".tk-row")!.className).toMatch(/silent/);
    await userEvent.click(c.getByRole("button", { name: "Solo boost" }));
    // While a lane is soloed every other lane is silent.
    await expect(c.getByRole("button", { name: "Solo boost" }).closest(".tk-row")!.className).not.toMatch(/silent/);
  },
};

export const InspectorCards: Story = {
  render: () => {
    const [hovered, setHovered] = useState<string | null>("Speed");
    const cards: PropertyCard[] = [
      { key: "v", label: "Volume", authored: -6, live: -6, unit: "dB", authoredAt: 0.75, liveAt: 0.75, text: "−6.0 dB", driver: null },
      { key: "p", label: "Pitch", authored: 0, live: 4.2, unit: "st", authoredAt: 0.5, liveAt: 0.59, text: "+4.2 st", driver: { parameter: "Speed", mapping: "−3 to +7 st · ease-in · seek 50/s" } },
      { key: "r", label: "Reverb send", authored: -18, live: -9, unit: "dB", authoredAt: 0.58, liveAt: 0.71, text: "−9.0 dB", driver: { parameter: "Surface", mapping: "−18 to −9 dB · steps" } },
    ];
    return (
      <div style={{ width: "300px" }}>
        <PropertyCards cards={cards} hovered={hovered} onHover={setHovered} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The chips the hovered game parameter drives are outlined; the static card's fill is muted, the driven one accent2.
    await expect(c.getByText("← Speed").className).toMatch(/linked/);
    await expect(c.getByText("← Surface").className).not.toMatch(/linked/);
    await userEvent.hover(c.getByText("← Surface"));
    await expect(c.getByText("← Surface").className).toMatch(/linked/);
    await expect(c.getByRole("listitem", { name: /Pitch \+4.2 st, authored \+0.0 st|Pitch \+4.2 st, authored 0.0 st/ })).toBeVisible();
  },
};

export const Pictures: Story = {
  render: () => <TimelineDemo start={12.5} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const strip = await c.findByRole("group", { name: "Pictures of the game view" });
    // The picture on screen at the playhead is marked and always among the thumbnails.
    await waitFor(() => expect(within(strip).getByRole("button", { current: true })).toHaveAccessibleName("Picture at 12.020 s"));
    // A click on another moves the playhead to it.
    await userEvent.click(within(strip).getAllByRole("button")[0]!);
    await waitFor(() => expect(within(strip).getByRole("button", { current: true })).toHaveAccessibleName("Picture at 0.020 s"));
  },
};

export const PictureAtThePlayhead: Story = {
  render: () => {
    const take = fixtureTake();
    return (
      <div style={{ width: "300px" }}>
        <PlayheadValues open time={8.4} picture={take.frameAt(8.4)} values={[{ name: "Speed", text: "200" }]} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("img", { name: "The game view at 8.020 s" })).toBeVisible();
    await expect(c.getByText("Game view at 8.020 s")).toBeVisible();
  },
};

export const AddANote: Story = {
  render: () => <TimelineDemo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const lane = await c.findByRole("listbox", { name: "Notes and game marks" });
    await userEvent.dblClick(lane);
    await expect(c.getByLabelText("Markers").textContent).toBe("3");
  },
};

export const Replaying: Story = {
  render: () => <TimelineDemo start={5} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Replay" }));
    await expect(c.getByRole("button", { name: "Pause" })).toBeVisible();
  },
};

const FILES = ["recordings/HoverBike/Canyon/canyon_run_01.sporesample", "recordings/HoverBike/Canyon/canyon_run_03.sporesample", "recordings/HoverBike/Canyon/canyon_run_03.sporesample.notes.json", "recordings/Boss/boss_arena_01.sporesample", "recordings/capture_01.sporesample"];
const listArgs = {
  folders: ["recordings", "recordings/HoverBike", "recordings/HoverBike/Canyon", "recordings/Boss"], writable: true,
  onOpen: fn(), onImport: fn(), onRename: fn(), onMove: fn(), onDelete: fn(), onDuplicate: fn(), onRenameFolder: fn(), onDeleteFolder: fn(), onNewFolder: fn(async () => null),
};

export const Takes: Story = {
  render: () => <div style={{ width: "280px" }}><TakeList files={FILES} openPath="recordings/HoverBike/Canyon/canyon_run_03.sporesample" {...listArgs} /></div>,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("canyon_run_01")).toBeVisible();
    await expect(c.getByText("capture_01")).toBeVisible(); // every recording is listed, a capture too (ADR 0409)
    await expect(c.queryByText("canyon_run_03.sporesample.notes.json")).toBeNull();
  },
};

export const NoTakes: Story = {
  render: () => <div style={{ width: "280px" }}><TakeList files={["audio.json"]} openPath={null} {...listArgs} folders={[]} /></div>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/F10 in a game build/)).toBeVisible();
  },
};

export const Instance: Story = {
  render: () => {
    const take = fixtureTake();
    const engine = takeTimeline(take).lanes[0]!.instances[0]!;
    const rows = parameterRows(instanceParametersAt(take, engine, 12), (n) => (n === "Rpm" ? 4321 : undefined));
    return (
      <div style={{ width: "300px" }}>
        <InstanceDetails instance={engine} emitterName="Bike" emitterPose={{ position: { x: 175.6, y: 1, z: 0 } }} rows={rows} kind="Layer" cards={[]} live onOpenSource={fn()} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("4321")).toBeVisible();
    await expect(c.getByRole("button", { name: /Open .* in Playlists/ })).toBeVisible();
  },
};

export const Note: Story = {
  render: () => (
    <div style={{ width: "300px" }}>
      <NoteDetails note={{ kind: "region", ...FIXTURE_NOTES.regions[0]! }} writable onText={fn()} onColour={fn()} onTime={fn()} onSpan={fn()} onDelete={fn()} onGoTo={fn()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // The note's fields use the editor's font and field tokens, not the browser's monospace textarea and inset number box.
    const text = within(canvasElement).getByRole("textbox", { name: "Note text" });
    const panelFont = getComputedStyle(canvasElement.querySelector(".tk-inspector")!).fontFamily;
    await expect(getComputedStyle(text).fontFamily).toBe(panelFont);
    for (const field of [text, ...within(canvasElement).getAllByRole("spinbutton")]) {
      await expect(getComputedStyle(field).borderTopWidth).toBe("1px");
      await expect(getComputedStyle(field).borderTopStyle).toBe("solid");
    }
  },
};

export const DefaultDock: Story = {
  render: () => {
    // The screen's real panel list and default layout, each panel's view a stand-in (the views need the running app).
    const dock = screenDock("take", TAKE_PANELS.map((p) => ({ ...p, view: () => <p>{p.title}</p> })));
    dock.store.reset();
    return (
      <div class="studio" style={{ width: "1200px", height: "520px", gridTemplateRows: "1fr", gridTemplateAreas: '"main"' }}>
        <main class="studio-dock">
          <DockLayout host={dock.host} view={(type) => dock.panels.get(type)?.view() ?? null} />
        </main>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Both tabs of the left dock show at its default width: the playlists tab isn't hidden behind the overflow button.
    // The docks are sized once the layout has measured itself; the tabs are fitted after that.
    await waitFor(() => expect(c.getByRole("tab", { name: "Takes" }).closest<HTMLElement>(".dock-tabs")!.clientWidth).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    for (const p of TAKE_PANELS.filter((x) => x.dock === "left")) await expect(c.getByRole("tab", { name: p.title })).toBeVisible();
    await expect(c.queryByRole("button", { name: "More tabs" })).toBeNull();
  },
};

/** The box of `el` (inside the story's canvas). */
const box = (el: Element) => el.getBoundingClientRect();

export const HeldPart: Story = {
  render: () => <TimelineDemo start={8} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The boost is held 5.6 → 7.4 s; its held part is shaded in --accent2-soft, unlike the bar's own fill.
    const boost = await c.findByRole("option", { name: /boost · instance 1 · held 1\.8 s/ });
    const held = boost.querySelector(".studio-span-held")!;
    await expect(held).not.toBeNull();
    const probe = document.createElement("span");
    probe.style.background = "var(--accent2-soft)";
    canvasElement.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    await expect(getComputedStyle(held).backgroundColor).toBe(want);
    await expect(getComputedStyle(held).backgroundColor).not.toBe(getComputedStyle(boost).backgroundColor);
  },
};

export const InThisTake: Story = {
  render: () => {
    const rows = playlistsInTake(takeTimeline(fixtureTake()));
    return <div style={{ width: "240px" }}><PlaylistsInTake rows={rows} onOpen={fn()} /></div>;
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Each row is one button (folder / name, count) on one line: nothing wraps under it at the dock's default width.
    const rows = c.getAllByRole("button");
    await expect(rows.length).toBeGreaterThan(3);
    await expect(c.getByRole("button", { name: /vehicles \/ engine\s*1 instance/ })).toBeVisible();
    for (const r of rows) await expect(box(r).height).toBeLessThanOrEqual(30);
    await expect(c.queryByText("Open in Playlists")).toBeNull();
  },
};

const openPlaylist = fn();

export const InThisTakeOpens: Story = {
  render: () => <div style={{ width: "240px" }}><PlaylistsInTake rows={[{ path: "audio/events/boost.playlist.json", label: "events / boost", count: 2 }]} onOpen={openPlaylist} /></div>,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /events \/ boost/ }));
    await expect(openPlaylist).toHaveBeenCalledWith("audio/events/boost.playlist.json");
  },
};

export const SearchField: Story = {
  render: () => <div style={{ width: "280px" }}><TakeList files={FILES} openPath={null} {...listArgs} /></div>,
  play: async ({ canvasElement }) => {
    // The screen's search uses the editor's field tokens, not the browser's inset default.
    const search = within(canvasElement).getByRole("searchbox", { name: "Search takes" });
    const s = getComputedStyle(search);
    await expect(s.borderTopWidth).toBe("1px");
    await expect(s.borderTopStyle).toBe("solid");
    await expect(s.fontSize).toBe("12px");
  },
};

export const ShortMixer: Story = {
  render: () => (
    <div style={{ width: "600px", height: "130px", display: "flex", flexDirection: "column" }}>
      <MixerStrip running onOpenMixer={fn()} strips={["Master", "Music", "SFX", "Ambience"].map((name) => busStrip({ name, authored: 1, runtime: 1, duck: 1, peak: 0.5 }))} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // In a short panel every strip's name and level still show whole: the fader gives way, not the labels.
    const strips = c.getByRole("list", { name: "Buses" });
    const bottom = box(strips).bottom;
    for (const name of ["Master", "Music", "SFX", "Ambience"]) {
      const label = c.getByText(name, { selector: ".tk-strip-name" });
      await expect(box(label).bottom).toBeLessThanOrEqual(bottom);
      await expect(box(label.nextElementSibling!).bottom).toBeLessThanOrEqual(bottom);
    }
  },
};

export const Mixer: Story = {
  render: () => (
    <div style={{ width: "600px", height: "220px" }}>
      <MixerStrip
        running
        onOpenMixer={fn()}
        strips={[
          busStrip({ name: "Master", authored: 1, runtime: 1, duck: 1, peak: 0.7 }),
          busStrip({ name: "Vehicles", authored: 0.7, runtime: 1, duck: 1, peak: 0.5 }),
          busStrip({ name: "Music", authored: 0.5, runtime: 0.5, duck: 0.8, peak: 0.2 }),
          busStrip({ name: "Dialogue", authored: 1, runtime: 1, duck: 1, peak: 0 }),
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/live −/)).toBeVisible();
  },
};
