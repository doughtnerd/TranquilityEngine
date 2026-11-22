// Stories (ADR 0219, 0335) for the Spatial screen's Scene view on the fixture scene ("Canyon run"): the plan with its
// boxes, route, listeners and emitters, the rays and render colours from a voices readout, a selected box with its
// handles and floating toolbar, a moving emitter travelling its route while playing, path editing, the side view, and the tool palette placing an object. The host is local
// state standing in for the screen (`sceneHost.ts`), so edits apply to the story's scene.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { BaseSceneImport } from "../../../engine/audio/spatial/baseScene";
import { advanceRoute, closeDistance, travelAt, travelPose, travelSpeed } from "../../../engine/audio/spatial/routeTravel";
import type { AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import type { TestSceneMotionRow } from "../../../plugins/audio/runtime/testScene/player";
import { NO_AUDITION, isSilenced, toggleMute, toggleSolo } from "./audition";
import { INITIAL_SLAB } from "./elevation";
import { startFrameLoop } from "./liveMotion";
import { boundsOf } from "./geometry";
import type { SceneHost } from "./sceneHost";
import { SceneView } from "./SceneView";
import { deleteObject, framePoints, setActiveListener } from "./sceneEdits";
import { FIXTURE_BASE_PATH, fixtureBase, fixtureScene, fixtureVoices } from "./spatialFixture";
import { place, type ToolState } from "./tools";
import { DEFAULT_VIEW, fitView } from "./viewTransform";
import "../playlists/playlists.css";
import "./spatial.css";

interface Args {
  readonly scene: AudioTestScene;
  readonly selected?: string | null;
  readonly tools?: ToolState;
  readonly playing?: boolean;
  readonly sideView?: boolean;
  readonly readOnly?: boolean;
  /** The base game scene underneath (`fixtureBase()`), or null. */
  readonly base?: BaseSceneImport | null;
  /** Playing with the moving emitters travelling (a Stop / Play button beside the view), as the test scene player moves them. */
  readonly moving?: boolean;
}

/**
 * Stands in for the test scene player's `motion()` while the story plays: each moving emitter travels its route on the
 * browser's animation frames (`routeTravel.ts`, as the player's route movers do); empty while stopped.
 */
function useStoryMotion(scene: AudioTestScene, on: boolean): TestSceneMotionRow[] {
  const [rows, setRows] = useState<TestSceneMotionRow[]>([]);
  useEffect(() => {
    if (!on) {
      setRows([]);
      return;
    }
    const movers = scene.emitters.flatMap((e) => (e.kind === "moving" ? [{ e, t: travelAt(e.start) }] : []));
    const pose = { position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
    return startFrameLoop((dt) => {
      setRows(movers.map(({ e, t }) => {
        advanceRoute(e.route, e.speed, e.loop, t, dt, closeDistance(150, dt));
        travelPose(e.route, e.height, e.loop, t, pose);
        return { id: e.id, position: { ...pose.position }, direction: { ...pose.direction }, speed: travelSpeed(e.route, e.speed, e.loop, t) };
      }));
    });
  }, [scene, on]);
  return rows;
}

function StoryScene(props: Args) {
  const [scene, setScene] = useState(props.scene);
  const [selected, select] = useState<string | null>(props.selected ?? null);
  const [tools, setTools] = useState<ToolState>(props.tools ?? { tool: "select", pathEdit: null });
  const [view, setView] = useState(DEFAULT_VIEW);
  const [slab, setSlab] = useState(INITIAL_SLAB);
  const [side, setSide] = useState(!!props.sideView);
  const [hover, setHover] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [audition, setAudition] = useState(NO_AUDITION);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [running, setRunning] = useState(!!props.moving);
  const motion = useStoryMotion(scene, running);
  const playing = !!props.playing || running;
  const fit = () => {
    const b = boundsOf(framePoints(scene), 20);
    setView(b ? fitView(b, size) : DEFAULT_VIEW);
  };
  const host: SceneHost = {
    scene,
    base: props.base ?? null,
    path: "audio/scenes/canyon_run.audioscene.json",
    readOnly: !!props.readOnly,
    selected,
    select,
    tools,
    setTools,
    view,
    setView,
    setSize: (s) => {
      setSize(s);
      const b = boundsOf(framePoints(scene), 20);
      if (b) setView(fitView(b, s));
    },
    fit,
    slab,
    setSlab,
    sideView: side,
    setSideView: setSide,
    hover,
    setHover,
    renaming,
    setRenaming,
    playing,
    voices: playing ? fixtureVoices() : [],
    motion,
    silenced: (id) => isSilenced(audition, id),
    solo: audition.solo,
    edit: (_label, edit) => {
      const r = edit(scene);
      if ("refused" in r) return false;
      setScene(r.next);
      return true;
    },
    endDrag: () => {},
    place: (tool, at, low) => {
      const r = place(scene, tool, at, { slabLow: low, material: "concrete", buses: ["Master", "Music"] });
      if ("refused" in r) return;
      setScene(r.next.scene);
      select(r.next.id);
      setTools({ tool: "select", pathEdit: tool === "moving" ? r.next.id : null });
    },
    remove: (id) => {
      const r = deleteObject(scene, id);
      if ("next" in r) setScene(r.next);
      select(null);
    },
    soloToggle: (id) => setAudition(toggleSolo(audition, id)),
    muteToggle: (id) => setAudition(toggleMute(audition, id)),
    editAttenuation: () => {},
    playAll: () => setAudition({ ...audition, solo: null }),
    listenHere: (id) => {
      const r = setActiveListener(scene, id);
      if ("next" in r) setScene(r.next);
    },
  };
  if (!props.moving) return <SceneView host={host} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      <button type="button" style={{ alignSelf: "flex-start" }} onClick={() => setRunning(!running)}>{running ? "Stop" : "Play"}</button>
      <SceneView host={host} />
    </div>
  );
}

const meta = {
  title: "Studio/Spatial/Scene view",
  component: StoryScene,
  args: { scene: fixtureScene() },
  decorators: [(Story) => <div style={{ width: "980px", height: "640px", display: "flex" }}>{Story()}</div>],
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Plan: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("toolbar", { name: "Tools" })).toBeVisible();
    await expect(c.getByRole("img", { name: /Plan of the scene, 14 objects/ })).toBeVisible();
    await expect(c.getByText("Waterfall")).toBeInTheDocument();
    await expect(c.getByText("HRTF")).toBeVisible(); // legend
  },
};

export const Playing: Story = {
  args: { playing: true },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll(".sp-ray").length).toBe(4));
    await expect(canvasElement.querySelectorAll(".sp-ray.occluded").length).toBe(1);
    await expect(canvasElement.querySelector(".sp-emitter.hrtf")).not.toBeNull();
  },
};

/** The drone flies its route while playing: drawn where it is now with its heading, its start marked; Stop puts it back. */
export const MovingEmitter: Story = {
  args: { moving: true, selected: "emitter4" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const drone = () => canvasElement.querySelector<SVGGElement>('.sp-emitter[data-id="emitter4"]')!;
    const at = () => Number(drone().querySelector("rect")!.getAttribute("x"));
    await waitFor(() => expect(drone().classList.contains("live")).toBe(true));
    const first = at();
    await waitFor(() => expect(Math.abs(at() - first)).toBeGreaterThan(4)); // it travels
    await expect(drone().querySelector(".sp-heading")).not.toBeNull();
    await expect(drone().querySelector(".sp-start")).not.toBeNull();
    await expect(drone().querySelector("title")).toHaveTextContent("Drone · 12.0 m/s");
    await userEvent.click(c.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(drone().classList.contains("live")).toBe(false));
    await expect(drone().querySelector(".sp-heading")).toBeNull();
    await expect(drone().querySelector(".sp-start")).toBeNull();
  },
};

export const SelectedBox: Story = {
  args: { selected: "obstacle2" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("toolbar", { name: "Crate stack actions" })).toBeVisible();
    await waitFor(() => expect(canvasElement.querySelectorAll(".sp-handle").length).toBe(5)); // 4 corners and the knob
  },
};

export const LockedEmitter: Story = {
  args: { selected: "emitter3" },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("toolbar", { name: "Campfire actions" });
    await expect(within(bar).getByRole("button", { name: "Edit attenuation…" })).toBeVisible();
  },
};

export const PathEditing: Story = {
  args: { selected: "emitter4", tools: { tool: "select", pathEdit: "emitter4" } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent(/Editing the path/);
    await waitFor(() => expect(canvasElement.querySelectorAll(".sp-waypoint").length).toBe(5));
    await expect(canvasElement.querySelectorAll(".sp-midpoint").length).toBe(4);
    await userEvent.click(c.getByRole("button", { name: "Done" }));
    await expect(c.queryByRole("status")).toBeNull();
  },
};

export const SideView: Story = {
  args: { sideView: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: /Side view/ })).toBeVisible();
  },
};

export const AddTwoDSound: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "2D sound" }));
    await expect(c.getByRole("toolbar", { name: "2D sound 2 actions" })).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Obstacle" }));
    await expect(c.getByRole("button", { name: "Obstacle" })).toHaveAttribute("aria-pressed", "true");
  },
};

export const OverBaseScene: Story = {
  args: { scene: { ...fixtureScene(), base: FIXTURE_BASE_PATH }, base: fixtureBase() },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Over canyon: 5 objects, read-only")).toBeVisible();
    await waitFor(() => expect(canvasElement.querySelectorAll(".sp-base [data-base]").length).toBe(5));
    await expect(canvasElement.querySelectorAll(".sp-base-collider").length).toBe(2);
    await expect(canvasElement.querySelector(".sp-base-reverb circle")).not.toBeNull();
    await expect(c.getByText("North wall · stone")).toBeInTheDocument();
    await expect(c.getByText("Well")).toBeInTheDocument();
    // Read-only: the pointer passes through the base layer to the plan (it can't be selected or dragged).
    await expect(getComputedStyle(canvasElement.querySelector(".sp-base")!).pointerEvents).toBe("none");
    // The test scene's own objects still draw over it.
    await expect(c.getByRole("img", { name: /Plan of the scene, 14 objects/ })).toBeVisible();
  },
};

export const MissingBaseScene: Story = {
  args: { scene: { ...fixtureScene(), base: "scenes/gone.scene.json" }, base: fixtureBase(null) },
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert");
    await expect(alert).toHaveTextContent("Base scene scenes/gone.scene.json is missing; playing without it");
    await expect(canvasElement.querySelectorAll(".sp-base [data-base]").length).toBe(0);
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, selected: "listener1" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Emitter" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Delete" })).toBeDisabled();
  },
};
