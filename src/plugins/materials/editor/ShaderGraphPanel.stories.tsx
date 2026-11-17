// Stories (ADR 0219, 0235) for the Shader Graph panel: the selection and shortcuts every graph panel shares (ADR 0228,
// `useGraphSelection`) as a user drives them, each edit checked in the file the graph's asset document writes. These
// are the coverage of copy, paste, duplicate and group in the Shader Graph: the e2e spec that does them in the whole
// editor needs WebGPU for the panel's preview and is skipped where there is none. The preview here draws nothing (no
// GPU in the headless story browser) and nothing below reads it.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../editor/stories/editorStory";
import { SHADER_GRAPH_PANEL } from "./shaderGraphAssets";

const GRAPH = "shaders/water.shadergraph.json";

/** A small graph: two colour properties lerped into the output, the properties grouped, and a note. */
const water = {
  format: "myco.shadergraph@1",
  properties: [
    { name: "Shallow", type: "color", value: "#5fd3e6" },
    { name: "Deep", type: "color", value: "#0b3d6e" },
  ],
  nodes: [
    { id: "output", type: "output", position: [400, 0] },
    { id: "shallow", type: "property", position: [-200, -100], settings: { property: "Shallow" } },
    { id: "deep", type: "property", position: [-200, 60], settings: { property: "Deep" } },
    { id: "lerp1", type: "lerp", position: [100, 0] },
  ],
  edges: [
    { from: "deep.out", to: "lerp1.a" },
    { from: "shallow.out", to: "lerp1.b" },
    { from: "lerp1.out", to: "output.baseColor" },
  ],
  groups: [{ id: "group1", title: "Colour", nodes: ["shallow", "deep"] }],
  notes: [{ id: "note1", position: [-200, 260], size: [200, 80], text: "Shallow to deep." }],
};

interface Graph {
  nodes: { id: string; position: [number, number] }[];
  edges: { from: string; to: string }[];
  groups?: { id: string; title: string; nodes: string[] }[];
  notes?: { id: string; text: string }[];
}

const saved = () => fileJson<Graph>(GRAPH);
const ids = (g: Graph) => g.nodes.map((n) => n.id);

/** The panel's parts, found as a user finds them. */
function panel(canvasElement: HTMLElement) {
  const root = () => canvasElement.querySelector<HTMLElement>(".shader-graph")!;
  const node = (id: string) => canvasElement.querySelector<HTMLElement>(`.sg-node[data-node="${id}"]`);
  const header = (id: string) => node(id)!.querySelector<HTMLElement>(".sg-node-header")!;
  return {
    root,
    node,
    nodeIds: () => [...canvasElement.querySelectorAll<HTMLElement>(".sg-node")].map((n) => n.dataset.node!),
    selected: () => [...canvasElement.querySelectorAll<HTMLElement>(".sg-node.selected")].map((n) => n.dataset.node!),
    /** Click a node's title, as a user picks it (Shift adds to the selection). */
    pick: async (id: string, shift = false) => {
      const h = header(id);
      if (!shift) return userEvent.click(h);
      const user = userEvent.setup(); // keeps Shift held from the key press to the click
      await user.keyboard("{Shift>}");
      await user.click(h);
      await user.keyboard("{/Shift}");
    },
    pane: () => canvasElement.querySelector<HTMLElement>(".sg-pane")!,
  };
}

const meta = {
  title: "Materials/Shader Graph/Panel",
  beforeEach: withEditor,
  parameters: { editor: { files: { [GRAPH]: water } } satisfies EditorStoryParameters },
  render: () => <PanelStory id={SHADER_GRAPH_PANEL} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Open the graph in the panel (its kind's `panel`) and wait for its nodes. */
async function openGraph(canvasElement: HTMLElement) {
  expect(editor.assets.open(GRAPH)).toBe(true);
  const p = panel(canvasElement);
  await waitFor(() => expect(p.nodeIds()).toEqual(["output", "shallow", "deep", "lerp1"]));
  return p;
}

export const NoGraphOpen: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(await c.findByText(/Double-click a shader graph/)).toBeVisible();
    // New Shader Graph makes a file in the kind's folder and opens it here.
    await userEvent.click(c.getByRole("button", { name: "New Shader Graph" }));
    await waitFor(() => expect(editor.assets.openIn(SHADER_GRAPH_PANEL)).toBe("shaders/New Shader Graph.shadergraph.json"));
    await waitFor(() => expect(canvasElement.querySelector('.sg-node[data-node="output"]')).not.toBeNull());
  },
};

export const SelectAndDelete: Story = {
  play: async ({ canvasElement, step }) => {
    const p = await openGraph(canvasElement);
    await step("a click selects one node; Shift-click adds another", async () => {
      await p.pick("lerp1");
      expect(p.selected()).toEqual(["lerp1"]);
      await p.pick("deep", true);
      expect(p.selected().sort()).toEqual(["deep", "lerp1"]);
    });
    await step("Delete removes the selected nodes and their wires, in the file", async () => {
      await userEvent.keyboard("{Delete}");
      await waitFor(() => expect(p.nodeIds()).toEqual(["output", "shallow"]));
      await waitFor(async () => expect((await saved()).edges).toEqual([]));
      expect(ids(await saved())).toEqual(["output", "shallow"]);
    });
    await step("Escape clears the selection", async () => {
      await p.pick("shallow");
      expect(p.selected()).toEqual(["shallow"]);
      await userEvent.keyboard("{Escape}");
      expect(p.selected()).toEqual([]);
    });
  },
};

export const CopyPasteDuplicate: Story = {
  play: async ({ canvasElement, step }) => {
    const p = await openGraph(canvasElement);
    await step("Ctrl+C then Ctrl+V pastes a copy with a new id, selected, and saves it", async () => {
      await p.pick("lerp1");
      await userEvent.keyboard("{Control>}c{/Control}");
      await userEvent.keyboard("{Control>}v{/Control}");
      await waitFor(() => expect(p.nodeIds()).toContain("lerp2"));
      expect(p.selected()).toEqual(["lerp2"]);
      await waitFor(async () => expect(ids(await saved())).toEqual(["output", "shallow", "deep", "lerp1", "lerp2"]));
    });
    await step("a copy of connected nodes keeps the wires between them", async () => {
      await p.pick("deep");
      await p.pick("lerp1", true);
      await userEvent.keyboard("{Control>}c{/Control}{Control>}v{/Control}");
      await waitFor(() => expect(p.selected().sort()).toEqual(["lerp3", "property1"])); // a new id from the node type
      await waitFor(async () => expect((await saved()).edges).toContainEqual({ from: "property1.out", to: "lerp3.a" }));
    });
    await step("Ctrl+D duplicates the selection 40 units down and right", async () => {
      await p.pick("output");
      await p.pick("shallow");
      await userEvent.keyboard("{Control>}d{/Control}");
      await waitFor(() => expect(p.selected()).toEqual(["property2"]));
      await waitFor(async () => {
        const g = await saved();
        const at = (id: string) => g.nodes.find((n) => n.id === id)!.position;
        expect(at("property2")).toEqual([at("shallow")[0] + 40, at("shallow")[1] + 40]);
      });
    });
    await step("the output node isn't copied: pasting it adds nothing", async () => {
      const before = p.nodeIds().length;
      await p.pick("output");
      await userEvent.keyboard("{Control>}d{/Control}");
      expect(p.nodeIds()).toHaveLength(before);
    });
  },
};

export const GroupNodes: Story = {
  play: async ({ canvasElement }) => {
    const p = await openGraph(canvasElement);
    await p.pick("lerp1");
    await p.pick("output", true);
    await userEvent.keyboard("{Control>}g{/Control}");
    await waitFor(async () =>
      expect((await saved()).groups).toEqual([
        { id: "group1", title: "Colour", nodes: ["shallow", "deep"] },
        { id: "group2", title: "Group", nodes: expect.arrayContaining(["lerp1", "output"]) },
      ]),
    );
    expect(within(canvasElement).getByLabelText("Group Group", { exact: true })).toBeVisible();
  },
};

export const BoxSelect: Story = {
  play: async ({ canvasElement }) => {
    const p = await openGraph(canvasElement);
    // A drag over empty canvas around the two property nodes selects exactly them.
    const a = p.node("shallow")!.getBoundingClientRect();
    const b = p.node("deep")!.getBoundingClientRect();
    const pane = p.pane();
    const from = { clientX: Math.min(a.left, b.left) - 20, clientY: a.top - 20 };
    const to = { clientX: Math.max(a.right, b.right) + 10, clientY: b.bottom + 10 };
    fireEvent.pointerDown(pane, { ...from, button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(pane, { ...to, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(pane, { ...to, button: 0, pointerId: 1 });
    await waitFor(() => expect(p.selected().sort()).toEqual(["deep", "shallow"]));
    // Delete takes the box's nodes.
    await userEvent.keyboard("{Delete}");
    await waitFor(async () => expect(ids(await saved())).toEqual(["output", "lerp1"]));
  },
};
