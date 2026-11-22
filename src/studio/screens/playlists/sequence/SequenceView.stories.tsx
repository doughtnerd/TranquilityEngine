// Stories (ADR 0219, 0335) for the Sequence view: the fixture Brake sequence (a skid with a parameter-bound loop
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
    await expect(c.getByText("⚠ follows")).toBeVisible();
    await expect(c.getByRole("button", { name: "Marker Drop" })).toBeVisible();
    await expect(c.getByRole("button", { name: /Hold point at 1\.60/ })).toBeVisible();
  },
};

export const AddTrackAndLoop: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "+ Track ▾" }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("menuitem", { name: /Playlist track/ }));
    await expect(c.getByText("Playlist 2")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "+ Loop" }));
    await expect(c.getByRole("button", { name: /Loop 0\.00–2\.00 s/ })).toBeVisible();
  },
};

export const WithInspector: Story = {
  args: { inspector: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Clip brake_skid" }));
    await expect(c.getByText("Override")).toBeVisible();
    await expect(c.getByRole("button", { name: "Use sample loop settings" })).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Use sample loop settings" }));
    await expect(c.getByText("Inherited")).toBeVisible();
  },
};

export const FollowsAndMakeAsync: Story = {
  args: { inspector: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getAllByRole("button", { name: "Clip music_loop" })[1]!);
    await userEvent.click(c.getByRole("button", { name: "Make Async" }));
    await expect(c.queryByText("⚠ follows")).toBeNull();
  },
};

export const Empty: Story = {
  args: { body: fixtureBody({ length: 0, tempo: null, tracks: [], loops: [], markers: [] }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/Drop a sample from the Library here/)).toBeVisible();
  },
};

export const NoTempo: Story = {
  args: { body: fixtureBody({ ...fixtureSequence(), tempo: null }) },
};

export const ReadOnly: Story = {
  args: { writable: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "+ Loop" })).toBeDisabled();
  },
};
