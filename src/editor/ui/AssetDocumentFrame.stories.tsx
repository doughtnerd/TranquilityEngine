// Stories (ADR 0219, 0235) for the asset document frame (ADR 0265): what every asset document editor renders in. A
// story asset kind, a counter whose file holds `{ "n": <number> }`, is registered as a plugin would register one, and
// its editor is the frame around a body of one button. Each story checks the frame through what a user sees and the
// file it writes: the head, Undo / Redo and their tooltips, focus making the document the active history, the
// problems list and the read-only notice.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { activeHistory, assetKinds, editor, openAssetDocument, type AssetKindContribution } from "../sdk";
import { fileJson, storyProject, withEditor, type EditorStoryParameters } from "../stories/editorStory";
import { AssetDocumentFrame } from "./AssetDocumentFrame";

interface Counter {
  n: number;
}

const KIND = "story.counter";
const FILE = "counters/clicks.counter.json";

const counterKind: AssetKindContribution<Counter> = {
  id: KIND,
  extensions: [".counter.json"],
  label: "Counter",
  icon: "",
  format: {
    parse: (raw) => {
      const n = (raw as { n?: unknown } | undefined)?.n;
      return typeof n === "number" ? { value: { n }, problems: [] } : { value: { n: 0 }, problems: [{ message: "The count isn't a number." }] };
    },
    format: (value) => `${JSON.stringify(value)}\n`,
    empty: () => ({ n: 0 }),
  },
};

/** The counter's editor: the frame, and a body that adds one. `extra`: problems the kind adds. */
function CounterEditor(props: { path: string; extra?: string[] }) {
  editor.project.version;
  const doc = openAssetDocument<Counter>(storyProject(), props.path, KIND);
  return (
    <AssetDocumentFrame doc={doc} kind="Counter" class="inspector-body asset-inspector" problems={props.extra}>
      <p aria-label="Count">{doc.value.value.n}</p>
      <button disabled={doc.readOnly} onClick={() => doc.edit({ n: doc.value.peek().n + 1 }, { label: "Add One" })}>
        Add one
      </button>
    </AssetDocumentFrame>
  );
}

const meta = {
  title: "Editor/Asset document frame",
  component: CounterEditor,
  beforeEach: async (context) => {
    const off = assetKinds.register(counterKind);
    const cleanup = await withEditor(context);
    return async () => {
      await cleanup();
      off();
    };
  },
  parameters: { editor: { files: { [FILE]: { n: 1 } } } satisfies EditorStoryParameters },
  args: { path: FILE },
} satisfies Meta<typeof CounterEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

const saved = async () => (await fileJson<Counter>(FILE)).n;

export const UndoAndRedo: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    const frame = c.getByLabelText("Counter");
    const undo = () => c.getByRole("button", { name: "Undo" });
    const redo = () => c.getByRole("button", { name: "Redo" });
    await step("the head names the kind and the file; nothing to undo yet, and the tooltips say so", async () => {
      expect(frame.querySelector(".asset-inspector-kind")).toHaveTextContent("Counter");
      expect(frame.querySelector(".asset-inspector-name")).toHaveTextContent("clicks.counter.json");
      expect(frame.querySelector(".asset-inspector-name")).toHaveAttribute("title", FILE);
      expect(undo()).toBeDisabled();
      expect(undo()).toHaveAttribute("title", "Nothing to undo in this counter");
      expect(redo()).toBeDisabled();
      expect(redo()).toHaveAttribute("title", "Nothing to redo in this counter");
      expect(frame.querySelector(".asset-document-readonly")).toBeNull();
      expect(frame.querySelector(".asset-inspector-problems")).toBeNull();
    });
    await step("an edit in the body is written, and Undo names it", async () => {
      await userEvent.click(c.getByRole("button", { name: "Add one" }));
      await waitFor(async () => expect(await saved()).toBe(2));
      expect(undo()).toBeEnabled();
      expect(undo()).toHaveAttribute("title", "Undo Add One (Ctrl+Z)");
    });
    await step("Undo and Redo step the document, and write the file", async () => {
      await userEvent.click(undo());
      await waitFor(async () => expect(await saved()).toBe(1));
      expect(c.getByLabelText("Count")).toHaveTextContent("1");
      expect(undo()).toBeDisabled();
      expect(redo()).toHaveAttribute("title", "Redo Add One (Ctrl+Shift+Z)");
      await userEvent.click(redo());
      await waitFor(async () => expect(await saved()).toBe(2));
    });
  },
};

export const FocusMakesItTheActiveHistory: Story = {
  play: async ({ canvasElement }) => {
    const frame = within(canvasElement).getByLabelText("Counter");
    expect(frame).toHaveAttribute("data-asset-document", FILE);
    // A click on a part that isn't a control still focuses the frame, so Ctrl+Z and Edit > Undo act on its document.
    await userEvent.click(within(canvasElement).getByLabelText("Count"));
    expect(frame).toHaveFocus();
    await waitFor(() => expect(activeHistory.value).toMatchObject({ kind: "asset", path: FILE }));
  },
};

export const Problems: Story = {
  parameters: { editor: { files: { [FILE]: { n: "many" } } } satisfies EditorStoryParameters },
  args: { path: FILE, extra: ["The count is too high.", "The count isn't a number."] },
  play: async ({ canvasElement }) => {
    // The document's problems first, then the kind's, each once.
    const items = within(canvasElement).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["The count isn't a number.", "The count is too high."]);
  },
};

export const ReadOnly: Story = {
  parameters: { editor: { files: { [FILE]: { n: 1 } }, readOnly: true } satisfies EditorStoryParameters },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const notice = "story is read-only. Open a project folder (or copy the sample) to change clicks.counter.json.";
    expect(c.getByText(notice)).toBeVisible();
    // Undo and Redo are off, and say why.
    expect(c.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(c.getByRole("button", { name: "Undo" })).toHaveAttribute("title", notice);
    expect(c.getByRole("button", { name: "Redo" })).toHaveAttribute("title", notice);
  },
};
