import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, play } from "./fixtures";
import { menu } from "./menus";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";
import { mixDebug } from "./audioMix";

// Shared helpers of the M5c live-mixing e2e (ADR 0171 amended by 0172, 0173; task E3): `audio-mix-c.spec.ts`, the smoke spec's
// M5c case and the walker's M5c case. The Sound Lab opens read-only, so a live edit that must be kept after Stop needs a
// writable folder: this opens the editor's in-memory test project (the Flappy files) with a project.json whose audio section is
// a small mix, one scene of looping reference tones on chosen buses, and the Sound Lab's reference clips copied in as bytes.
// Timing is on the audio clock (`Audio.time`, the core's rendered frames); the polls only pace the reads.

/** The Sound Lab's clips (read from the repository: the in-memory project takes bytes through the test hook). */
const LAB_AUDIO = join(process.cwd(), "samples", "sound-lab", "audio");
const clip = (name: string): Uint8Array => new Uint8Array(readFileSync(join(LAB_AUDIO, name)));

/** A bus of the live-mix project: `volume` and `mute` default to 1 and false. */
export type MixBus = { name: string; parent?: string; volume?: number; mute?: boolean; meter?: "loudness"; effects?: object[] };

/** The steady tone every bus below plays: the reference sine (-23 dBFS peak, 1 kHz, stereo, looped without a seam). */
export const TONE = "audio/loudness-reference.wav";
/** The sine's linear peak (-23 dBFS), so a bus's peak at unity gain, before any bus gain, is this. */
export const TONE_PEAK = Math.pow(10, -23 / 20);

/** The project's buses: a tone on Music and on Aux, a compressor on SFX, a reverb send on Ambience, a metered UI bus. */
export const BUSES: MixBus[] = [
  { name: "Master" },
  { name: "Music", parent: "Master", volume: 0.6, effects: [{ type: "highpass", frequency: 40, q: 1 }, { type: "lowpass", frequency: 18000, q: 1 }] },
  { name: "SFX", parent: "Master", effects: [{ type: "compressor", threshold: -24, knee: 30, ratio: 8, attack: 0.003, release: 0.25 }] },
  { name: "Ambience", parent: "Master", volume: 0.8, effects: [{ type: "reverb", send: 0.5 }] },
  { name: "UI", parent: "Master", meter: "loudness" },
  { name: "Aux", parent: "Master" },
  { name: "Deep", parent: "Aux" },
];

export type LiveMixOptions = {
  buses?: MixBus[];
  /** Extra keys of the audio section (snapshots, ducking, ...). */
  audio?: Record<string, unknown>;
  /** Buses that carry a looping tone from the first frame (one AudioSource each). */
  tones?: { bus: string; volume?: number; playOnAwake?: boolean }[];
};

const withDefaults = (b: MixBus) => ({ volume: 1, mute: false, effects: [], ...b });

/** The project.json text: the Flappy project's own keys with this audio section and no autoloaded music. */
export function liveProject(o: LiveMixOptions = {}): string {
  const flappy = JSON.parse(readFileSync(join(process.cwd(), "samples", "flappy", "project.json"), "utf8")) as Record<string, unknown>;
  delete flappy.autoload;
  flappy.audio = {
    backend: "core",
    buses: (o.buses ?? BUSES).map(withDefaults),
    snapshots: [{ name: "Muffled", volumes: { Music: 0.3 }, lowpass: { Music: 800 } }, { name: "Quiet", volumes: { Music: 0.2, Aux: 0.5 }, lowpass: {} }],
    ducking: [],
    ...o.audio,
  };
  return JSON.stringify(flappy, null, 2);
}

/** The scene text: a camera and one tone node per entry of `tones` (named `Tone <bus>`). */
export function liveScene(o: LiveMixOptions = {}): string {
  const tones = o.tones ?? [{ bus: "Music" }];
  return JSON.stringify({
    format: "myco.scene@4",
    settings: { physics: "2d" },
    nodes: [
      { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 0, -10] } }, { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 10, backgroundColor: "#202428" } }] },
      ...tones.map((t, i) => ({
        id: `tone-${i}`,
        name: `Tone ${t.bus}`,
        transform: false,
        components: [{ type: "engine.AudioSource", data: { clip: `asset:${TONE}`, loop: true, volume: t.volume ?? 1, playOnAwake: t.playOnAwake ?? true, output: t.bus } }],
      })),
    ],
  });
}

type Hooks = { openTestProject?(extra: Record<string, unknown>): Promise<void>; testFolder?: { read(path: string): string | undefined }; engine?: { world: { time: { frameCount: number } } } };

/** Opens the live-mix project (see the header), in Edit mode. A large viewport so the Project and Mixer panels have room. */
export async function openLiveMix(page: Page, o: LiveMixOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/editor.html");
  await page.waitForFunction(() => typeof (window as unknown as Hooks).openTestProject === "function");
  const extra = { "project.json": liveProject(o), "scenes/main.scene.json": liveScene(o), [TONE]: clip("loudness-reference.wav"), "audio/loudness-hot.wav": clip("loudness-hot.wav") };
  await page.evaluate((files) => (window as unknown as Hooks).openTestProject!(files), extra);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

/** Starts Play and unlocks the audio context with a click; waits for the running core backend. */
export async function playLiveMix(page: Page): Promise<void> {
  await play(page);
  await page.mouse.click(480, 250);
  await expect.poll(async () => (await mixDebug(page))?.status, { timeout: 30_000 }).toBe("running");
  expect((await mixDebug(page))!.core.backend).toBe("core");
}

/** Stop: the toolbar's Stop button; waits for Play's button to come back. */
export async function stopPlay(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
}

/** `project.json` as the editor wrote it. */
export const savedProject = async (page: Page): Promise<{ audio?: { buses?: { name: string; volume: number; mute: boolean; parent?: string; effects?: { type: string; [k: string]: unknown }[] }[]; [k: string]: unknown } }> =>
  JSON.parse((await page.evaluate(() => (window as unknown as Hooks).testFolder!.read("project.json")))!);

/** Opens Window > Audio Mixer and waits for its strips. */
export async function openMixer(page: Page): Promise<void> {
  await menu(page, "Window", "Audio Mixer");
  await expect(page.getByRole("group", { name: "Channel strips" })).toBeVisible();
}

/** Shows Project Settings > Audio. */
export async function openAudioSettings(page: Page): Promise<void> {
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  await expect(page.locator(".panel.project").getByRole("group", { name: "Audio settings" })).toBeVisible();
}

export const strip = (page: Page, bus: string) => page.getByRole("group", { name: `${bus} strip`, exact: true });
export const fader = (page: Page, bus: string) => page.getByRole("slider", { name: `${bus} volume`, exact: true });
