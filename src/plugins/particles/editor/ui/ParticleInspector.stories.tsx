// Stories (ADR 0219, 0235) for the Inspector's particle parts: an effect asset's summary, a sub-graph or block asset's
// ports (read as the current value, ADR 0233: the open Particle Graph's unwritten edits included), and, in the shell's
// own Inspector, a ParticleSystem's exposed properties as per-instance overrides: set, reverted, undone, and a colour
// pick as one undo step (the shared property value field reports its drag, ADR 0290).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { defaultParticleGraph, formatParticleGraph } from "../../../../engine/scene/particleGraphFormat";
import { editor } from "../../../../editor/sdk";
import { PanelStory, storyProject, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { PARTICLE_GRAPH_PANEL, particleDocument } from "../particleAssets";
import { ASSET_INPUT, addPseudoNode } from "../particleGraph/assetDocs";
import { ParticleAssetInspector, ParticleEffectInspector } from "./ParticleInspector";

const EFFECT = "effects/sparks.particles.json";
const SUBGRAPH = "effects/wobble.particlesubgraph.json";
const BLOCK = "effects/shrink.particleblock.json";
const NOT_A_SUBGRAPH = "effects/broken.particlesubgraph.json";

/** The Simple Loop template with an exposed number property `Rate`, an exposed colour `Glow` and a hidden colour. */
function sparks(): string {
  const g = defaultParticleGraph();
  g.properties.push({ name: "Rate", type: "number", value: 30, exposed: true }, { name: "Glow", type: "color", value: "#ffffff", exposed: true }, { name: "Tint", type: "color", value: "#ff8800", exposed: false });
  return formatParticleGraph(g);
}

const wobble = {
  format: "myco.particlesubgraph@1",
  inputs: [{ name: "Speed", type: "number" }],
  outputs: [{ name: "Offset", type: "vector3" }],
  nodes: [{ id: "n1", type: "particle.age", position: [0, 0] }],
  edges: [],
};
const shrink = { format: "myco.particleblock@1", label: "Shrink", contexts: ["update"], inputs: [{ name: "Amount", type: "number" }], nodes: [], edges: [], blocks: [{ id: "b1", type: "update.sizeOverLife", inputs: {} }] };

/** A scene with one node playing the effect, with one override set. */
const scene = {
  format: "myco.scene@4",
  nodes: [
    {
      id: "fx",
      name: "Sparks",
      components: [
        { type: "engine.Transform", data: { position: [0, 0, 0] } },
        { type: "engine.ParticleSystem", data: { effect: `asset:${EFFECT}` } },
      ],
    },
  ],
};

const files = { [EFFECT]: sparks(), [SUBGRAPH]: wobble, [BLOCK]: shrink, [NOT_A_SUBGRAPH]: { format: "something else" }, "scenes/main.scene.json": scene };

const meta = {
  title: "Particles/Inspector",
  beforeEach: withEditor,
  parameters: { editor: { files } satisfies EditorStoryParameters },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A definition list's value for a term. */
const dd = (root: HTMLElement, term: string) => [...root.querySelectorAll("dt")].find((d) => d.textContent === term)?.nextElementSibling?.textContent ?? null;

export const EffectAsset: Story = {
  render: () => <ParticleEffectInspector path={EFFECT} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // In the asset document frame (ADR 0265): the effect's file in its head.
    expect(c.getByLabelText("Particle effect").querySelector(".asset-inspector-name")).toHaveTextContent("sparks.particles.json");
    expect(dd(canvasElement, "Exposed properties")).toBe("Rate (number), Glow (color)");
    expect(dd(canvasElement, "Nodes")).toBe("0");
    expect(dd(canvasElement, "Systems")).toMatch(/spawn, \d+ initialize, \d+ update, \d+ output/);
    // Its button opens the effect in the Particle Graph (the kind's panel).
    await userEvent.click(c.getByRole("button", { name: "Open in Particle Graph" }));
    expect(editor.assets.openIn(PARTICLE_GRAPH_PANEL)).toBe(EFFECT);
  },
};

export const SubgraphAsset: Story = {
  render: () => <ParticleAssetInspector path={SUBGRAPH} />,
  play: async ({ canvasElement, step }) => {
    const panel = within(canvasElement).getByLabelText("Particle sub-graph asset");
    await step("its ports and nodes, from the file", async () => {
      expect(dd(panel, "Inputs")).toBe("Speed (number)");
      expect(dd(panel, "Outputs")).toBe("Offset (vector3)");
      expect(dd(panel, "Nodes")).toBe("1");
    });
    await step("an edit in the open Particle Graph shows before it is written (the current value)", async () => {
      const doc = particleDocument(storyProject(), SUBGRAPH);
      doc.edit(addPseudoNode(doc.value.peek(), ASSET_INPUT, [0, 200], { name: "Scale", type: "number" }).graph, { coalesce: true });
      editor.project.changed();
      await waitFor(() => expect(dd(panel, "Inputs")).toBe("Speed (number), Scale (number)"));
      doc.undo();
      editor.project.changed();
      await waitFor(() => expect(dd(panel, "Inputs")).toBe("Speed (number)"));
    });
  },
};

export const BlockAsset: Story = {
  render: () => <ParticleAssetInspector path={BLOCK} />,
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement).getByLabelText("Particle block asset");
    expect(dd(panel, "Label")).toBe("Shrink");
    expect(dd(panel, "Contexts")).toBe("update");
    expect(dd(panel, "Inputs")).toBe("Amount (number)");
    expect(dd(panel, "Blocks")).toBe("1");
    expect(within(panel).queryByText("Outputs")).toBeNull();
  },
};

export const NotASubgraph: Story = {
  render: () => <ParticleAssetInspector path={NOT_A_SUBGRAPH} />,
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("listitem")).toHaveTextContent("This file isn't a particle sub-graph (it should have format myco.particlesubgraph@1).");
    expect(canvasElement.querySelector("dl")).toBeNull();
  },
};

/** The override the scene holds for the node's ParticleSystem. */
const overrides = () => editor.scene.open!.doc.fieldValue("fx", "engine.ParticleSystem", "overrides");

export const SystemOverrides: Story = {
  parameters: { editor: { files, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
  play: async ({ canvasElement, step }) => {
    editor.scene.selection.set(["fx"]);
    const c = within(canvasElement);
    const rate = (await c.findByLabelText("Rate", {}, { timeout: 30000 })) as HTMLInputElement;
    await step("the exposed property shows the effect's value; the hidden one isn't listed", async () => {
      expect(rate.value).toBe("30");
      expect(c.queryByLabelText("Tint")).toBeNull();
      expect(c.getByRole("button", { name: "Revert Rate" })).toBeDisabled();
    });
    await step("typing a value sets this instance's override", async () => {
      await userEvent.clear(rate);
      await userEvent.type(rate, "5");
      await waitFor(() => expect(overrides()).toEqual({ Rate: 5 }));
      expect(c.getByRole("button", { name: "Revert Rate" })).toBeEnabled();
    });
    await step("Revert removes the override from the scene", async () => {
      await userEvent.click(c.getByRole("button", { name: "Revert Rate" }));
      expect(overrides()).toEqual({});
      // The Editor World's component takes the new (empty) overrides, so the field shows the effect's value again.
      await waitFor(() => expect(rate.value).toBe("30"));
      expect(c.getByRole("button", { name: "Revert Rate" })).toBeDisabled();
    });
    await step("undo on the scene brings the override back", async () => {
      editor.scene.open!.stack.undo();
      await waitFor(() => expect(overrides()).toEqual({ Rate: 5 }));
    });
    await step("a colour pick is one undo step, however many values it moves through", async () => {
      const glow = c.getByLabelText("Glow") as HTMLInputElement;
      for (const v of ["#ff0000", "#00ff00", "#0000ff"]) {
        glow.value = v;
        await fireEvent.input(glow);
      }
      await fireEvent.change(glow);
      await waitFor(() => expect(overrides()).toEqual({ Rate: 5, Glow: "#0000ff" }));
      expect(editor.scene.open!.stack.undoLabel).toBe("Edit particle property");
      editor.scene.open!.stack.undo();
      await waitFor(() => expect(overrides()).toEqual({ Rate: 5 }));
    });
    await step("Open in Particle Graph opens the effect in its panel", async () => {
      await userEvent.click(c.getByRole("button", { name: "Open in Particle Graph" }));
      expect(editor.assets.openIn(PARTICLE_GRAPH_PANEL)).toBe(EFFECT);
    });
  },
};
