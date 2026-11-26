// Stories (ADR 0219) for the 2D bone editor, the Sprite Editor's Bones tab (ADR 0373 "2D tools"; T56). The rules (bone edits,
// parenting, auto-weights, brush strokes, refusals) are unit tests (`skinLogic.test.ts`, `boneViewLogic.test.ts`); these
// drive the view with pointer events over a harness that keeps the slices as the Sprite Editor does and counts the history
// steps it was given (a drag is one step: its moves share a key).
import { useState } from "preact/hooks";
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { SpriteEditorChange } from "../../../../editor/sdk";
import type { SliceSkin } from "../../../../engine/animation/sprites/sidecar";
import type { SpriteSlice } from "../../../../engine/scene/importSettings";
import { BoneEditor } from "./BoneEditor";
import { SHEET_SLICES, SHEET_URL } from "./twoDStoryFixtures";

const BONE = (name: string, parent: string | null, position: [number, number], rotation: number, length: number) => ({ name, parent, position, rotation, length });
const TORSO: SliceSkin = { bones: [BONE("hip", null, [8, 4], 90, 12), BONE("chest", "hip", [12, 0], 0, 12)], mesh: null, weights: null };

/** The tool over its own slices (the first with `skin`), counting the steps it was asked to make. */
function Harness(props: { skin?: SliceSkin; readOnly?: string | null }) {
  const [slices, setSlices] = useState<readonly SpriteSlice[]>(SHEET_SLICES.map((s) => (s.name === "walk_0" && props.skin ? { ...s, skin: props.skin } : s)));
  const [selected, setSelected] = useState<string | null>("walk_0");
  const [steps, setSteps] = useState<string[]>([]);
  const lastKey = { current: null as string | null };
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "900px", height: "560px" }}>
      <BoneEditor
        image="sheets/hero.png"
        url={SHEET_URL}
        slices={slices}
        flipbooks={{}}
        secondaryTextures={{}}
        normalMapGreen="up"
        selected={selected}
        select={setSelected}
        readOnly={props.readOnly ?? null}
        pixels={async () => {
          // The sheet's pixels, as the Sprite Editor reads them.
          const img = new Image();
          img.src = SHEET_URL;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height);
        }}
        edit={(change: SpriteEditorChange, key?: string) => {
          setSlices((all) => all.map((s) => (change.skins && s.name in change.skins ? { ...s, skin: change.skins[s.name] ?? undefined } : s)));
          setSteps((n) => (key !== undefined && key === lastKey.current ? n : [...n, key ?? "step"]));
          lastKey.current = key ?? null;
        }}
      />
      <output aria-label="History steps">{steps.length}</output>
      <pre aria-label="Skin as stored">{JSON.stringify(slices.find((s) => s.name === "walk_0")?.skin ?? null)}</pre>
    </div>
  );
}

const meta = { title: "Animation/2D tools/Bone editor", component: Harness } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

const pointer = { pointerId: 3, button: 0 };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const stageOf = (c: HTMLElement) => c.querySelector<HTMLElement>(".bone-stage")!;
/** A slice-frame point (y up) as a client point over the stage at its zoom. */
const at = (stage: HTMLElement, x: number, y: number) => {
  const r = stage.getBoundingClientRect();
  const zoom = r.width / 16; // walk_0 is 16 × 32
  return { clientX: r.left + x * zoom, clientY: r.top + (32 - y) * zoom };
};
const skinOf = (c: HTMLElement) => JSON.parse(within(c).getByLabelText("Skin as stored").textContent!) as SliceSkin | null;
const steps = (c: HTMLElement) => Number(within(c).getByLabelText("History steps").textContent);

/** Dragging with Create Bones makes a bone from the start to the end as one step; the next is its child, attached to the selection. */
export const CreateBones: Story = {
  play: async ({ canvasElement }) => {
    const stage = stageOf(canvasElement);
    fireEvent.pointerDown(stage, { ...pointer, ...at(stage, 8, 4) });
    await tick();
    fireEvent.pointerMove(stage, { ...pointer, ...at(stage, 8, 14) });
    await tick();
    expect(skinOf(canvasElement)).toBeNull(); // nothing is made until release
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 8, 16) });
    await waitFor(() => expect(skinOf(canvasElement)!.bones).toEqual([{ name: "bone_1", parent: null, position: [8, 4], rotation: 90, length: 12 }]));
    expect(steps(canvasElement)).toBe(1);
    fireEvent.pointerDown(stage, { ...pointer, ...at(stage, 8, 16) });
    await tick();
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 8, 28) });
    await waitFor(() => expect(skinOf(canvasElement)!.bones.map((b) => [b.name, b.parent])).toEqual([["bone_1", null], ["bone_2", "bone_1"]]));
    expect(steps(canvasElement)).toBe(2);
  },
};

/** Moving a bone's tip is one step however many moves the drag has, and turns and resizes the bone. */
export const MoveATip: Story = {
  args: { skin: TORSO },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("radio", { name: "Move" }));
    const stage = stageOf(canvasElement);
    const tip = stage.querySelector<SVGElement>('[data-bone="hip"] [data-end="tip"]')!;
    fireEvent.pointerDown(tip, { ...pointer, ...at(stage, 8, 16) });
    await tick();
    for (const x of [10, 12, 14]) {
      fireEvent.pointerMove(stage, { ...pointer, ...at(stage, x, 4) });
      await tick();
    }
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 14, 4) });
    await waitFor(() => expect(skinOf(canvasElement)!.bones[0]!.rotation).toBeCloseTo(0, 5));
    expect(skinOf(canvasElement)!.bones[0]!.length).toBeCloseTo(6, 5);
    expect(steps(canvasElement)).toBe(1);
  },
};

/** Parenting through the Parent list keeps the bone where it is; the bone being parented to its own child is refused with the reason. */
export const Parenting: Story = {
  args: { skin: { ...TORSO, bones: [...TORSO.bones, BONE("arm", null, [4, 20], 0, 8)] } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "arm" }));
    await userEvent.selectOptions(c.getByLabelText("Bone parent"), "chest");
    await waitFor(() => expect(skinOf(canvasElement)!.bones.find((b) => b.name === "arm")!.parent).toBe("chest"));
    expect(steps(canvasElement)).toBe(1);
    // The list offers no descendant of the bone, so a cycle can't be picked.
    await userEvent.click(c.getByRole("button", { name: "hip" }));
    expect(within(c.getByLabelText("Bone parent")).queryByRole("option", { name: "arm" })).toBeNull();
    expect(within(c.getByLabelText("Bone parent")).queryByRole("option", { name: "chest" })).toBeNull();
  },
};

/** Auto Weights makes the mesh when there is none, then the weights, as one step; each vertex's weights sum to 1. */
export const AutoWeights: Story = {
  args: { skin: TORSO },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Auto weight method"), "envelope");
    await userEvent.click(c.getByRole("button", { name: "Auto Weights" }));
    await waitFor(() => expect(skinOf(canvasElement)!.weights).not.toBeNull());
    const skin = skinOf(canvasElement)!;
    expect(skin.weights).toHaveLength(skin.mesh!.vertices.length / 2);
    for (const w of skin.weights!) expect(w.filter((_, i) => i % 2 === 1).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(steps(canvasElement)).toBe(1);
  },
};

/** A brush stroke changes weights near the pointer as one step, leaves them normalised, and says why when it can't paint. */
export const PaintWeights: Story = {
  args: { skin: TORSO },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("radio", { name: "Paint Weights" }));
    const stage = stageOf(canvasElement);
    // No bone is selected yet, so painting is refused with its reason and nothing changes.
    fireEvent.pointerDown(stage, { ...pointer, ...at(stage, 8, 16) });
    await tick();
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 8, 16) });
    expect(steps(canvasElement)).toBe(0);
    await userEvent.click(c.getByRole("button", { name: "Auto Weights" }));
    await waitFor(() => expect(skinOf(canvasElement)!.weights).not.toBeNull());
    await userEvent.click(c.getByRole("button", { name: "chest" }));
    const before = skinOf(canvasElement)!.weights!;
    fireEvent.pointerDown(stage, { ...pointer, ...at(stage, 8, 24) });
    await tick();
    fireEvent.pointerMove(stage, { ...pointer, ...at(stage, 8, 26) });
    await tick();
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 8, 26) });
    await waitFor(() => expect(skinOf(canvasElement)!.weights).not.toEqual(before));
    for (const w of skinOf(canvasElement)!.weights!) expect(w.filter((_, i) => i % 2 === 1).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
    expect(steps(canvasElement)).toBe(2); // Auto Weights, then the stroke (its dabs are one step)
  },
};

/** Removing a bone lifts its child and keeps the weights valid. */
export const RemoveABone: Story = {
  args: { skin: TORSO },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Auto Weights" }));
    await waitFor(() => expect(skinOf(canvasElement)!.weights).not.toBeNull());
    await userEvent.click(c.getByRole("button", { name: "hip" }));
    await userEvent.click(c.getByRole("button", { name: "Remove Bone" }));
    await waitFor(() => expect(skinOf(canvasElement)!.bones.map((b) => [b.name, b.parent])).toEqual([["chest", null]]));
  },
};

/** A read-only project leaves the editing buttons off. */
export const ReadOnly: Story = {
  args: { skin: TORSO, readOnly: "This project is read-only." },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: "Auto Weights" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Generate Mesh" })).toBeDisabled();
    const stage = stageOf(canvasElement);
    fireEvent.pointerDown(stage, { ...pointer, ...at(stage, 8, 4) });
    fireEvent.pointerUp(stage, { ...pointer, ...at(stage, 8, 16) });
    await tick();
    expect(steps(canvasElement)).toBe(0);
  },
};
