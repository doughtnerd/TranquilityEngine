// Stories (ADR 0219, 0349) for the fader: horizontal and vertical, with a meter in its track, a VCA ghost tick, the
// keys (arrows 0.5 dB, 0 for unity), both ticks at once in snapshot mode (VCA and base level) and disabled while
// automated.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { Fader } from "./Fader";
import { formatDb } from "./faderModel";
import { Meter } from "./Meter";

function Demo(props: { orientation?: "horizontal" | "vertical"; start?: number; ghost?: number; base?: number; disabled?: boolean; meter?: boolean }) {
  const [db, setDb] = useState(props.start ?? -6);
  const [drags, setDrags] = useState(0);
  return (
    <div style={{ display: "flex", gap: "16px", alignItems: "center", height: props.orientation === "vertical" ? "180px" : undefined, width: props.orientation === "vertical" ? undefined : "320px" }}>
      <Fader
        label="SFX level"
        orientation={props.orientation}
        value={db}
        ghostDb={props.ghost != null ? db + props.ghost : null}
        ghostTitle={props.ghost != null ? `With VCAs: ${formatDb(db + props.ghost)} dB` : undefined}
        ghosts={props.base != null ? [{ kind: "base", db: props.base, title: `Base level: ${formatDb(props.base)} dB` }] : undefined}
        disabled={props.disabled}
        title={props.disabled ? "Automated by threat" : undefined}
        onValue={(v, drag) => {
          setDb(v);
          if (!drag) setDrags((n) => n + 1);
        }}
      >
        {props.meter && <Meter label="SFX meter" orientation={props.orientation === "vertical" ? "vertical" : "horizontal"} peakDb={db - 4} rmsDb={db - 10} now={0} />}
      </Fader>
      <span data-testid="readout">{formatDb(db)} dB</span>
      <span data-testid="steps">{drags} steps</span>
    </div>
  );
}

const meta: Meta = { title: "Studio/Fader", component: Fader };
export default meta;

export const Horizontal: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const fader = c.getByRole("slider", { name: "SFX level" });
    fader.focus();
    await userEvent.keyboard("{ArrowUp}");
    await expect(c.getByTestId("readout")).toHaveTextContent("−5.5 dB");
    await userEvent.keyboard("0");
    await expect(c.getByTestId("readout")).toHaveTextContent("0.0 dB");
    await userEvent.keyboard("{End}");
    await expect(fader).toHaveAttribute("aria-valuetext", "−∞ dB");
  },
};

export const Vertical: StoryObj = { render: () => <Demo orientation="vertical" meter /> };

export const WithMeter: StoryObj = { render: () => <Demo meter start={-3} /> };

export const VcaGhost: StoryObj = { render: () => <Demo ghost={-4} /> };

/** Editing a snapshot: the base level's tick and the VCA tick together. */
export const SnapshotWithVca: StoryObj = {
  render: () => <Demo start={-12} ghost={-4} base={-3} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".studio-fader-ghost").length).toBe(2);
    await expect(canvasElement.querySelector(".studio-fader-ghost.base")).toHaveAttribute("title", "Base level: −3.0 dB");
  },
};

export const DoubleClickForUnity: StoryObj = {
  render: () => <Demo start={-18} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.dblClick(c.getByRole("slider", { name: "SFX level" }));
    await expect(c.getByTestId("readout")).toHaveTextContent("0.0 dB");
  },
};

export const Automated: StoryObj = { render: () => <Demo disabled /> };
