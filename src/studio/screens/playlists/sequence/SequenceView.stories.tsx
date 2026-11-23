// Stories (ADR 0219, 0349) for the Sequence view: the fixture Brake sequence (a skid with a parameter-bound loop
// override and a volume envelope, a hold point, overlapping sync music clips with the "follows" warning, a playlist
// track, markers of each type), an empty sequence, one without a tempo, and the Inspector beside the timeline. Each
// story applies its edits locally so every gesture works.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { lintPlaylist } from "../../../../engine/audio/playlist/lint";
import type { PlaylistBody } from "../../../../engine/audio/playlist/types";
import { storyPeaks } from "../../../components/storyPeaks";
import { fixtureBody, fixtureSequence, fixtureSource, FIXTURE_SELF, loadFixturePlaylist } from "./sequenceFixture";
import { SequenceInspector } from "./SequenceInspector";
import { SequenceView } from "./SequenceView";
import "../../../components/audioParts.css";
import "../playlists.css";
import "./sequence.css";

const PEAKS = storyPeaks(4);
const PARAMETERS: readonly ParameterDef[] = [{ name: "brake", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "speed", min: 0, max: 200, default: 0, seekSpeed: 0 }];

function Harness(props: { readonly body: PlaylistBody; readonly inspector?: boolean; readonly writable?: boolean; readonly notify?: (text: string) => void }) {
  const [body, setBody] = useState<PlaylistBody>(props.body);
  const [toast, setToast] = useState<string | null>(null);
  const onEdit = (_label: string, edit: (b: PlaylistBody) => { next: PlaylistBody } | { refused: string }) => {
    const r = edit(body);
    if ("next" in r) setBody(r.next);
  };
  const notify = (text: string) => {
    setToast(text);
    props.notify?.(text);
  };
  const lints = lintPlaylist(body);
  return (
    <div style={{ display: "flex", gap: "8px", height: "560px", width: props.inspector ? "1240px" : "960px" }}>
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}>
        <SequenceView
          body={body}
          writable={props.writable ?? true}
          file={FIXTURE_SELF}
          stateKey={`story:${FIXTURE_SELF}`}
          title="brake"
          where=""
          lints={lints}
          sourceOf={fixtureSource}
          peaksOf={() => PEAKS}
          loadPlaylist={loadFixturePlaylist}
          parameters={PARAMETERS}
          buses={["Master", "SFX", "Music", "Vehicles"]}
          back={{ name: "vehicles", open: fn() }}
          onEdit={onEdit}
          onNotify={notify}
        />
        {toast && <p role="status" class="pl-note">{toast}</p>}
      </div>
      {props.inspector && (
        <div style={{ width: "280px", overflow: "auto", border: "1px solid var(--border)" }}>
          <SequenceInspector body={body} writable title="brake" where="" lints={lints} sourceOf={fixtureSource} buses={["Master", "SFX", "Music"]} parameters={PARAMETERS} onEdit={onEdit} onNotify={notify}>
            <p class="pl-note">(The playlist's own Inspector: playback rules, output, effects.)</p>
          </SequenceInspector>
        </div>
      )}
    </div>
  );
}

const meta = { title: "Studio/Playlists/Sequence", component: Harness, args: { body: fixtureBody() } } satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Brake: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("toolbar", { name: "Sequence tools" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Clip brake_skid" })).toBeVisible();
    await expect(c.getByText("P brake > 0.10")).toBeVisible();
    // Music B overlaps Music on a parallel track: both are Sync to the sequence clock, so neither follows (decision 4).
    await expect(c.queryByText("follows")).toBeNull();
    await expect(c.getByRole("button", { name: "Marker Drop" })).toBeVisible();
    await expect(c.getByRole("button", { name: /Hold 1 at 1\.60/ })).toBeVisible();
  },
};

export const AddTrackAndLoop: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add track" }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: /Playlist track/ }));
    await expect(c.getByText("Playlist 2")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Add loop" }));
    await expect(c.getByRole("button", { name: /Loop 1 0\.00–2\.00 s/ })).toBeVisible();
  },
};

export const WithInspector: Story = {
  args: { inspector: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Clip brake_skid" }));
    await expect(c.getAllByText("Override")[0]!).toBeVisible();
    await expect(c.getByRole("button", { name: "Use the sample's settings" })).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Use the sample's settings" }));
    await expect(c.getAllByText("Inherited")[0]!).toBeVisible();
  },
};

/** A Sync clip chained over the end of another on its own track (Music B's clip moved onto Music): the only case that follows (decision 4). */
const chained = (() => {
  const s = fixtureSequence();
  const [skid, music, musicB, stingers] = s.tracks;
  return fixtureBody({ ...s, tracks: [skid!, { ...music!, clips: [...music!.clips, { ...musicB!.clips[0]!, at: 4, length: 2 }] }, stingers!] });
})();

export const FollowsAndMakeAsync: Story = {
  args: { inspector: true, body: chained },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("follows")).toBeVisible();
    await userEvent.click(c.getAllByRole("button", { name: "Clip music_loop" })[1]!);
    await expect(await c.findByText(/Follows Music · music_loop/)).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Make Async" }));
    await expect(c.queryByText("⚠ follows")).toBeNull();
  },
};

/** W-7: the skid's volume envelope ends on a key at the clip's right edge; dragging that edge still sets the length. */
export const TrimEndOverCurveKey: Story = {
  args: { inspector: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const clip = c.getByRole("button", { name: "Clip brake_skid" });
    const box = clip.getBoundingClientRect();
    const end = clip.querySelectorAll(".sq-key")[3]!.getBoundingClientRect(); // [3, -24] at the clip's end
    const x = box.right - 3, y = end.top + end.height / 2;
    const target = canvasElement.ownerDocument.elementFromPoint(x, y)!;
    await expect(target).toHaveClass("sq-edge");
    const at = (dx: number) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x + dx, clientY: y });
    target.dispatchEvent(new PointerEvent("pointerdown", at(0)));
    target.dispatchEvent(new PointerEvent("pointermove", at(-40)));
    target.dispatchEvent(new PointerEvent("pointerup", at(-40)));
    await userEvent.click(clip);
    const length = (await c.findByLabelText("Clip length")) as HTMLInputElement;
    await expect(length.value).not.toBe("00:03.000");
  },
};

export const Empty: Story = {
  args: { body: fixtureBody({ length: 0, tempo: null, tracks: [], loops: [], markers: [] }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No tracks/)).toBeVisible();
  },
};

export const NoTempo: Story = {
  args: { body: fixtureBody({ ...fixtureSequence(), tempo: null }) },
};

export const ReadOnly: Story = {
  args: { writable: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Add loop" })).toBeDisabled();
  },
};


/** Right-click on a clip opens the clip's menu, not the lane's under it (the lane's menu is for its empty space). */
export const ClipMenu: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.pointer({ keys: "[MouseRight]", target: c.getByRole("button", { name: "Clip brake_skid" }) });
    await expect(page.getByRole("menu", { name: "Clip" })).toBeVisible();
    await expect(page.queryByRole("menu", { name: "Lane" })).toBeNull();
    await expect(page.getByRole("menuitem", { name: /^Copy/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(page.queryByRole("menu", { name: "Clip" })).toBeNull();
  },
};

/** ADR 0362: an Amp envelope at Hold 0 keeps the Hold handle beside Attack's, so each one can be grabbed. */
const withEnvelope = (() => {
  const s = fixtureSequence();
  const [skid, ...rest] = s.tracks;
  const clips = skid!.clips.map((c, i) => (i === 0 ? { ...c, effects: [...c.effects, { id: "env1", type: "envelope" as const, on: true, params: { attack: 100, hold: 0, decay: 200, sustain: 60, release: 300 } }] } : c));
  return fixtureBody({ ...s, tracks: [{ ...skid!, clips }, ...rest] });
})();

export const EnvelopeHoldAtZero: Story = {
  args: { body: withEnvelope },
  play: async ({ canvasElement }) => {
    const handle = (name: string) => [...canvasElement.querySelectorAll<HTMLElement>(".sq-adsr-handle")].find((h) => h.title.startsWith(name))!;
    for (const name of ["Attack", "Hold"]) {
      const box = handle(name).getBoundingClientRect();
      // What a press at the handle's centre lands on: the handle itself.
      await expect(canvasElement.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(handle(name));
    }
  },
};
