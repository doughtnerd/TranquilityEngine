// Stories (ADR 0219, 0349) for the Generator editor (ADR 0360 §9): a blip (presets, Randomise, Mutate, seed, vary,
// locks, the preview, the keyboard), a synth whose kind switch asks first, and an embedded oscillator that can't
// audition here. Each `play` drives the view and checks what it reports.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useEffect, useState } from "preact/hooks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { applyBlipPreset } from "../../../../engine/audio/generators/blipPresets";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import { applySynthPreset } from "../../../../engine/audio/generators/synthPresets";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import { BAKE_PENDING } from "./bakeModel";
import { GeneratorEditor, type GeneratorEditorProps } from "./GeneratorEditor";
import { toggleLock } from "./generatorModel";
import { pictureOf, type PreviewPicture } from "./previewClient";
import "../playlists.css";

const meta = { title: "Studio/Playlists/Generator editor" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The editor over local state, as the screen drives it: edits apply, locks toggle, the gate holds. */
function Live(props: { initial: GeneratorBody; title: string; where: string; audition?: GeneratorEditorProps["audition"]; onEdit?: (label: string) => void; onGate?: (what: string) => void }) {
  const [body, setBody] = useState(props.initial);
  const [locks, setLocks] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<ReadonlyMap<string, number>>(new Map());
  // The preview follows the patch as the screen's does (the offline render, off the story's first paint).
  const [picture, setPicture] = useState<PreviewPicture | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    pictureOf(body).then(
      (p) => live && (setPicture(p), setPreviewError(null)),
      (err: unknown) => live && setPreviewError(err instanceof Error ? err.message : String(err)),
    );
    return () => void (live = false);
  }, [body]);
  return (
    <div style={{ width: "900px", height: "760px", overflow: "auto" }}>
      <GeneratorEditor
        body={body}
        title={props.title}
        where={props.where}
        writable
        locks={locks}
        preview={picture}
        previewError={previewError}
        audition={props.audition ?? { available: true, reason: null, held }}
        bake={{ enabled: false, reason: BAKE_PENDING }}
        onEdit={(label, edit) => {
          props.onEdit?.(label);
          const r = edit(body);
          if ("next" in r) setBody(r.next);
        }}
        onToggleLock={(name) => setLocks(toggleLock(locks, name))}
        onGatePress={(source, st) => {
          props.onGate?.(`press ${source} ${st}`);
          setHeld(new Map(held).set(source, st));
        }}
        onGateRelease={(source) => {
          props.onGate?.(`release ${source}`);
          const next = new Map(held);
          next.delete(source);
          setHeld(next);
        }}
        onBake={fn()}
      />
    </div>
  );
}

const blipEdits = fn();
const blipGate = fn();
export const Blip: Story = {
  render: () => <Live initial={applyBlipPreset({ ...emptyGeneratorBody("blip"), seed: 1734 }, "coin", 1734)} title="coin" where="audio/ui/coin.generator.json" onEdit={blipEdits} onGate={blipGate} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("combobox", { name: "Preset" })).toHaveValue("coin");
    await expect(c.getByRole("textbox", { name: "Seed" })).toHaveValue("1734");
    // sfxr's groups, generated from the catalogue, with real-unit readouts.
    await expect(c.getByRole("group", { name: "Frequency" })).toBeVisible();
    await expect(c.getByRole("group", { name: "Arpeggiation" })).toBeVisible();
    // Lock the frequency, then Randomise: one edit, a new seed, the frequency kept.
    const freqBox = c.getByRole("textbox", { name: "Frequency value" }) as HTMLInputElement;
    const before = freqBox.value;
    await userEvent.click(c.getByRole("button", { name: "Lock Frequency" }));
    await expect(c.getByRole("button", { name: "Lock Frequency" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Randomise" }));
    await expect(blipEdits).toHaveBeenLastCalledWith("Randomise");
    await waitFor(() => expect(c.getByRole("textbox", { name: "Seed" })).not.toHaveValue("1734"));
    await expect((c.getByRole("textbox", { name: "Frequency value" }) as HTMLInputElement).value).toBe(before);
    await userEvent.click(c.getByRole("button", { name: "Mutate" }));
    await expect(blipEdits).toHaveBeenLastCalledWith("Mutate");
    // The keyboard gates a note while held.
    const key = c.getByRole("button", { name: /^G \(\+7 st/ });
    await userEvent.pointer({ keys: "[MouseLeft>]", target: key });
    await expect(blipGate).toHaveBeenLastCalledWith("press note:7 7");
    await userEvent.pointer({ keys: "[/MouseLeft]", target: key });
    await expect(blipGate).toHaveBeenLastCalledWith("release note:7");
    await expect(c.getByRole("button", { name: "Bake…" })).toBeDisabled();
    await expect(c.getByRole("button", { name: "Bake…" })).toHaveAttribute("title", BAKE_PENDING);
  },
};

const synthEdits = fn();
export const SynthKindSwitch: Story = {
  render: () => <Live initial={applySynthPreset(emptyGeneratorBody("synth"), "pad")} title="pad" where="audio/ambience/pad.generator.json" onEdit={synthEdits} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await expect(c.getByRole("group", { name: "LFO" })).toBeVisible();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Kind" }), "silence");
    const ask = await body.findByRole("alertdialog", { name: "Switch to Silence?" });
    await expect(within(ask).getByText(/Silence has no .* lost/)).toBeVisible();
    await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await expect(synthEdits).not.toHaveBeenCalled();
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Kind" }), "silence");
    await userEvent.click(within(await body.findByRole("alertdialog")).getByRole("button", { name: "Switch" }));
    await expect(synthEdits).toHaveBeenLastCalledWith("Switch to Silence");
    await waitFor(() => expect(c.getByRole("group", { name: "Length" })).toBeVisible());
  },
};

export const EmbeddedOscillator: Story = {
  render: () => (
    <Live
      initial={{ ...emptyGeneratorBody("oscillator"), params: { ...emptyGeneratorBody("oscillator").params, length: 0.4, release: 120 } }}
      title="Oscillator generator"
      where="Embedded in ui › entries[2]"
      audition={{ available: false, reason: "A generator embedded in another playlist plays with it: trigger that playlist, or Make shared to audition it here.", held: new Map() }}
    />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("button", { name: "▶ Hold to play" })).toBeDisabled();
    await expect(c.queryByRole("button", { name: "Randomise" })).toBeNull();
    await expect(c.queryByRole("button", { name: /^Lock / })).toBeNull();
    await expect(c.getByRole("combobox", { name: "Waveform" })).toHaveValue("0");
    await expect(c.getByText(/key-off at 0\.40 s/)).toBeVisible();
  },
};
