// Stories (ADR 0219, 0235) for the SDK's asset picker (ADR 0282): what an asset slot lists from the open project's files
// by field kind, how entries are labelled, the stored form (`asset:` or the bare path), built-in entries, the missing
// state and a multi-selection's dash. Each story renders the picker over a value held in state and checks the options a
// user sees and the value a pick stores.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { withEditor, type EditorStoryParameters } from "../stories/editorStory";
import { AssetPicker, type AssetPickerProps } from "./AssetPicker";

/** The picker over a value in state, and what it stores shown beside it. */
function PickerDemo(props: Omit<AssetPickerProps, "onCommit">) {
  const [value, setValue] = useState(props.value);
  const [picks, setPicks] = useState(0);
  return (
    <div>
      <AssetPicker
        {...props}
        value={value}
        onCommit={(v) => {
          setValue(v);
          setPicks((n) => n + 1);
        }}
      />
      <output aria-label="Stored">{value}</output>
      <output aria-label="Picks">{picks}</output>
    </div>
  );
}

/** A binary file's bytes (what's in them doesn't matter to the picker). */
const BYTES = new Uint8Array([0]);

const FILES = {
  "images/bird.png": BYTES,
  "images/bird.png.meta.json": "{}",
  "images/sky.jpg": BYTES,
  "props/bird.png": BYTES,
  "rt/mirror.rendertexture.json": { width: 256, height: 256 },
  "audio/flap.ogg": BYTES,
  "models/ship.glb": BYTES,
};

const meta = {
  title: "Editor/Asset picker",
  component: PickerDemo,
  beforeEach: withEditor,
  parameters: { editor: { files: FILES } satisfies EditorStoryParameters },
  args: { value: "", kinds: ["texture", "rendertexture"], label: "Texture" },
} satisfies Meta<typeof PickerDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

const optionTexts = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.text);
const stored = (c: ReturnType<typeof within>) => c.getByLabelText("Stored").textContent;

export const ListsWhatFits: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Texture" });
    await step("images and render textures, sidecars left out; a name two files share shows their paths", async () => {
      await waitFor(() => expect(optionTexts(select)).toEqual(["None", "images/bird.png", "sky.jpg", "props/bird.png", "mirror.rendertexture.json"]));
      expect(select).toHaveValue("");
    });
    await step("a pick stores the file as an asset reference, and None clears it", async () => {
      await userEvent.selectOptions(select, "asset:rt/mirror.rendertexture.json");
      expect(stored(c)).toBe("asset:rt/mirror.rendertexture.json");
      expect(select).toHaveAttribute("title", "rt/mirror.rendertexture.json");
      await userEvent.selectOptions(select, "");
      expect(stored(c)).toBe("");
    });
  },
};

export const BarePathStoredForm: Story = {
  args: { value: "asset:./images/sky.jpg", kinds: ["texture"], stored: "path", none: "No image" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Texture" });
    // Any reference form reads; the slot shows and stores the bare path.
    await waitFor(() => expect(select).toHaveValue("images/sky.jpg"));
    expect(optionTexts(select)[0]).toBe("No image");
    await userEvent.selectOptions(select, "props/bird.png");
    expect(stored(c)).toBe("props/bird.png");
  },
};

export const MissingFile: Story = {
  args: { value: "asset:images/gone.png", kinds: ["texture"] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Texture" });
    // The reference is kept and marked until another entry is picked; picking it again stores nothing.
    const missing = await c.findByRole("option", { name: "gone.png (missing)" });
    expect(missing).toBeDisabled();
    expect(select).toHaveValue("asset:images/gone.png");
    await userEvent.selectOptions(select, "asset:images/sky.jpg");
    expect(stored(c)).toBe("asset:images/sky.jpg");
    expect(c.queryByRole("option", { name: /missing/ })).toBeNull();
  },
};

export const BuiltInsAndSubMeshes: Story = {
  args: { value: "models/ship.glb#Hull", kinds: ["mesh"], stored: "path", label: "Mesh" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Mesh" });
    // Built-in meshes come first, then model files; a sub-mesh of a file that exists shows as itself, not missing.
    await waitFor(() => expect(optionTexts(select)[1]).toBe("Cube"));
    expect(optionTexts(select)).toContain("ship.glb");
    expect(select).toHaveValue("models/ship.glb#Hull");
    expect(c.getByRole("option", { name: "ship.glb#Hull" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "builtin:cube");
    expect(stored(c)).toBe("builtin:cube");
  },
};

export const MixedSelection: Story = {
  args: { value: "asset:images/sky.jpg", mixed: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const select = c.getByRole("combobox", { name: "Texture" }) as HTMLSelectElement;
    // Values that differ show a dash, which can't be picked; picking an entry stores it for every node.
    await waitFor(() => expect(select.selectedOptions[0].disabled).toBe(true));
    expect(c.getByLabelText("Picks")).toHaveTextContent("0");
    await userEvent.selectOptions(select, "asset:images/sky.jpg");
    expect(c.getByLabelText("Picks")).toHaveTextContent("1");
    expect(stored(c)).toBe("asset:images/sky.jpg");
  },
};

export const MustNameAFile: Story = {
  args: { value: "images/sky.jpg", kinds: ["texture"], stored: "path", none: null, accepts: (f: string) => f.startsWith("images/") },
  play: async ({ canvasElement }) => {
    const select = within(canvasElement).getByRole("combobox", { name: "Texture" });
    // No empty entry, and `accepts` narrows the files the kind offers.
    await waitFor(() => expect(optionTexts(select)).toEqual(["bird.png", "sky.jpg"]));
  },
};
