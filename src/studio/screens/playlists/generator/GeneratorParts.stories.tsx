// Stories (ADR 0219, 0349) for the Generator editor's parts and neighbours (ADR 0360 §9): the kind badges, the
// keyboard, the preview (rendered, rendering, failed), the Bake dialog (off with no project, and on), the Library's
// generators with the New menu, and a baked sample's provenance (out of date with Rebake, and read-only).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import { GENERATOR_KINDS } from "../../../../engine/audio/generators/types";
import { BakeDialog } from "./BakeDialog";
import { NO_PROJECT, defaultBakeOptions } from "./bakeModel";
import { GeneratedProvenance } from "./GeneratedProvenance";
import { GeneratorLibrary } from "./GeneratorLibrary";
import { GeneratorBadge, GeneratorKeyboard, GeneratorPreview } from "./GeneratorParts";
import { pictureOf, type PreviewPicture } from "./previewClient";
import "../../../components/audioParts.css";
import "../playlists.css";

const meta = { title: "Studio/Playlists/Generator parts" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Badges: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "8px" }}>
      {GENERATOR_KINDS.map((k) => <GeneratorBadge key={k} kind={k} />)}
      <GeneratorBadge kind={null} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("img", { name: "Oscillator generator" })).toHaveTextContent("OSC");
    await expect(c.getByRole("img", { name: "Silence generator" })).toHaveTextContent("SIL");
    await expect(c.getByRole("img", { name: "Generator (unreadable)" })).toHaveTextContent("GEN");
  },
};

const press = fn();
const release = fn();
export const Keyboard: Story = {
  render: () => <GeneratorKeyboard hz={440} held={[4]} onPress={press} onRelease={release} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getAllByRole("button")).toHaveLength(13);
    await expect(c.getByRole("button", { name: /^E \(\+4 st/ })).toHaveAttribute("aria-pressed", "true");
    const top = c.getByRole("button", { name: "C′ (+12 st · 880 Hz)" });
    // One session for the press and the release (each direct userEvent call starts a new one, with no button held).
    const user = userEvent.setup();
    await user.pointer({ keys: "[MouseLeft>]", target: top });
    await expect(press).toHaveBeenCalledWith("note:12", 12);
    await user.pointer({ keys: "[/MouseLeft]", target: top });
    await expect(release).toHaveBeenCalledWith("note:12");
  },
};

export const Preview: Story = {
  // The pictures are the offline render's (the wasm loads first).
  loaders: [
    async () => ({
      laser: await pictureOf(applyBlipPreset(emptyGeneratorBody("blip"), "laser", 9)),
      saw: await pictureOf({ ...emptyGeneratorBody("oscillator"), params: { ...emptyGeneratorBody("oscillator").params, waveform: 2, frequency: 110 } }),
    }),
  ],
  render: (_args, { loaded }) => (
    <div style={{ width: "640px" }}>
      <GeneratorPreview picture={(loaded as { laser: PreviewPicture }).laser} />
      <GeneratorPreview picture={(loaded as { saw: PreviewPicture }).saw} />
      <GeneratorPreview picture={null} />
      <GeneratorPreview picture={null} error="the offline module couldn't load" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(/^Whole sound: \d\.\d\d s$/)).toBeVisible();
    await expect(c.getByText("First 2.00 s (it plays until released)")).toBeVisible();
    await expect(c.getAllByText("Rendering the preview…").length).toBeGreaterThan(0);
    await expect(c.getByText("No preview: the offline module couldn't load")).toBeVisible();
  },
};

export const BakeNoProject: Story = {
  render: () => <BakeDialog name="coin" initial={defaultBakeOptions("audio/ui/coin.generator.json", false)} availability={{ enabled: false, reason: NO_PROJECT }} onBake={fn()} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Bake coin" });
    await expect(within(dialog).getByRole("button", { name: "Bake" })).toBeDisabled();
    await expect(within(dialog).getByRole("note")).toHaveTextContent(NO_PROJECT);
    await expect(within(dialog).getByLabelText("Folder")).toHaveValue("audio/ui");
  },
};

const bakeNow = fn();
export const BakeReady: Story = {
  render: () => <BakeDialog name="hum" initial={defaultBakeOptions("audio/hum.generator.json", true)} availability={{ enabled: true, reason: null }} onBake={bakeNow} onClose={fn()} />,
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Bake hum" }));
    const variations = dialog.getByLabelText("Variations");
    await userEvent.clear(variations);
    await userEvent.type(variations, "4");
    await userEvent.tab();
    await userEvent.click(dialog.getByLabelText(/Make a Queue playlist/));
    await userEvent.click(dialog.getByRole("button", { name: "Bake" }));
    await expect(bakeNow).toHaveBeenCalledWith({ length: 2, variations: 4, folder: "audio", queue: true, replaceUses: false });
  },
};

const openGen = fn();
const newGen = fn();
export const Library: Story = {
  render: () => (
    <div style={{ width: "280px" }}>
      <GeneratorLibrary
        rows={[
          { path: "audio/ui/coin.generator.json", name: "coin", kind: "blip", preset: "coin" },
          { path: "audio/ambience/hum.generator.json", name: "hum", kind: "oscillator", preset: null },
          { path: "audio/broken.generator.json", name: "broken", kind: null, preset: null },
        ]}
        open="audio/ui/coin.generator.json"
        addTo="ui_sounds"
        writable
        searching={false}
        onOpen={openGen}
        onAdd={fn()}
        onNew={newGen}
        onNewEmbedded={fn()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // The row names the generator (its preset is named too).
    await expect(c.getAllByText("coin")[0]!.closest("[role=listitem]")).toHaveAttribute("aria-current", "true");
    await userEvent.click(c.getByText("hum"));
    await expect(openGen).toHaveBeenCalledWith("audio/ambience/hum.generator.json");
    await userEvent.click(c.getByRole("button", { name: "New generator" }));
    const menu = within(canvasElement.ownerDocument.body);
    await userEvent.click(await menu.findByRole("menuitem", { name: "New synth generator" }));
    await expect(newGen).toHaveBeenCalledWith("synth");
  },
};

const rebakeNow = fn();
export const ProvenanceOutOfDate: Story = {
  render: () => (
    <GeneratedProvenance
      view={{ generator: "audio/ui/coin.generator.json", name: "coin.generator.json", state: "outOfDate", text: "Baked from coin.generator.json", note: "out of date", rebake: { enabled: true, reason: null } }}
      onOpenGenerator={fn()}
      onRebake={rebakeNow}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Baked from coin.generator.json" })).toBeEnabled();
    await expect(c.getByText("out of date")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Rebake" }));
    await expect(rebakeNow).toHaveBeenCalledWith("audio/ui/coin.generator.json");
  },
};

export const ProvenanceReadOnly: Story = {
  render: () => (
    <GeneratedProvenance
      view={{ generator: "audio/ui/coin.generator.json", name: "coin.generator.json", state: "outOfDate", text: "Baked from coin.generator.json", note: "out of date", rebake: { enabled: false, reason: "This project is read-only." } }}
      onOpenGenerator={fn()}
      onRebake={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "Rebake" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Rebake" })).toHaveAttribute("title", "This project is read-only.");
  },
};
