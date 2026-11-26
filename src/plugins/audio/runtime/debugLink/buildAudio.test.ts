import { describe, expect, it } from "vitest";
import { fnv1a } from "../capture/take";
import { buildAudioIndex, buildFileBytes, type BuildAudioHost } from "./buildAudio";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function host(): BuildAudioHost & { read: string[] } {
  const read: string[] = [];
  const json: Record<string, unknown> = { "project.json": { name: "Canyon" }, "audio.json": { buses: [] }, "sfx/click.playlist.json": { root: "x" } };
  return {
    read,
    paths: () => ["project.json", "audio.json", "sfx/click.playlist.json", "sfx/click.wav", "music/theme.ogg", "music/long.ogg", "art/hero.png", "scripts/main.js"],
    json: (p) => json[p],
    projectBytes: async (p) => (read.push(`project:${p}`), new Uint8Array([1, 2])),
    buildBytes: async (p) => (read.push(`build:${p}`), new Uint8Array([3])),
    manifest: () => ({
      packages: [{ url: "audio/packages/Core.mycopak" }],
      media: { "music/theme.ogg": { package: "Core" }, "music/long.ogg": { package: "Core", url: "audio/stream/abc.ogg" } },
    }),
    project: () => "Canyon",
    audioHash: () => "0badf00d",
  };
}

describe("the build's audio for a tool (ADR 0410)", () => {
  it("lists the JSON files with their hashes, the loose sounds, and the packages and streamed media", () => {
    const index = buildAudioIndex(host());
    expect(index.project).toBe("Canyon");
    expect(index.audioHash).toBe("0badf00d");
    expect(index.files).toEqual([
      { kind: "project", path: "project.json", hash: fnv1a(JSON.stringify({ name: "Canyon" })) },
      { kind: "project", path: "audio.json", hash: fnv1a(JSON.stringify({ buses: [] })) },
      { kind: "project", path: "sfx/click.playlist.json", hash: fnv1a(JSON.stringify({ root: "x" })) },
      { kind: "project", path: "sfx/click.wav", hash: null }, // loose: no media entry
      // music/theme.ogg is in the Core package; music/long.ogg streams from its own build file
      { kind: "build", path: "audio/packages/Core.mycopak", hash: null },
      { kind: "build", path: "audio/stream/abc.ogg", hash: null },
    ]);
  });

  it("sends each listed file's bytes, and refuses anything it doesn't list", async () => {
    const h = host();
    expect(JSON.parse(decode(await buildFileBytes({ kind: "project", path: "audio.json" }, h)))).toEqual({ buses: [] });
    expect(await buildFileBytes({ kind: "project", path: "sfx/click.wav" }, h)).toEqual(new Uint8Array([1, 2]));
    expect(await buildFileBytes({ kind: "build", path: "audio/packages/Core.mycopak" }, h)).toEqual(new Uint8Array([3]));
    await expect(buildFileBytes({ kind: "project", path: "art/hero.png" }, h)).rejects.toThrow("isn't part of the build's audio");
    await expect(buildFileBytes({ kind: "project", path: "music/theme.ogg" }, h)).rejects.toThrow("isn't part of the build's audio");
    await expect(buildFileBytes({ path: "audio.json" }, h)).rejects.toThrow("needs a kind");
    expect(h.read).toEqual(["project:sfx/click.wav", "build:audio/packages/Core.mycopak"]);
  });
});
