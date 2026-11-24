// ADR 0355 §6, 0354 §10: takes record says (resolved arguments, options, pick and the generator's state), lines and
// language changes through the public `Audio.take`; replaying the recorded says against the same data, the World
// generator restarted from each say's recorded state (as the Studio's replay does), picks the same lines, and after a
// weight change only the says that picked the changed line differ.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Audio, Engine, SceneManager } from "../../../../myco";
import { parseLanguages } from "../../../../engine/localisation/languages";
import type { TakeRequest } from "../../../../engine/audio/take/types";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, type FakeBackend } from "../testing";
import { releaseCapture } from "../capture/capture";
import { defaultSaveEnv, type SaveEnv } from "../capture/save";
import { openTakeFile } from "../capture/takeFile";
import { reseedActiveWorld } from "../capture/takeSeed";
import { keyframeCodecForTests, statusBytes, type CaptureChunkControl } from "../capture/testSupport";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../capture/recorder", async (real) => (await import("../capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../capture/save", async (real) => (await import("../capture/testSupport")).captureSaveModule(await real(), chunk));

const RATE = 48_000;
const BLOCK = 768;
const KEYS = ["bark_a", "bark_b", "bark_c", "hello"];

function files(weights: Record<string, number> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "s.json": { format: "myco.scene@1", nodes: [] },
    "audio.json": { format: "myco.audio@1", localisation: { roots: ["vo"] } },
    "vo/all.lines.json": { format: "myco.lines@1", lines: KEYS.map((key) => ({ key, speaker: "Dog" })) },
    "vo/events.dialogue.json": {
      format: "myco.dialogue@1",
      events: [{
        name: "bark", arguments: [{ name: "mood", labels: ["Calm", "Angry"] }], avoidRepeat: 0,
        paths: [{ path: ["*"], lines: ["bark_a", "bark_b", "bark_c"].map((key) => ({ key, weight: weights[key] ?? 1 })) }],
      }],
    },
  };
  for (const k of KEYS) out[`vo/en/${k}.wav`] = "data:audio/wav;base64,AAAA";
  for (const k of KEYS) out[`vo/fr/${k}.wav`] = "data:audio/wav;base64,AAAA";
  return out;
}

let engine: Engine | null = null;

async function rig(assets: Record<string, unknown>) {
  endAudioSession();
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  fb.ready = true;
  setAudioBackend(fb);
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(assets));
  const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], useSystemLanguage: false, voice: "separate" }).languages;
  engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 42 }, languages } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  chunk.options = { ringBytes: 4 * 1024 * 1024, codec: keyframeCodecForTests() };
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const env: SaveEnv = {
    tauri: false,
    fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
    storageRoot: async () => "/data/app",
    download: (bytes, fileName) => void downloads.push({ bytes, fileName }),
    compress: defaultSaveEnv().compress,
    now: () => new Date(2026, 10, 22, 10, 15, 0),
  };
  chunk.saveEnv = env;
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  return { downloads, feed };
}

afterEach(() => {
  Audio.take.stop();
  releaseCapture();
  chunk.saveEnv = null;
  engine?.dispose();
  engine = null;
  endAudioSession();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

type Say = Extract<TakeRequest, { kind: "say" }>;

/** Re-issues the recorded says as the Studio's replay does: the generator restarted from each one's state, the recorded arguments. */
function replay(says: readonly Say[]): (string | null)[] {
  return says.map((s) => {
    if (s.random !== undefined) reseedActiveWorld(s.random);
    const h = Audio.say(s.event, { args: s.args, channel: s.options.channel });
    const key = h.state === "playing" ? h.key : null;
    Audio.dialogue.stop();
    return key;
  });
}

describe("takes record says, lines and languages; replay re-decides deterministically (ADR 0355 §6)", () => {
  it("records a scripted run and replays it to the same picks; a weight change marks only the says it changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { downloads, feed } = await rig(files());
    await Audio.take.start();
    feed(4);
    Audio.line("hello");
    await Audio.setLanguage("fr");
    const picked: string[] = [];
    for (let i = 0; i < 12; i++) {
      const h = Audio.say("bark", { args: { mood: i % 2 ? "Angry" : "Calm" }, channel: `c${i}` });
      picked.push(h.key);
      Audio.dialogue.stop();
    }
    feed(4);
    Audio.take.stop();
    await Audio.take.save("barks");
    const { take } = await openTakeFile(downloads[0]!.bytes);
    expect(take.requests.find((q) => q.kind === "line")).toMatchObject({ kind: "line", key: "hello", language: "en" });
    expect(take.requests.find((q) => q.kind === "language")).toMatchObject({ kind: "language", audio: "fr", subtitles: null });
    const says = take.requests.filter((q): q is Say => q.kind === "say");
    expect(says).toHaveLength(12);
    expect(says[1]).toMatchObject({ event: "bark", args: { mood: "Angry" }, options: { channel: "c1" }, state: "playing", picked: { key: picked[1], pathIndex: 0 } });
    expect(says.every((s) => typeof s.random === "number")).toBe(true);
    expect(new Set(picked).size).toBeGreaterThan(1); // the run really drew different lines
    const recorded = says.map((s) => (s.picked && "key" in s.picked ? s.picked.key : null));
    expect(recorded).toEqual(picked);

    // Replay against the same data, in a new session: identical picks.
    Audio.take.stop();
    releaseCapture();
    engine!.dispose();
    await rig(files());
    await Audio.setLanguage("fr");
    expect(replay(says)).toEqual(recorded);

    // Change one line's weight (bark_b can't be picked): the says that recorded bark_b, and only those, differ.
    engine!.dispose();
    await rig(files({ bark_b: 0 }));
    await Audio.setLanguage("fr");
    const again = replay(says);
    const differing = again.map((k, i) => (k !== recorded[i] ? i : -1)).filter((i) => i >= 0);
    expect(differing.length).toBeGreaterThan(0);
    expect(differing).toEqual(recorded.map((k, i) => (k === "bark_b" ? i : -1)).filter((i) => i >= 0));
  });
});
