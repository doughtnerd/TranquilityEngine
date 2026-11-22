// ADR 0341 §4: `audio.json` `settings.dialogue` survives a parse and write (a Studio save of audio.json must not drop it).
import { describe, expect, it } from "vitest";
import { audioProjectToJson, parseAudioProject } from "./format";

describe("settings.dialogue in audio.json", () => {
  it("keeps authored values through parse and write, and leaves defaults out", () => {
    const parsed = parseAudioProject({ format: "myco.audio@1", settings: { dialogue: { maxVoices: 5, interruptFadeMs: 300 } } });
    expect(parsed.problems).toEqual([]);
    expect(parsed.project.settings.dialogue).toEqual({ maxVoices: 5, interruptFadeMs: 300 });
    const json = audioProjectToJson(parsed.project) as { settings?: { dialogue?: unknown } };
    expect(json.settings?.dialogue).toEqual({ maxVoices: 5, interruptFadeMs: 300 });
    const plain = audioProjectToJson(parseAudioProject({ format: "myco.audio@1" }).project) as { settings?: { dialogue?: unknown } };
    expect(plain.settings?.dialogue).toBeUndefined();
  });

  it("reports bad values and uses the defaults", () => {
    const parsed = parseAudioProject({ format: "myco.audio@1", settings: { dialogue: { maxVoices: -1, interruptFadeMs: "x" } } });
    expect(parsed.project.settings.dialogue).toEqual({ maxVoices: 3, interruptFadeMs: 150 });
    expect(parsed.problems).toEqual([
      "settings.dialogue.maxVoices: must be a whole number 0..64; using 3.",
      "settings.dialogue.interruptFadeMs: must be a whole number 0..10000; using 150.",
    ]);
  });
});
