// Stories (ADR 0219, 0335) for the filmstrip (ADR 0334): a take's pictures across a 480 px axis of 12 s, thinned so
// none overlap, the one at the playhead marked; a click seeks there.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import type { TakeFrame } from "../../engine/audio/take/types";
import { Filmstrip } from "./Filmstrip";

/** A tiny valid JPEG-ish payload: the browser draws a broken image, which is enough to see the layout. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const FRAMES: TakeFrame[] = Array.from({ length: 12 }, (_, t) => ({ t, width: 320, height: 180, jpeg: JPEG }));

function Harness() {
  const [time, setTime] = useState(3.5);
  return (
    <div style={{ width: "480px", height: "40px", position: "relative" }}>
      <Filmstrip frames={FRAMES} toX={(t) => (t / 12) * 480} time={time} onSeek={setTime} />
    </div>
  );
}

const meta: Meta = { title: "Studio/Filmstrip", component: Harness };
export default meta;

export const Pictures: StoryObj = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { current: true })).toHaveAccessibleName("Picture at 3.000 s");
    await userEvent.click(c.getAllByRole("button")[0]!);
    await expect(c.getByRole("button", { current: true })).toHaveAccessibleName("Picture at 0.000 s");
  },
};
