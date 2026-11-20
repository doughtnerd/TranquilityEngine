// Stories (ADR 0219, 0235) for the Particle Graph panel: the selection and shortcuts it shares with the Shader Graph
// (ADR 0228, `useGraphSelection`) on its own items (systems with their blocks, nodes), and its extras (a selected block
// deleted before the selection), and the wiring gesture and find the graph layer runs for both graphs (ADR 0259). Each
// edit is checked in the file the effect's asset document writes. The live preview is turned off with the panel's own
// Preview button where a story doesn't need it.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { ParticleGraph } from "../../../../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph } from "../../../../engine/scene/particleGraphFormat";
import { editor } from "../../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { PARTICLE_GRAPH_PANEL } from "../particleAssets";

const EFFECT = "effects/sparks.particles.json";

/** The Simple Loop template (one system) and two value nodes beside it. */
function sparks(): string {
  const g = defaultParticleGraph();
  g.nodes.push({ id: "n1", type: "constant.number", position: [-360, 0], settings: { value: 2 } }, { id: "n2", type: "particle.age", position: [-360, 160] });
  return formatParticleGraph(g);
}

const saved = () => fileJson<ParticleGraph>(EFFECT);

function graph(canvasElement: HTMLElement) {
  const owner = (id: string) => canvasElement.querySelector<HTMLElement>(`[data-owner="${id}"]`);
  const user = userEvent.setup();
  return {
    owner,
    nodes: () => [...canvasElement.querySelectorAll<HTMLElement>(".pg-node")].map((n) => n.dataset.owner!),
    systems: () => [...canvasElement.querySelectorAll<HTMLElement>(".pg-system")].map((n) => n.dataset.owner!),
    selected: () => [...canvasElement.querySelectorAll<HTMLElement>(".pg-node.selected, .pg-system.selected")].map((n) => n.dataset.owner!).sort(),
    /** Click an item's title bar (Shift adds it to the selection). */
    pick: async (id: string, shift = false) => {
      const head = owner(id)!.querySelector<HTMLElement>(".pg-node-head, .pg-system-head")!;
      if (shift) await user.keyboard("{Shift>}");
      await user.click(head);
      if (shift) await user.keyboard("{/Shift}");
    },
    keys: (text: string) => user.keyboard(text),
    pane: () => canvasElement.querySelector<HTMLElement>(".pg-pane")!,
  };
}

const meta = {
  title: "Particles/Particle Graph/Panel",
  beforeEach: withEditor,
  parameters: { editor: { files: { [EFFECT]: sparks() } } satisfies EditorStoryParameters },
  render: () => <PanelStory id={PARTICLE_GRAPH_PANEL} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Open the effect in the panel through its asset kind, turn the preview off, and wait for its items. */
async function openEffect(canvasElement: HTMLElement) {
  expect(editor.assets.open(EFFECT)).toBe(true);
  const g = graph(canvasElement);
  await waitFor(() => expect(g.nodes()).toEqual(["n1", "n2"]));
  const preview = within(canvasElement).getByRole("button", { name: "Preview" });
  if (preview.getAttribute("aria-pressed") === "true") await userEvent.click(preview);
  expect(preview).toHaveAttribute("aria-pressed", "false");
  return g;
}

export const NoEffectOpen: Story = {
  play: async ({ canvasElement }) => {
    expect(await within(canvasElement).findByText(/Double-click a particle effect/, {}, { timeout: 5000 })).toBeVisible();
    expect(editor.assets.open(EFFECT)).toBe(true);
    await waitFor(() => expect(graph(canvasElement).nodes()).toEqual(["n1", "n2"]));
    expect(within(canvasElement).queryByText(/Double-click a particle effect/)).toBeNull();
  },
};

export const SelectDeleteEscape: Story = {
  play: async ({ canvasElement, step }) => {
    const g = await openEffect(canvasElement);
    await step("a click selects a node, Shift-click adds a system", async () => {
      await g.pick("n1");
      expect(g.selected()).toEqual(["n1"]);
      await g.pick(g.systems()[0], true);
      expect(g.selected()).toEqual(["n1", g.systems()[0]].sort());
    });
    await step("Escape clears the selection", async () => {
      await g.keys("{Escape}");
      expect(g.selected()).toEqual([]);
    });
    await step("Delete removes the selected node, in the file", async () => {
      await g.pick("n2");
      await g.keys("{Delete}");
      await waitFor(() => expect(g.nodes()).toEqual(["n1"]));
      await waitFor(async () => expect((await saved()).nodes.map((n) => n.id)).toEqual(["n1"]));
    });
    await step("with a block selected, Delete removes the block, not the system", async () => {
      const system = g.systems()[0];
      const block = g.owner(system)!.querySelector<HTMLElement>(".pg-block[data-block]")!;
      const id = block.dataset.block!;
      const before = (await saved()).systems[0];
      const count = (s: typeof before) => s.spawn.blocks.length + s.initialize.blocks.length + s.update.blocks.length + s.output.blocks.length;
      await userEvent.click(block.querySelector(".pg-block-head, span") ?? block);
      await g.keys("{Delete}");
      await waitFor(() => expect(canvasElement.querySelector(`.pg-block[data-block="${id}"]`)).toBeNull());
      expect(g.systems()).toEqual([system]);
      await waitFor(async () => expect(count((await saved()).systems[0])).toBe(count(before) - 1));
    });
  },
};

export const CopyPasteDuplicate: Story = {
  play: async ({ canvasElement, step }) => {
    const g = await openEffect(canvasElement);
    await step("Ctrl+C, Ctrl+V pastes a node with a new id, selected and saved", async () => {
      await g.pick("n1");
      await g.keys("{Control>}c{/Control}{Control>}v{/Control}");
      await waitFor(() => expect(g.nodes()).toHaveLength(3));
      const pasted = g.nodes().find((id) => id !== "n1" && id !== "n2")!;
      expect(g.selected()).toEqual([pasted]);
      await waitFor(async () => expect((await saved()).nodes.find((n) => n.id === pasted)).toMatchObject({ type: "constant.number", settings: { value: 2 } }));
    });
    await step("Ctrl+D duplicates a system with its blocks, 40 units down and right", async () => {
      const system = g.systems()[0];
      await g.pick(system);
      await g.keys("{Control>}d{/Control}");
      await waitFor(() => expect(g.systems()).toHaveLength(2));
      const copy = g.systems().find((id) => id !== system)!;
      expect(g.selected()).toEqual([copy]);
      await waitFor(async () => {
        const [a, b] = (await saved()).systems;
        expect(b.position).toEqual([a.position[0] + 40, a.position[1] + 40]);
        expect(b.update.blocks.map((x) => x.type)).toEqual(a.update.blocks.map((x) => x.type));
        expect(b.update.blocks.map((x) => x.id)).not.toEqual(a.update.blocks.map((x) => x.id));
      });
    });
    await step("Ctrl+X cuts: the node goes, and Ctrl+V brings a copy back", async () => {
      await g.pick("n2");
      await g.keys("{Control>}x{/Control}");
      await waitFor(() => expect(g.nodes()).not.toContain("n2"));
      await g.keys("{Control>}v{/Control}");
      await waitFor(async () => expect((await saved()).nodes.filter((n) => n.type === "particle.age")).toHaveLength(1));
    });
  },
};

export const GroupAndBoxSelect: Story = {
  play: async ({ canvasElement, step }) => {
    const g = await openEffect(canvasElement);
    await step("a drag over empty canvas around the two nodes selects exactly them", async () => {
      const a = g.owner("n1")!.getBoundingClientRect();
      const b = g.owner("n2")!.getBoundingClientRect();
      const pane = g.pane();
      fireEvent.pointerDown(pane, { clientX: a.left - 20, clientY: a.top - 20, button: 0, buttons: 1, pointerId: 1 });
      fireEvent.pointerMove(pane, { clientX: b.right + 10, clientY: b.bottom + 10, buttons: 1, pointerId: 1 });
      fireEvent.pointerUp(pane, { clientX: b.right + 10, clientY: b.bottom + 10, button: 0, pointerId: 1 });
      await waitFor(() => expect(g.selected()).toEqual(["n1", "n2"]));
    });
    await step("Ctrl+G groups them, saved as a group named Group", async () => {
      await g.keys("{Control>}g{/Control}");
      await waitFor(async () => expect((await saved()).groups).toEqual([expect.objectContaining({ title: "Group", members: ["n1", "n2"] })]));
      expect(within(canvasElement).getByLabelText("Group Group")).toBeVisible();
    });
  },
};

/** Where an element's middle is on screen. */
const middle = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
};

/** Press a port and move the wire's loose end over `to` (xyflow follows the mouse on the document); `release` lets go there. */
function dragWire(from: Element, to: Element | { clientX: number; clientY: number }) {
  const a = middle(from), b = to instanceof Element ? middle(to) : to;
  fireEvent.mouseDown(from, { ...a, button: 0, buttons: 1 });
  for (let i = 1; i <= 6; i++) fireEvent.mouseMove(document, { clientX: a.clientX + ((b.clientX - a.clientX) * i) / 6, clientY: a.clientY + ((b.clientY - a.clientY) * i) / 6, buttons: 1 });
  return { release: () => fireEvent.mouseUp(document, { ...b, button: 0 }) };
}

export const WiringGesture: Story = {
  play: async ({ canvasElement, step }) => {
    const g = await openEffect(canvasElement);
    const c = within(canvasElement);
    // Room to see the ports: fill the window, then frame everything.
    await userEvent.click(c.getByRole("button", { name: "Maximize" }));
    await userEvent.click(c.getByRole("button", { name: "Frame" }));
    const system = g.systems()[0];
    const out = () => g.owner("n1")!.querySelector<HTMLElement>('.pg-port[data-side="output"]')!;
    const start = () => g.owner(system)!.querySelector<HTMLElement>('.pg-port[data-port="start"]')!;
    const numberInput = () => [...g.owner(system)!.querySelectorAll<HTMLElement>('.pg-block .pg-port[data-side="input"]')].find((p) => p.title.endsWith("(number)"))!;
    await step("a wire held over a port that refuses it says why, and letting go there adds nothing", async () => {
      const drag = dragWire(out(), start());
      expect(await c.findByRole("tooltip")).toHaveTextContent("Only events (event nodes and Trigger Event blocks) can be wired to Start and Stop.");
      drag.release();
      await waitFor(() => expect(c.queryByRole("tooltip")).toBeNull());
      expect((await saved()).edges).toEqual([]);
    });
    await step("a wire let go over a port that takes it connects them, in the file", async () => {
      const input = numberInput();
      const to = `${system}.${input.dataset.port}`;
      dragWire(out(), input).release();
      await waitFor(async () => expect((await saved()).edges).toEqual([{ from: "n1.out", to }]));
    });
    await step("pressing the wired input picks its wire up; let go in empty space, the wire is removed", async () => {
      const input = numberInput();
      const r = g.pane().getBoundingClientRect();
      dragWire(input, { clientX: r.left + 30, clientY: r.bottom - 30 }).release();
      await waitFor(async () => expect((await saved()).edges).toEqual([]));
      expect(c.queryByRole("dialog", { name: "Add node" })).toBeNull(); // a picked-up wire opens no search
    });
    await step("a new wire let go in empty space opens the node search", async () => {
      const r = g.pane().getBoundingClientRect();
      dragWire(out(), { clientX: r.left + 30, clientY: r.bottom - 30 }).release();
      expect(await c.findByRole("dialog", { name: "Add node" })).toBeVisible();
      await g.keys("{Escape}");
    });
  },
};

export const FindInGraph: Story = {
  play: async ({ canvasElement, step }) => {
    const g = await openEffect(canvasElement);
    const c = within(canvasElement);
    await step("Ctrl+F opens find; a node's title finds it, and Enter selects it", async () => {
      await g.pick("n1");
      await g.keys("{Control>}f{/Control}");
      const box = c.getByRole("textbox", { name: "Find in graph" });
      await waitFor(() => expect(box).toHaveFocus());
      await userEvent.type(box, "age");
      expect(c.getByRole("search", { name: "Find in graph" })).toHaveTextContent("Age");
      await userEvent.keyboard("{Enter}");
      expect(g.selected()).toEqual(["n2"]);
    });
    await step("a system's name and its blocks find the system", async () => {
      const box = c.getByRole("textbox", { name: "Find in graph" });
      await userEvent.clear(box);
      await userEvent.type(box, "simple loop");
      await userEvent.keyboard("{Enter}");
      expect(g.selected()).toEqual([g.systems()[0]]);
    });
    await step("Escape closes find and gives the graph the keyboard back", async () => {
      await userEvent.keyboard("{Escape}");
      expect(c.queryByRole("search", { name: "Find in graph" })).toBeNull();
      expect(canvasElement.querySelector(".particle-graph")).toHaveFocus();
    });
  },
};
