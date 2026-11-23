import { describe, expect, it } from "vitest";
import { compileGlob, hasWildcard, matchesGlob } from "./pathGlob";

const table = (pattern: string, yes: string[], no: string[]) => {
  const g = compileGlob(pattern);
  for (const p of yes) expect(g.matches(p), `${pattern} ~ ${p}`).toBe(true);
  for (const p of no) expect(g.matches(p), `${pattern} !~ ${p}`).toBe(false);
};

describe("compileGlob", () => {
  it("matches ** across folders", () => {
    table("audio/music/**", ["audio/music/a.ogg", "audio/music/x/y/b.wav"], ["audio/music", "audio/musicx/a.ogg", "x/audio/music/a.ogg"]);
    table("audio/**/hit.wav", ["audio/hit.wav", "audio/a/b/hit.wav"], ["audio/hit.wave", "sfx/hit.wav"]);
    table("**/hit.wav", ["hit.wav", "a/b/hit.wav"], ["a/hit.wave"]);
    table("**", ["a", "a/b"], []);
  });

  it("matches a name without a slash at any depth, and a folder's contents", () => {
    table("*.wav", ["a.wav", "x/y/a.wav"], ["a.wav.meta.json", "a.ogg"]);
    table("audio/ui", ["audio/ui", "audio/ui/click.wav"], ["audio/uix", "x/audio/ui"]);
    table("audio/ui/", ["audio/ui/click.wav"], ["audio/ui"]);
    table("/audio/a.wav", ["audio/a.wav"], ["x/audio/a.wav"]);
  });

  it("handles ? and character classes, and escapes", () => {
    table("audio/step_0?.wav", ["audio/step_01.wav"], ["audio/step_1.wav", "audio/step_0/.wav"]);
    table("audio/[ab]*.wav", ["audio/a1.wav", "audio/b.wav"], ["audio/c.wav"]);
    table("audio/[!ab]*.wav", ["audio/c.wav"], ["audio/a.wav"]);
    table("a\\*b.wav", ["a*b.wav"], ["axb.wav"]);
    table("a.b", ["a.b"], ["axb"]);
  });

  it("tells patterns from plain paths", () => {
    expect(hasWildcard("audio/a.wav")).toBe(false);
    expect(hasWildcard("audio/*.wav")).toBe(true);
    expect(hasWildcard("a\\*b")).toBe(false);
    expect(matchesGlob("", "a")).toBe(false);
  });
});
