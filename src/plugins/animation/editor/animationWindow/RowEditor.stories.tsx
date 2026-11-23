// Stories (ADR 0219) for the Animation window's row editors (ADR 0373): one selected key of an event, marker, audio or
// activation track. Each change hands the window a refused-or-next edit and its undo label; the story applies accepted
// ones to its own clip and shows refusals, as the window does through the clip's asset document. The rules are
// unit-tested (`animationWindowLogic.test.ts`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { RowEditor } from "./RowEditor";

const NONE = { nodePath: "", component: "", field: "" };
const CLIP: AnimSource = {
  ...emptyAnimSource(),
  duration: 1,
  tracks: [
    { kind: "event", target: NONE, keys: [{ time: 0.25, method: "footstep", args: ["L"], threshold: 0.5, always: false }] },
    { kind: "marker", keys: [{ time: 0, kind: "sync", name: "L" }] },
    { kind: "audio", target: NONE, keys: [{ time: 0.3, audio: "asset:sfx/step.playlist.json" }] },
    { kind: "activation", target: { nodePath: "Trail", component: "", field: "" }, keys: [{ time: 0.2, end: 0.6 }] },
  ],
};

function Host(props: { track: number }) {
  const [clip, setClip] = useState(CLIP);
  const [said, setSaid] = useState("");
  return (
    <div style={{ width: "720px" }}>
      <RowEditor
        clip={clip}
        track={props.track}
        index={0}
        onApply={(r, label) => {
          if ("refused" in r) return setSaid(`Can't ${label.toLowerCase()}: ${r.refused}`);
          setClip(r.next);
          setSaid(label);
        }}
      />
      <output aria-label="Last edit">{said}</output>
      <pre aria-label="Keys">{JSON.stringify((clip.tracks[props.track] as { keys: unknown }).keys)}</pre>
    </div>
  );
}

const meta = { title: "Animation/Animation Window/Row Editor", render: () => <Host track={0} /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A notify: method, JSON args (bad JSON is refused) and the state's end. */
export const EventKey: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const method = c.getByLabelText("Method");
    await userEvent.clear(method);
    await userEvent.type(method, "land{Enter}");
    method.blur();
    expect(c.getByLabelText("Keys")).toHaveTextContent('"method":"land"');
    const args = c.getByLabelText("Args (JSON)");
    await userEvent.clear(args);
    await userEvent.type(args, "{{nope");
    args.blur();
    expect(c.getByLabelText("Last edit")).toHaveTextContent("Can't set notify args: that isn't valid JSON");
  },
};

/** A marker's kind: one case per kind. */
export const MarkerKey: Story = {
  render: () => <Host track={1} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    for (const kind of ["exit", "hit", "cue", "sync"]) {
      await userEvent.selectOptions(c.getByLabelText("Kind"), kind);
      expect(c.getByLabelText("Keys")).toHaveTextContent(`"kind":"${kind}"`);
    }
  },
};

/** An audio key's asset and params (params must be an object). */
export const AudioKey: Story = {
  render: () => <Host track={2} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const params = c.getByLabelText("Params (JSON)");
    await userEvent.type(params, '{{"surface":2}');
    params.blur();
    expect(c.getByLabelText("Keys")).toHaveTextContent('"params":{"surface":2}');
  },
};

/** An activation span: an end before the start is refused. */
export const ActivationKey: Story = {
  render: () => <Host track={3} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const end = c.getByLabelText("To (s)");
    await userEvent.clear(end);
    await userEvent.type(end, "0.1");
    end.blur();
    expect(c.getByLabelText("Last edit")).toHaveTextContent("Can't set activation end: the span must end after it starts");
    await userEvent.click(c.getByRole("button", { name: "Delete key" }));
    expect(c.getByLabelText("Keys")).toHaveTextContent("[]");
  },
};
