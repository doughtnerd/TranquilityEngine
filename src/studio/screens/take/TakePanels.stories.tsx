// Stories (ADR 0219, 0334, 0335) for the Take screen's views over the fixture take (built through the take record
// writers): the timeline replayed by a real `TakeReplay` on a silent target (play, scrub, select an instance, add and
// drag notes with the notes edits), the Takes tree and its empty state, the Inspector's instance and note details and
// the Mixer strip.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useMemo, useState } from "preact/hooks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { TakeNotes } from "../../../engine/audio/take/types";
import { performanceClock, TakeReplay, type ReplayTarget } from "../../runtime/takeReplay";
import { addMarker, moveNote, type NotesEdit } from "./notesEdits";
import { InstanceDetails, MixerStrip, NoteDetails } from "./TakeInspector";
import { busStrip, instanceParametersAt, parameterRows } from "./takeInspectorModel";
import { FIXTURE_NOTES, SURFACE_LABELS, fixtureTake } from "./takeFixture";
import { TakeList } from "./TakeList";
import type { TakeSelection } from "./takeScreen";
import { takeTimeline } from "./takeTimeline";
import { TakeTimelineView } from "./TakeTimelineView";
import "./take.css";

/** A target that plays nothing (the stories have no audio runtime). */
const silent: ReplayTarget = {
  play: () => null, setGlobal() {}, busVolume() {}, snapshot() {}, clearSnapshot() {}, masterVolume: () => 1, listener() {}, seed: () => true,
};

function TimelineDemo(props: { start?: number }) {
  const take = useMemo(() => fixtureTake(), []);
  const replay = useMemo(() => new TakeReplay(take, silent, performanceClock), [take]);
  const timeline = useMemo(() => takeTimeline(take, (name, path) => (name === "Surface" && path === null ? SURFACE_LABELS : null)), [take]);
  const [notes, setNotes] = useState<TakeNotes>(FIXTURE_NOTES);
  const [selected, setSelected] = useState<TakeSelection>(null);
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
        time={replay.time.value}
        playing={replay.playing.value}
        selected={selected}
        notes={notes}
        notesWritable
        onSeek={(t) => replay.seek(t)}
        onSelectInstance={(key) => setSelected({ kind: "instance", key })}
        onOpenInstance={fn()}
        onSelectNote={(id) => setSelected({ kind: "note", id })}
        onMoveNote={(id, at) => apply(moveNote(notes, id, at, take.duration))}
        onAddMarker={(at) => apply(addMarker(notes, at, take.duration), true)}
      />
      <output aria-label="Selected">{selected ? (selected.kind === "instance" ? selected.key : selected.id) : ""}</output>
      <output aria-label="Markers">{notes.markers.length}</output>
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

const FILES = ["takes/HoverBike/Canyon/canyon_run_01.mycotake", "takes/HoverBike/Canyon/canyon_run_03.mycotake", "takes/HoverBike/Canyon/canyon_run_03.mycotake.notes.json", "takes/Boss/boss_arena_01.mycotake", "captures/capture_01.mycap"];
const listArgs = { folders: ["takes", "takes/HoverBike", "takes/HoverBike/Canyon", "takes/Boss"], writable: true, onOpen: fn(), onImport: fn(), onRename: fn(), onMove: fn(), onDelete: fn() };

export const Takes: Story = {
  render: () => <div style={{ width: "280px" }}><TakeList files={FILES} openPath="takes/HoverBike/Canyon/canyon_run_03.mycotake" {...listArgs} /></div>,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("canyon_run_01.mycotake")).toBeVisible();
    await expect(c.queryByText("capture_01.mycap")).toBeNull();
  },
};

export const NoTakes: Story = {
  render: () => <div style={{ width: "280px" }}><TakeList files={["audio.json"]} openPath={null} {...listArgs} /></div>,
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
        <InstanceDetails instance={engine} emitterName="Bike" emitterPose={{ position: { x: 175.6, y: 1, z: 0 } }} rows={rows} live onGoToStart={fn()} onOpenSource={fn()} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("4321")).toBeVisible();
    await expect(c.getByRole("button", { name: "Open playlist ›" })).toBeVisible();
  },
};

export const Note: Story = {
  render: () => (
    <div style={{ width: "300px" }}>
      <NoteDetails note={{ kind: "region", ...FIXTURE_NOTES.regions[0]! }} writable onText={fn()} onColour={fn()} onTime={fn()} onSpan={fn()} onDelete={fn()} onGoTo={fn()} />
    </div>
  ),
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
