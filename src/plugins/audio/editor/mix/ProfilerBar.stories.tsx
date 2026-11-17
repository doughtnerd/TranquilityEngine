// Stories (ADR 0219) for the Profiler's bar slot (Pf8): idle, opening (Cancel and a progress bar that follows the
// open's reports), saving, a failed flow, and the legend. Rendered through its real props, a view and a real
// `ProfilerController` over stub deps, with the shared `profilerFlow`. Plays check a label on every control, Cancel
// cancelling the flow and the open, Open clicking the file input, and a chosen file going through X2's
// `profilerSlots.onDropFile`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, spyOn, userEvent, waitFor, within } from "storybook/test";
import type { AudioCapture } from "../../runtime/capture/capture";
import { ProfilerBar } from "./ProfilerBar";
import { ProfilerController, profilerSlots, type ProfilerDeps, type ProfilerView } from "./ProfilerPanel";
import { KEY_BINDINGS } from "./profilerKeys";
import { profilerFlow } from "./openSaveFlow";

const idleCapture: AudioCapture = { state: "idle", seconds: 0, bytes: 0, truncated: false, start: async () => {}, stop() {}, mark() {}, save: async () => "x" } as unknown as AudioCapture;
const deps: ProfilerDeps = {
  capture: idleCapture,
  openCapture: () => Promise.reject(new Error("unused")),
  projectAudio: () => undefined,
  liveHost: null,
  trackFactories: [],
  playing: () => false,
};
const controller = new ProfilerController(deps);

type Args = { view: ProfilerView; controller: ProfilerController };

const meta = {
  title: "Audio/Profiler/Bar",
  component: ProfilerBar,
  args: { view: controller.view, controller },
  beforeEach: () => () => profilerFlow.reset(),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const CONTROLS = new Set(["BUTTON", "INPUT", "PROGRESS", "CANVAS", "SELECT", "TEXTAREA"]);
const REGIONS = new Set(["toolbar", "region", "status", "alert"]);

/** Every control, list and landmark in the bar has an aria-label. */
function expectLabels(root: HTMLElement): void {
  const els = [...root.querySelectorAll<HTMLElement>("*")];
  expect(els.length).toBeGreaterThan(8);
  for (const e of els) {
    const role = e.getAttribute("role");
    if (CONTROLS.has(e.tagName) || (role && REGIONS.has(role)) || e.tagName === "UL" || e.tagName === "KBD") {
      expect(e.getAttribute("aria-label"), `${e.tagName} ${role ?? ""}`).toBeTruthy();
    }
  }
}
const action = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);

export const Idle: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    expectLabels(canvasElement);
    await step("the toolbar carries a label and its buttons name their action", async () => {
      const labels = Object.fromEntries([...canvasElement.querySelectorAll("button")].map((b) => [b.dataset.action, b.getAttribute("aria-label")]));
      expect(labels).toEqual({ record: "Record a capture", stop: "Stop recording", save: "Save the capture", open: "Open a capture file" });
      expect(canvas.getByRole("toolbar")).toHaveAttribute("aria-label", "Capture");
    });
    await step("no Cancel and no progress bar while idle", async () => {
      expect(action(canvasElement, "cancel")).toBeNull();
      expect(canvasElement.querySelector("progress")).toBeNull();
    });
    await step("the legend lists every key with its label", async () => {
      const items = [...canvasElement.querySelectorAll("li")].map((li) => li.dataset.key);
      expect(items).toEqual(KEY_BINDINGS.map((b) => b.id));
    });
    await step("Open clicks the file input", async () => {
      const input = canvas.getByLabelText("Choose a capture file") as HTMLInputElement;
      const click = spyOn(input, "click").mockImplementation(() => {});
      expect(action(canvasElement, "open")).toBeEnabled();
      await userEvent.click(action(canvasElement, "open")!);
      expect(click).toHaveBeenCalledTimes(1);
      click.mockRestore();
    });
  },
};

export const ChooseFile: Story = {
  beforeEach: () => {
    const original = profilerSlots.onDropFile;
    return () => void (profilerSlots.onDropFile = original);
  },
  play: async ({ canvasElement }) => {
    const seen: string[] = [];
    profilerSlots.onDropFile = (_c, f) => void seen.push(f.name);
    profilerFlow.begin("save");
    profilerFlow.fail();
    const input = within(canvasElement).getByLabelText("Choose a capture file") as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array(4)], "a.mycap"));
    // A chosen file clears the input, resets the last outcome and goes through profilerSlots.onDropFile (X2's route).
    expect(input.value).toBe("");
    expect(seen).toEqual(["a.mycap"]);
    expect(profilerFlow.state.phase).toBe("idle");
    // A change with no file chosen routes nothing.
    await fireEvent.change(input);
    expect(input.files).toHaveLength(0);
    expect(seen).toEqual(["a.mycap"]);
  },
};

export const Opening: Story = {
  args: { view: { ...controller.view, busy: "opening", fileName: "a.mycap" } },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    expectLabels(canvasElement);
    await step("an open shows Cancel and a labelled progress bar that follows the reports", async () => {
      expect(action(canvasElement, "cancel")).not.toBeNull();
      profilerFlow.progress("inflate", 1, 2); // half of the first half
      await waitFor(() => expect(canvasElement.querySelector("progress")!.value).toBe(0.25));
      expect(canvasElement.querySelector("progress")).toHaveAttribute("aria-label", "Open progress");
      expect(canvas.getByRole("status")).toHaveTextContent("Unpacking a.mycap 25%");
    });
    await step("Open, Record and Save are off while busy", async () => {
      expect(action(canvasElement, "open")).toBeDisabled();
      expect(action(canvasElement, "record")).toBeDisabled();
      expect(action(canvasElement, "save")).toBeDisabled();
    });
    await step("Cancel cancels the flow and the open", async () => {
      const cancelOpen = spyOn(controller, "cancelOpen");
      expect(profilerFlow.state.phase).toBe("running");
      await userEvent.click(action(canvasElement, "cancel")!);
      expect(cancelOpen).toHaveBeenCalledTimes(1);
      expect(profilerFlow.state.phase).toBe("cancelled");
      cancelOpen.mockRestore();
    });
  },
};

export const OpeningBeforeFirstReport: Story = {
  args: { view: { ...controller.view, busy: "opening" } },
  play: async ({ canvasElement }) => {
    // An open before its first report is an indeterminate bar (no value).
    expect(canvasElement.querySelector("progress")!.hasAttribute("value")).toBe(false);
  },
};

export const Saving: Story = {
  args: { view: { ...controller.view, busy: "saving" } },
  play: async ({ canvasElement }) => {
    expectLabels(canvasElement);
    const p = canvasElement.querySelector("progress")!;
    expect(p).toHaveAttribute("aria-label", "Save progress");
    expect(p.hasAttribute("value")).toBe(false);
    expect(action(canvasElement, "cancel")).toBeNull();
  },
};

export const FlowError: Story = {
  args: { view: { ...controller.view, flowError: "disk full" } },
  play: async ({ canvasElement }) => {
    // The status line shows the flow's text in a polite live region.
    const s = canvasElement.querySelector('[aria-live="polite"]')!;
    expect(s).toHaveTextContent("disk full");
    expect(s).toHaveAttribute("data-severity", "error");
  },
};
