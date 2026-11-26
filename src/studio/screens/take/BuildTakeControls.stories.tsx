// Stories (ADR 0219, plan U5) for the Take screen's Record from a build controls: ready to start, recording with a
// marker, stopped and ready to save, uploading (chunks received), saved, and a failure with Save again.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { BuildTakeControls, type BuildTakeControlsProps } from "./BuildTakeControls";
import type { BuildTakeState } from "./recordFromBuild";
import "./take.css";

const meta: Meta = { title: "Studio/Take/BuildTakeControls", component: BuildTakeControls };
export default meta;

const handlers = { onStart: fn(), onMark: fn(), onStop: fn(), onSave: fn(), onDismiss: fn() };

const view = (state: BuildTakeState, over: Partial<BuildTakeControlsProps> = {}) => (
  <div style={{ width: "280px" }}>
    <BuildTakeControls build="Canyon Run (desktop, 192.168.1.20)" state={state} whyNotSave={null} {...handlers} {...over} />
  </div>
);

export const Ready: StoryObj = {
  render: () => view({ kind: "idle" }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.queryByRole("button", { name: /Save/ })).toBeNull();
    await userEvent.click(c.getByRole("button", { name: "Start take" }));
    await expect(handlers.onStart).toHaveBeenCalled();
  },
};

export const Recording: StoryObj = {
  render: () => view({ kind: "recording", marks: 2 }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent("Recording on Canyon Run (desktop, 192.168.1.20) · 2 marks");
    await userEvent.type(c.getByRole("textbox", { name: "Marker text" }), "boss enters{Enter}");
    await expect(handlers.onMark).toHaveBeenCalledWith("boss enters");
    await expect(c.getByRole("textbox", { name: "Marker text" })).toHaveValue("");
    await userEvent.click(c.getByRole("button", { name: "Mark" }));
    await expect(handlers.onMark).toHaveBeenLastCalledWith("Mark");
    await userEvent.click(c.getByRole("button", { name: "Stop" }));
    await expect(handlers.onStop).toHaveBeenCalled();
  },
};

export const Stopped: StoryObj = {
  render: () => view({ kind: "stopped", seconds: 42.5 }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent("42.5 s");
    await userEvent.click(c.getByRole("button", { name: "Save into recordings/" }));
    await expect(handlers.onSave).toHaveBeenCalled();
  },
};

export const SaveBlocked: StoryObj = {
  render: () => view({ kind: "stopped", seconds: 12 }, { whyNotSave: "Flappy is read-only; open a project folder to import files" }),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Save into recordings/" })).toBeDisabled();
  },
};

export const Uploading: StoryObj = {
  render: () => view({ kind: "uploading", received: 37, chunks: 120, bytes: 37 * 65_000, total: 7_800_000 }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("status")).toHaveTextContent("Uploading the take · 37 of 120 chunks");
    await expect(c.getByRole("progressbar", { name: "Chunks received" })).toHaveAttribute("value", "37");
  },
};

export const Saved: StoryObj = {
  render: () => view({ kind: "saved", path: "recordings/canyon-run_2026-11-22_10-15-00.sporesample" }),
};

export const Failed: StoryObj = {
  render: () => view({ kind: "failed", message: "Couldn't save the take from Canyon Run: the upload ended at 1200 of 4000 bytes", canSave: true }),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("alert")).toHaveTextContent("the upload ended");
    await expect(c.getByRole("button", { name: "Save into recordings/" })).toBeEnabled();
    await userEvent.click(c.getByRole("button", { name: "Dismiss" }));
    await expect(handlers.onDismiss).toHaveBeenCalled();
  },
};
