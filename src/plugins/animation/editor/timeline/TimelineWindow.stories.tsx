// Stories (ADR 0219, 0235) for the Timeline window (ADR 0373) as the dock renders it, over a scene open in a headless
// Editor World: nothing to edit, the window bound to the selected node's TimelineDirector (a heading per bound node,
// clips as bars, the blend region where two clips overlap, instant keys), selecting and deleting an item, a refused
// split, and opening a nested timeline from the breadcrumb. The edit rules are unit-tested
// (`timelineLogic.test.ts`, `timelineSession.test.ts`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { TIMELINE_WINDOW_PANEL } from "./panelId";

const SCENE = "scenes/level.scene.json";
const FILE = "animation/intro.timeline.json";
const INNER = "animation/inner.timeline.json";
const scene = {
  format: "myco.scene@4",
  nodes: [
    { id: "dir", name: "Dir", components: [{ type: "engine.Transform", data: {} }, { type: "engine.TimelineDirector", data: { timeline: `asset:${FILE}`, playOnStart: false } }] },
    { id: "hero", name: "Hero", parent: "dir", components: [{ type: "engine.Transform", data: {} }] },
    { id: "crate", name: "Crate", components: [{ type: "engine.Transform", data: {} }] },
  ],
};
const clip = (time: number, end: number, ref: string, extra = {}) => ({ time, end, clip: `asset:${ref}`, ...extra });
const intro = {
  format: "myco.timeline@1",
  duration: 8,
  tracks: [
    { kind: "subclip", target: { nodePath: "Hero" }, keys: [clip(0, 3, "animation/wave.anim.json", { blendOut: 1 }), clip(2, 6, "animation/run.anim.json", { blendIn: 1 })] },
    { kind: "subclip", keys: [clip(1, 3, INNER)] },
    { kind: "control", keys: [{ time: 0, action: "cameraCut", target: "Hero" }] },
    { kind: "marker", keys: [{ time: 4, kind: "cue", name: "Beat" }] },
  ],
};
const inner = { format: "myco.timeline@1", duration: 2, tracks: [{ kind: "activation", target: { nodePath: "Hero" }, keys: [{ time: 0.5, end: 1.5 }] }] };

const meta = {
  title: "Animation/Timeline Window",
  beforeEach: withEditor,
  parameters: {
    editor: {
      files: { [SCENE]: scene, [FILE]: intro, [INNER]: inner, "animation/wave.anim.json": { format: "myco.anim-source@1", duration: 3 }, "animation/run.anim.json": { format: "myco.anim-source@1", duration: 4 } },
      scene: SCENE,
    } satisfies EditorStoryParameters,
  },
  render: () => <PanelStory id={TIMELINE_WINDOW_PANEL} height={460} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const shows = (canvasElement: HTMLElement, text: string | RegExp) => within(canvasElement).findByText(text, {}, { timeout: 30000 });

/** Nothing selected and no timeline opened: how to bind the window. */
export const NothingToEdit: Story = {
  play: async ({ canvasElement }) => {
    await shows(canvasElement, "Nothing to edit");
  },
};

/** A node under a director: its timeline's groups, bars, the blend region between the overlapping clips, and a binding picker. */
export const BoundToDirector: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "Camera cuts");
    expect(c.getByText("Nested timelines")).toBeTruthy();
    expect(c.getByRole("button", { name: /wave\.anim\.json · 0\.00 – 3\.00 s/ })).toBeTruthy();
    expect(c.getByTitle(/Blend 2\.00 s – 3\.00 s/)).toBeTruthy();
    expect(c.getByRole("combobox", { name: "Binding of Hero" })).toBeTruthy();
  },
};

/** Selecting a clip shows its fields; Delete removes it as one undo step. */
export const SelectAndDelete: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "Camera cuts");
    const bar = c.getByRole("button", { name: /run\.anim\.json · 2\.00 – 6\.00 s/ });
    await userEvent.click(bar);
    expect(bar).toHaveAttribute("aria-pressed", "true");
    expect(c.getByRole("group", { name: "Clip" })).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(c.queryByRole("button", { name: /run\.anim\.json/ })).toBeNull());
  },
};

/** Split at a playhead that isn't on the clip is refused and leaves the clip whole. */
export const SplitRefused: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "Camera cuts");
    await userEvent.click(c.getByRole("button", { name: /run\.anim\.json · 2\.00 – 6\.00 s/ }));
    await userEvent.click(c.getByRole("button", { name: "Split" })); // the playhead is at 0, before the clip
    expect(c.getByRole("button", { name: /run\.anim\.json · 2\.00 – 6\.00 s/ })).toBeTruthy();
  },
};

/** Double-clicking a nested timeline opens it; the breadcrumb leads back. */
export const NestedTimeline: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "Camera cuts");
    await userEvent.dblClick(c.getByRole("button", { name: /inner\.timeline\.json · 1\.00 – 3\.00 s/ }));
    await shows(canvasElement, "Activation");
    const nav = within(c.getByRole("navigation", { name: "Timeline path" }));
    expect(nav.getByText("inner")).toHaveAttribute("aria-current", "page");
    await userEvent.click(nav.getByRole("button", { name: "intro" }));
    await shows(canvasElement, "Camera cuts");
  },
};

/** Preview turns on for a director; turning it off leaves the scene as it was. */
export const Preview: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "Camera cuts");
    await userEvent.click(c.getByRole("button", { name: "Preview" }));
    expect(c.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Preview" }));
    expect(c.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "false");
  },
};
