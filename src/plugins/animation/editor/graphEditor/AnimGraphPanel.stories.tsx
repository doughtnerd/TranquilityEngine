// Stories (ADR 0219) for the Animation Graph panel (ADR 0373; T51) in the shell: a graph opened from its file, its pose
// nodes on the canvas with the compiler's problems on them, the generated card of a selected node, the state machine's
// canvas (double-click) with transitions drawn with their priority numbers, a state's transition list, and every edit
// checked in the file the graph's asset document writes.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { ANIM_GRAPH_PANEL } from "./panelId";

const GRAPH = "animation/loco.animgraph.json";

/** Idle and Move states (Move a 1D blend space of walk and run), a transition each way, and a speed parameter. */
const loco = {
  format: "myco.animgraph-source@1",
  name: "Locomotion",
  output: "loco",
  parameters: [{ name: "speed", type: "float" }, { name: "grounded", type: "bool", default: true }],
  nodes: [
    { id: "idle", family: "sources", kind: "clipPlayer", position: [0, 0], params: { clip: "asset:animation/idle.anim.json" } },
    { id: "walk", family: "sources", kind: "clipPlayer", position: [0, 160], params: { clip: "asset:animation/walk.anim.json" } },
    { id: "run", family: "sources", kind: "clipPlayer", position: [0, 320], params: { clip: "asset:animation/run.anim.json" } },
    { id: "move", family: "sources", kind: "blendSpace1D", position: [260, 200], inputs: ["walk", "run"], params: { x: "speed", coords: [1.5, 4] } },
    {
      id: "loco", family: "logic", kind: "stateMachine", position: [520, 100], machine: {
        states: [
          { name: "Idle", root: "idle", position: [220, 40], transitions: [{ id: "go", to: "Move", if: { param: "speed", op: ">", value: 0.1 } }] },
          { name: "Move", root: "move", position: [460, 40], transitions: [{ to: "Idle", if: { param: "speed", op: "<=", value: 0.1 }, shape: "smoothstep" }] },
        ],
      },
    },
  ],
};

interface Saved { nodes: { id: string; inputs?: string[]; params?: Record<string, unknown>; machine?: { states: { name: string; transitions?: { to: string }[] }[] } }[]; parameters?: { name: string }[] }
const saved = () => fileJson<Saved>(GRAPH);

const meta = {
  title: "Animation/Graph Editor/Panel",
  beforeEach: withEditor,
  parameters: { editor: { files: { [GRAPH]: loco, "animation/idle.anim.json": { format: "myco.anim-source@1", duration: 1 } } } satisfies EditorStoryParameters },
  render: () => <PanelStory id={ANIM_GRAPH_PANEL} height={640} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function openGraph(canvasElement: HTMLElement) {
  expect(editor.assets.open(GRAPH)).toBe(true);
  await waitFor(() => expect(canvasElement.querySelectorAll(".ag-node")).toHaveLength(5), { timeout: 30000 });
  return {
    node: (id: string) => canvasElement.querySelector<HTMLElement>(`.ag-node[data-node="${id}"]`)!,
    c: within(canvasElement),
  };
}

export const NoGraphOpen: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(await c.findByText(/Double-click an animation graph/)).toBeVisible();
  },
};

/** The pose canvas: the nodes, the output badge, a node's generated card with typed fields. */
export const PoseNodes: Story = {
  play: async ({ canvasElement, step }) => {
    const { node, c } = await openGraph(canvasElement);
    await step("the output has its badge", async () => {
      expect(node("loco").querySelector(".ag-badge")?.textContent).toBe("out");
    });
    await step("clicking a node shows its card generated from the catalogue", async () => {
      await userEvent.click(node("move").querySelector(".ag-node-head")!);
      const card = await c.findByRole("group", { name: "Node move" });
      expect(within(card).getByLabelText("move x")).toBeTruthy();
      expect(within(card).getByLabelText("move glideMs")).toBeTruthy();
      expect(c.getByRole("group", { name: "Blend space Blend Space 1D" })).toBeTruthy();
    });
    await step("a typed field writes the file", async () => {
      fireEvent.change(c.getByLabelText("move glideMs"), { target: { value: "120" } });
      await waitFor(async () => expect((await saved()).nodes.find((n) => n.id === "move")!.params!.glideMs).toBe(120));
    });
    await step("Delete removes the selected node and its wires", async () => {
      await userEvent.click(node("run").querySelector(".ag-node-head")!);
      await userEvent.keyboard("{Delete}");
      await waitFor(async () => expect((await saved()).nodes.find((n) => n.id === "move")!.inputs).toEqual(["walk"]));
    });
  },
};

/** The state machine's canvas: states, entry, any state, transitions with their priority numbers; a state's list. */
export const StateMachine: Story = {
  play: async ({ canvasElement, step }) => {
    const { node, c } = await openGraph(canvasElement);
    await step("double-clicking the machine opens its canvas", async () => {
      await userEvent.dblClick(node("loco").querySelector(".ag-node-head")!);
      await waitFor(() => expect(canvasElement.querySelector('.ag-state[data-state="Idle"]')).not.toBeNull());
      expect(c.getByRole("button", { name: "Transition 1" })).toBeTruthy();
      expect(canvasElement.querySelector(".ag-state.entry")?.getAttribute("data-state")).toBe("Idle");
    });
    await step("selecting a state lists its transitions; adding one writes the file", async () => {
      await userEvent.click(canvasElement.querySelector<HTMLElement>('.ag-state[data-state="Idle"]')!);
      const list = await c.findByRole("group", { name: "Transitions from Idle" });
      await userEvent.selectOptions(within(list).getByLabelText("Add a transition from Idle"), "Idle");
      await waitFor(async () => expect((await saved()).nodes.find((n) => n.id === "loco")!.machine!.states[0]!.transitions!.map((t) => t.to)).toEqual(["Move", "Idle"]));
    });
    await step("raising a transition changes its priority in the file", async () => {
      await userEvent.click(c.getByRole("button", { name: "Raise Idle → Idle" }));
      await waitFor(async () => expect((await saved()).nodes.find((n) => n.id === "loco")!.machine!.states[0]!.transitions!.map((t) => t.to)).toEqual(["Idle", "Move"]));
    });
    await step("the breadcrumb goes back to the graph", async () => {
      await userEvent.click(c.getByRole("button", { name: "Locomotion" }));
      await waitFor(() => expect(canvasElement.querySelectorAll(".ag-node")).toHaveLength(5));
    });
  },
};

/** The parameters tab: the SDK's parameter cards with the graph's own fields. */
export const Parameters: Story = {
  play: async ({ canvasElement }) => {
    const { c } = await openGraph(canvasElement);
    expect(await c.findByRole("group", { name: "Parameter speed" })).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "+ Parameter" }));
    await waitFor(async () => expect((await saved()).parameters!.map((p) => p.name)).toEqual(["speed", "grounded", "Parameter"]));
  },
};
