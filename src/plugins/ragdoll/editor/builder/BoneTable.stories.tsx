// Stories (ADR 0219) for the ragdoll builder's per-bone table (ADR 0373; T55): every cell of a body, the refusals (a size, mass,
// swing, twist or pin outside its rule leaves the list as it was and says why), selecting a row for the gizmo, and adding and
// removing bodies. The rules are unit tests (`ragdollLogic.test.ts`); the table writes through a callback here, as the
// Inspector section writes the component's `bones` field.
import { useState } from "preact/hooks";
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { EditResult } from "../../../../editor/sdk";
import type { RagdollBone } from "../../runtime/Ragdoll";
import { BoneTable } from "./BoneTable";
import type { Bones } from "./ragdollLogic";

const body = (bone: string, over: Partial<RagdollBone> = {}): RagdollBone => ({
  bone, shape: "capsule", size: { x: 0.05, y: 0.4, z: 0.05 }, center: { x: 0, y: 0.2, z: 0 }, axis: "y", mass: 3, swing: { y: 40, z: 30 }, twist: { min: -20, max: 25 },
  stiffness: 400, damping: 40, maxForce: 1000, strength: 1, pin: 0, ...over,
});
const START: Bones = [body("pelvis", { shape: "box", size: { x: 0.3, y: 0.2, z: 0.2 }, pin: 1 }), body("spine"), body("head", { shape: "sphere", size: { x: 0.1, y: 0.1, z: 0.1 } })];
const SKELETON = ["pelvis", "spine", "head", "thigh", "shin"];

/** The table over its own list; `refused` shows the last refusal, `log` the labels of accepted edits. */
function Harness(props: { disabled?: boolean; skeletonBones?: readonly string[] | null; bones?: Bones }) {
  const [bones, setBones] = useState<Bones>(props.bones ?? START);
  const [selected, setSelected] = useState<string | null>(null);
  const [refused, setRefused] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const onEdit = (result: EditResult<Bones>, label: string) => {
    if ("refused" in result) {
      setRefused(result.refused);
      return false;
    }
    setRefused("");
    setLog((l) => [...l, label]);
    setBones(result.next);
    return true;
  };
  return (
    <div class="asset-inspector" style={{ width: "460px" }}>
      <BoneTable bones={bones} selected={selected} skeletonBones={props.skeletonBones === undefined ? SKELETON : props.skeletonBones} disabled={!!props.disabled} onSelect={setSelected} onEdit={onEdit} />
      <p aria-label="Last refusal">{refused}</p>
      <ul aria-label="Accepted edits">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

const meta = { title: "Ragdoll/Bone table", component: Harness } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The bodies with their shapes, sizes by shape, and limits. */
export const Bodies: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByLabelText("Shape of pelvis")).toHaveValue("box");
    expect(c.getByLabelText("X of pelvis")).toHaveValue(0.3);
    expect(c.getByLabelText("Radius of spine")).toHaveValue(0.05);
    expect(c.getByLabelText("Height of spine")).toHaveValue(0.4);
    expect(c.queryByLabelText("Height of head")).toBeNull(); // a sphere has a radius only
    expect(c.getByLabelText("Swing Y of spine")).toHaveValue(40);
    expect(c.getByLabelText("Twist min of spine")).toHaveValue(-20);
    expect(c.getByLabelText("Pin of pelvis")).toHaveValue(1);
  },
};

/** Each cell edit is accepted and changes the list. */
export const EditCells: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const set = (label: string, value: string) => fireEvent.change(c.getByLabelText(label), { target: { value } });
    set("Mass of spine", "4.5");
    await waitFor(() => expect(c.getByLabelText("Mass of spine")).toHaveValue(4.5));
    set("Swing Y of spine", "60");
    set("Swing Z of spine", "10");
    set("Twist min of spine", "-90");
    set("Twist max of spine", "90");
    set("Stiffness of spine", "800");
    set("Damping of spine", "80");
    set("Max force of spine", "2000");
    set("Pin of spine", "0.5");
    set("Radius of spine", "0.06");
    set("Height of spine", "0.5");
    await waitFor(() => expect(c.getByLabelText("Accepted edits").children).toHaveLength(11));
    expect(c.getByLabelText("Swing Y of spine")).toHaveValue(60);
    expect(c.getByLabelText("Height of spine")).toHaveValue(0.5);
    expect(c.getByLabelText("Last refusal")).toHaveTextContent("");
  },
};

/** A value outside its rule is refused with the rule, and the cell keeps the list's value. */
export const Refusals: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const refused = c.getByLabelText("Last refusal");
    const set = async (label: string, value: string, why: RegExp) => {
      fireEvent.change(c.getByLabelText(label), { target: { value } });
      await waitFor(() => expect(refused).toHaveTextContent(why));
    };
    await set("Mass of spine", "0", /mass is above 0/);
    await set("Radius of spine", "0", /sizes are/);
    await set("Height of spine", "0.05", /at least as tall as it is wide/);
    await set("Swing Y of spine", "181", /swing is 0 to 180/);
    await set("Twist max of spine", "200", /twist is -180 to 180/);
    await set("Twist min of spine", "60", /minimum can't be above/);
    await set("Stiffness of spine", "-1", /can't be negative/);
    await set("Pin of spine", "2", /pin is 0 to 1/);
    expect(c.getByLabelText("Accepted edits").children).toHaveLength(0);
  },
};

/** A shape change carries the size over and rescales the mass. */
export const ChangeShape: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Shape of spine"), "sphere");
    await waitFor(() => expect(c.getByLabelText("Shape of spine")).toHaveValue("sphere"));
    expect(c.queryByLabelText("Height of spine")).toBeNull();
    await userEvent.selectOptions(c.getByLabelText("Shape of spine"), "box");
    await waitFor(() => expect(c.getByLabelText("Z of spine")).toBeTruthy());
  },
};

/** Clicking a bone selects its row, which the viewport gizmo then shows; clicking it again clears it. */
export const SelectRow: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const spine = c.getByRole("button", { name: "Select spine" });
    await userEvent.click(spine);
    await waitFor(() => expect(spine).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(c.getByRole("button", { name: "Select head" }));
    await waitFor(() => expect(spine).toHaveAttribute("aria-pressed", "false"));
    await userEvent.click(c.getByRole("button", { name: "Select head" }));
    await waitFor(() => expect(c.getByRole("button", { name: "Select head" })).toHaveAttribute("aria-pressed", "false"));
  },
};

/** A body is added to a bone that has none, and removed again; the last body can't be removed. */
export const AddAndRemove: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Bone for a new body"), "thigh");
    await userEvent.click(c.getByRole("button", { name: "Add Body" }));
    await waitFor(() => expect(c.getByLabelText("Shape of thigh")).toBeTruthy());
    await userEvent.click(c.getByRole("button", { name: "Remove the body of thigh" }));
    await waitFor(() => expect(c.queryByLabelText("Shape of thigh")).toBeNull());
    await userEvent.click(c.getByRole("button", { name: "Remove the body of head" }));
    await userEvent.click(c.getByRole("button", { name: "Remove the body of spine" }));
    await waitFor(() => expect(c.queryByLabelText("Shape of spine")).toBeNull());
    await userEvent.click(c.getByRole("button", { name: "Remove the body of pelvis" }));
    await waitFor(() => expect(c.getByLabelText("Last refusal")).toHaveTextContent("at least one body"));
    expect(c.getByLabelText("Shape of pelvis")).toBeTruthy();
  },
};

/** A body that breaks a rule (hand-edited data) or names a bone the skeleton lacks is marked, with the rule listed. */
export const Problems: Story = {
  args: { bones: [body("pelvis"), body("spine", { mass: -1 }), body("tail")] },
  play: async ({ canvasElement }) => {
    const list = within(within(canvasElement).getByLabelText("Body problems"));
    expect(list.getByText(/spine: mass is above 0/)).toBeTruthy();
    expect(list.getByText(/tail: the skeleton has no bone tail/)).toBeTruthy();
  },
};

/** Read-only: every cell and button is off. */
export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByLabelText("Mass of spine")).toBeDisabled();
    expect(c.getByLabelText("Shape of spine")).toBeDisabled();
    expect(c.getByRole("button", { name: "Remove the body of spine" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Add Body" })).toBeDisabled();
  },
};

/** Without the skeleton's bones there is no add control. */
export const NoSkeleton: Story = {
  args: { skeletonBones: null },
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).queryByRole("button", { name: "Add Body" })).toBeNull();
  },
};
