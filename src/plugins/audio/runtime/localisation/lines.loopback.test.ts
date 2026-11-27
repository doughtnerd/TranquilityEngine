// ADR 0354 §2, §5 on the real wasm core (loopback): a localised line plays the current language's file. The English
// recording decodes to silence and the French one to a steady level, so what the core renders says which file it played.
import { afterEach, expect, it, vi } from "vitest";
import { Assets, Audio, Engine, SceneManager } from "../../../../myco";
import { parseLanguages } from "../../../../engine/localisation/languages";
import { closeLoopbackAudio, endAudioSession, loopbackAudio } from "../testing";

const RATE = 48_000;
const level = new Float32Array(2 * RATE).fill(0.5);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

it("a line heard in French renders the French file, in English the English one (loopback)", { timeout: 30_000 }, async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "audio.json": { format: "myco.audio@1", localisation: { roots: ["vo"] } },
    "vo/lines.lines.json": { format: "myco.lines@1", lines: [{ key: "hello", speaker: "Ava" }] },
    "vo/en/hello.wav": "data:,",
    "vo/fr/hello.wav": "data:,",
  }));
  const languages = parseLanguages({ list: [{ code: "en", name: "English" }, { code: "fr", name: "Français" }], useSystemLanguage: false, voice: "separate" }).languages;
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7 }, languages } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  const decoded: string[] = [];
  const loop = await loopbackAudio({
    mixer: "page", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: (path: string) => (decoded.push(path), { channelData: [path.includes("/fr/") ? level : new Float32Array(2 * RATE)] }),
    recovery: { now: () => 0, warn: () => {} },
  });
  expect(loop).not.toBeNull();
  if (!loop) return;
  const render = async (n: number): Promise<number> => {
    let peak = 0;
    for (let f = 0; f < n; f++) {
      loop.mainFrame(0.0107);
      for (const s of loop.render(4).left) peak = Math.max(peak, Math.abs(s));
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
    return peak;
  };
  try {
    const en = Audio.line("hello");
    expect(en.language).toBe("en");
    expect(await render(30)).toBe(0); // the English file is silent
    en.stop(0);
    await render(4);
    await Audio.setLanguage("fr");
    const fr = Audio.line("hello");
    expect(fr.language).toBe("fr");
    expect(await render(30)).toBeGreaterThan(0.1); // the French file's level
    expect(decoded.some((p) => p.includes("vo/fr/hello.wav"))).toBe(true);
  } finally {
    engine.dispose();
  }
});
