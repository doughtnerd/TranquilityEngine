// Stories (ADR 0219, 0357 §4, §6) for the Playlists inspector's Caption field: pick a key from the captions table, set
// the repeat gap, and create a key the table doesn't have yet.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { PlaylistBody } from "../../../engine/audio/playlist/types";
import { PlaylistInspector } from "./PlaylistInspector";
import { FIXTURE_PARAMETERS, FIXTURE_PLAYLISTS } from "./playlistFixture";
import "../../components/audioParts.css";
import "./playlists.css";

function Demo() {
  const [body, setBody] = useState<PlaylistBody>(FIXTURE_PLAYLISTS["audio/vehicles/engine.playlist.json"]!);
  const [keys, setKeys] = useState(["cc.door_slams", "cc.engine_starts"]);
  return (
    <div style={{ width: "340px", height: "720px", overflow: "auto" }}>
      <PlaylistInspector
        body={body} selected={null} writable ctx={{ parameters: FIXTURE_PARAMETERS }} buses={["Master", "SFX"]} output={{ bus: "SFX", own: false, from: null }} presets={[]} usedBy={[]}
        onEdit={(_label, edit) => { const r = edit(body); if ("next" in r) setBody(r.next); }}
        onEditCurves={() => undefined} onOpenBus={() => undefined} onOpenPlaylist={() => undefined}
        captionKeys={keys} captionTable="strings/captions.strings.json" onCreateCaptionKey={(k) => setKeys([...keys, k])}
      />
      <p aria-label="Caption">{body.caption ? `${body.caption.key} / ${body.caption.minGap}` : "none"}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Playlists/Caption", component: PlaylistInspector };
export default meta;

export const Caption: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const key = c.getByRole("textbox", { name: "Caption key" });
    await userEvent.type(key, "cc.engine_starts{Enter}");
    await waitFor(() => expect(c.getByLabelText("Caption")).toHaveTextContent("cc.engine_starts / 0"));
    const gap = c.getByRole("textbox", { name: "Caption gap" });
    await userEvent.clear(gap);
    await userEvent.type(gap, "2{Enter}");
    await waitFor(() => expect(c.getByLabelText("Caption")).toHaveTextContent("cc.engine_starts / 2"));
    await userEvent.clear(key);
    await userEvent.type(key, "cc.engine_stalls{Enter}");
    await expect(c.getByText(/cc.engine_stalls isn't in strings\/captions.strings.json/)).toBeInTheDocument();
    await userEvent.click(c.getByRole("button", { name: "Create it" }));
    await waitFor(() => expect(c.queryByRole("button", { name: "Create it" })).toBeNull());
    await userEvent.clear(key);
    await userEvent.type(key, "{Enter}");
    await waitFor(() => expect(c.getByLabelText("Caption")).toHaveTextContent("none"));
  },
};
