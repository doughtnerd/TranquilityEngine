// Stories (ADR 0219) for the skeleton profile (chain) editor (ADR 0373; T54): a `*.skelprofile.json` selected in the Assets
// panel. Each edit goes through the profile's asset document, so each story checks the file it writes and its Undo and Redo.
// The rules (validation by the profile parse) are unit tests (`chainLogic.test.ts`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { ProfileEditor } from "./ProfileEditor";

const PROFILE = "rigs/quad.skelprofile.json";

interface Saved {
  roles: { name: string; mirror?: string; flip?: string; required?: boolean; range?: Record<string, number> }[];
  chains?: { name: string; kind: string; roles: string[]; ik?: boolean }[];
  hips?: string;
}

const quad = {
  format: "myco.skelprofile@1",
  name: "Quadruped",
  roles: [{ name: "Hips", required: true }, { name: "FrontLeft", mirror: "FrontRight" }, { name: "FrontRight", mirror: "FrontLeft" }, { name: "Tail" }],
  chains: [{ name: "Front", kind: "leg", roles: ["FrontLeft", "FrontRight"] }],
};

const saved = () => fileJson<Saved>(PROFILE);

const meta = {
  title: "Animation/Skeleton profile",
  component: ProfileEditor,
  beforeEach: withEditor,
  parameters: { editor: { files: { [PROFILE]: quad } } satisfies EditorStoryParameters },
  args: { path: PROFILE },
} satisfies Meta<typeof ProfileEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A new role is added to the file, and undone and redone. */
export const AddRole: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByLabelText("New role name"), "Neck");
    await userEvent.click(c.getByRole("button", { name: "Add Role" }));
    await waitFor(async () => expect((await saved()).roles.map((r) => r.name)).toEqual(["Hips", "FrontLeft", "FrontRight", "Tail", "Neck"]));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved()).roles).toHaveLength(4));
    await userEvent.click(c.getByRole("button", { name: "Redo" }));
    await waitFor(async () => expect((await saved()).roles).toHaveLength(5));
  },
};

/** A role's flip, requirement and joint range. */
export const RoleSettings: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Flip of FrontLeft"), "x");
    await waitFor(async () => expect((await saved()).roles.find((r) => r.name === "FrontLeft")?.flip).toBe("x"));
    await userEvent.click(c.getByLabelText("Tail is required"));
    await waitFor(async () => expect((await saved()).roles.find((r) => r.name === "Tail")?.required).toBe(true));
    await userEvent.click(c.getByLabelText("Tail has a joint range"));
    fireEvent.change(await c.findByLabelText("Swing Y of Tail"), { target: { value: "45" } });
    await waitFor(async () => expect((await saved()).roles.find((r) => r.name === "Tail")?.range).toMatchObject({ swingY: 45 }));
  },
};

/** Chains: a role added to one, moved, and IK, which the profile's rules allow only from three roles. */
export const Chains: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Add a role to Front"), "Tail");
    await waitFor(async () => expect((await saved()).chains?.[0].roles).toEqual(["FrontLeft", "FrontRight", "Tail"]));
    await userEvent.click(c.getByRole("button", { name: "Move Tail up" }));
    await waitFor(async () => expect((await saved()).chains?.[0].roles).toEqual(["FrontLeft", "Tail", "FrontRight"]));
    await userEvent.click(c.getByLabelText("IK on Front"));
    await waitFor(async () => expect((await saved()).chains?.[0].ik).toBe(true));
  },
};

/** A refused edit changes nothing: IK on a two-role chain. */
export const RefusedEdit: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByLabelText("IK on Front"));
    expect(((await saved()).chains ?? [])[0].ik).toBeUndefined();
    expect((c.getByLabelText("IK on Front") as HTMLInputElement).checked).toBe(false);
  },
};

/** The hips role is picked from the roles. */
export const HipsRole: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Hips role"), "Hips");
    await waitFor(async () => expect((await saved()).hips).toBe("Hips"));
  },
};
