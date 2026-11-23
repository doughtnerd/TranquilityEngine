// Stories (ADR 0219) for the ragdoll builder's panel (ADR 0373; T55): Generate from Skeleton and Test Drop in each state they
// can be in, over the table. The panel is driven by props (the Inspector section reads the scene), so each state is a story.
// Generation itself is `generateLogic.node.test.ts`; Test Drop's rules are `testDropLogic.test.ts`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { RagdollBone } from "../../runtime/Ragdoll";
import { BuilderPanel, type BuilderPanelProps } from "./BuilderPanel";

const body = (bone: string): RagdollBone => ({
  bone, shape: "capsule", size: { x: 0.05, y: 0.4, z: 0.05 }, center: { x: 0, y: 0.2, z: 0 }, axis: "y", mass: 3, swing: { y: 40, z: 30 }, twist: { min: -20, max: 25 },
  stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0,
});

const base: BuilderPanelProps = {
  bones: [body("spine"), body("thigh")],
  selected: null,
  skeletonBones: ["pelvis", "spine", "thigh"],
  whyNotEdit: null,
  whyNotGenerate: null,
  generating: false,
  generateError: null,
  drop: { label: "Test Drop", disabled: true, title: "Press Play first: Test Drop drops the character in the running game (nothing is saved)." },
  onGenerate: fn(),
  onTestDrop: fn(),
  onSelect: fn(),
  onEdit: fn(() => true),
};

const meta = {
  title: "Ragdoll/Builder",
  component: BuilderPanel,
  args: base,
  render: (args) => (
    <div class="asset-inspector" style={{ width: "460px" }}>
      <BuilderPanel {...args} />
    </div>
  ),
} satisfies Meta<typeof BuilderPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** With bodies: Regenerate, Test Drop (off until the game plays), and the table. */
export const WithBodies: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByRole("table", { name: "Ragdoll bodies" })).toBeTruthy();
    expect(c.getByRole("button", { name: "Test Drop" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Test Drop" })).toHaveAttribute("title", expect.stringMatching(/Press Play first/));
    await userEvent.click(c.getByRole("button", { name: "Regenerate from Skeleton" }));
    expect(args.onGenerate).toHaveBeenCalledOnce();
  },
};

/** No bodies yet: Generate, and a note that the run-time default is used until then. */
export const NoBodies: Story = {
  args: { bones: [] },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.queryByRole("table")).toBeNull();
    expect(c.getByText(/the skeleton's default ragdoll is built/)).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Generate from Skeleton" }));
    expect(args.onGenerate).toHaveBeenCalled();
  },
};

/** No Skeleton on or around the node: Generate is off and says why. */
export const NoSkeleton: Story = {
  args: { bones: [], skeletonBones: null, whyNotGenerate: "No Skeleton found on this node, below it or above it: add one (or an Animator's rig) to generate from." },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: "Generate from Skeleton" })).toBeDisabled();
    expect(c.getAllByText(/No Skeleton found/).length).toBeGreaterThan(0);
  },
};

/** Generating, then a failure with its reason. */
export const Generating: Story = {
  args: { generating: true },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("button", { name: "Generating…" })).toBeDisabled();
  },
};

export const GenerateFailed: Story = {
  args: { generateError: "the animation core couldn't build a ragdoll for this skeleton (status 3)." },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("alert")).toHaveTextContent("couldn't build a ragdoll");
  },
};

/** While the game plays the bodies can't be edited (the edit gate), so Generate and the table are off, with the reason. */
export const WhilePlaying: Story = {
  args: { whyNotEdit: "Can't edit the scene while the game plays.", drop: { label: "Test Drop", disabled: false, title: 'Set the running character\'s Ragdoll to "ragdoll": it goes limp and drops under gravity.' } },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: "Regenerate from Skeleton" })).toBeDisabled();
    expect(c.getByLabelText("Mass of spine")).toBeDisabled();
    expect(c.getByText("Can't edit the scene while the game plays.")).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Test Drop" }));
    expect(args.onTestDrop).toHaveBeenCalledOnce();
  },
};

/** After a drop the button is Reset. */
export const Dropped: Story = {
  args: { whyNotEdit: "Can't edit the scene while the game plays.", drop: { label: "Reset", disabled: false, title: "Put the Ragdoll's mode back to what it was." } },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getByRole("button", { name: "Reset" })).toBeEnabled();
  },
};
