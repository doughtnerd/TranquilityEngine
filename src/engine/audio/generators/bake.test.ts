// ADR 0360 §6: Bake writes `<name>.baked.wav` (float32 mono 48 kHz) and its sidecar (`sample` and `generated` with the
// patch's SHA-256), renders variations and a Queue over them, points uses at the bake as one project edit (undone in one
// step), and `isBakeStale` compares the sidecar's hash with the patch now. All through an in-memory project host.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../localisation/textHash";
import { parseImportSettings } from "../../scene/importSettings";
import { parsePlaylist } from "../playlist/format";
import { decodeWavPcm } from "../sample/wavPcm";
import { bakeGenerator, generatorPatchHash, isBakeStale, replaceGeneratorUsesInJson, type BakeHost, type BakeUsesEdit } from "./bake";
import { blipPreset } from "./blipPresets";
import { defaultGeneratorParams } from "./catalogue";
import { formatGenerator } from "./format";
import { renderResolvedGenerator } from "./generatorRender";
import { generatorPatchText, resolveGenerator } from "./resolve";
import { mulberry32 } from "./random";
import type { GeneratorBody } from "./types";

const GEN = "audio/ui/coin.generator.json";
const coin: GeneratorBody = { kind: "blip", params: blipPreset("coin", 1734), seed: 1734, preset: "coin", vary: 0 };

/** An in-memory project with an undo stack: `editProjectFiles` applies an edit to every file as one undo step. */
class MemoryProject implements BakeHost {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();
  readonly undoStack: { label: string; before: Map<string, string> }[] = [];
  edits = 0;
  constructor(files: Record<string, string>) {
    for (const [k, v] of Object.entries(files)) this.text.set(k, v);
  }
  get files(): string[] {
    return [...this.text.keys(), ...this.binary.keys()];
  }
  readText = async (path: string) => this.text.get(path) ?? null;
  writeBinary = async (path: string, bytes: Uint8Array) => void this.binary.set(path, bytes);
  writeText = async (path: string, text: string) => void this.text.set(path, text);
  editProjectFiles = async (edit: BakeUsesEdit, label: string): Promise<string[]> => {
    this.edits++;
    const before = new Map<string, string>();
    const changed: string[] = [];
    for (const [path, text] of this.text) {
      if (!path.endsWith(".json") || !edit.mentioned(text)) continue;
      const next = edit.json(JSON.parse(text), path);
      if (next === null) continue;
      before.set(path, text);
      this.text.set(path, `${JSON.stringify(next, null, 2)}\n`);
      changed.push(path);
    }
    this.undoStack.push({ label, before });
    return changed;
  };
  undo(): void {
    const step = this.undoStack.pop();
    for (const [path, text] of step?.before ?? []) this.text.set(path, text);
  }
}

const sidecarOf = (p: MemoryProject, path: string) => parseImportSettings(JSON.parse(p.text.get(`${path}.meta.json`)!)).settings;

describe("bakeGenerator", () => {
  it("writes <name>.baked.wav as float32 mono at 48 kHz and a sidecar with the sample and generated blocks", async () => {
    const p = new MemoryProject({ [GEN]: formatGenerator(coin) });
    const result = await bakeGenerator(GEN, { host: p });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.files.map((f) => f.path)).toEqual(["audio/ui/coin.baked.wav"]);
    const bytes = p.binary.get("audio/ui/coin.baked.wav")!;
    // The format tag (3: IEEE float), channels, rate and bits.
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([3, 1, 48000, 32]);
    // The samples are the offline render of the stored patch, exactly.
    const want = await renderResolvedGenerator(resolveGenerator(coin, mulberry32(0)), { rate: 48000 });
    const wav = decodeWavPcm(bytes)!;
    expect(wav.channels).toBe(1);
    expect(Array.from(wav.pcm)).toEqual(Array.from(want.pcm));
    const sidecar = sidecarOf(p, "audio/ui/coin.baked.wav");
    expect(sidecar.sample?.kind).toBe("oneshot");
    expect(sidecar.sample?.root?.note).toMatch(/^[A-G]/);
    const hash = sha256Hex(new TextEncoder().encode(generatorPatchText(coin)));
    expect(sidecar.generated).toEqual({ generator: GEN, hash, seed: 1734, variation: 0 });
    expect(result.hash).toBe(hash);
  });

  it("takes the next free name, and an endless generator bakes as a loop", async () => {
    const tone: GeneratorBody = { kind: "oscillator", params: { ...defaultGeneratorParams("oscillator"), frequency: 440 }, seed: 9, vary: 0 };
    const p = new MemoryProject({ "sfx/hum.generator.json": formatGenerator(tone), "sfx/hum.baked.wav.meta.json": "{}" });
    p.binary.set("sfx/hum.baked.wav", new Uint8Array(4));
    const result = await bakeGenerator("sfx/hum.generator.json", { host: p, seconds: 1 });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.files[0]!.path).toBe("sfx/hum.baked2.wav");
    expect(result.files[0]!.frames).toBe(48000 + 2400);
    const s = sidecarOf(p, "sfx/hum.baked2.wav");
    expect(s.sample?.kind).toBe("loop");
    expect(s.sample?.loops[0]).toMatchObject({ start: 0.05, end: 1.05 });
    expect(s.sample?.root).toEqual({ note: "A4", cents: 0, source: "set" });
  });

  it("renders N variations from seed, seed + 1, … with a Queue over them", async () => {
    const p = new MemoryProject({ [GEN]: formatGenerator(coin) });
    const result = await bakeGenerator(GEN, { host: p, variations: 3, queue: true });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.files.map((f) => [f.path, f.seed, f.variation])).toEqual([
      ["audio/ui/coin.baked.wav", 1734, 0],
      ["audio/ui/coin.baked2.wav", 1735, 1],
      ["audio/ui/coin.baked3.wav", 1736, 2],
    ]);
    for (const f of result.files) expect(sidecarOf(p, f.path).generated).toMatchObject({ seed: f.seed, variation: f.variation, hash: result.hash });
    const pcm = result.files.map((f) => Array.from(decodeWavPcm(p.binary.get(f.path)!)!.pcm));
    expect(pcm[1]).not.toEqual(pcm[0]);
    expect(pcm[2]).not.toEqual(pcm[1]);
    // The same bake again renders the same files.
    const again = new MemoryProject({ [GEN]: formatGenerator(coin) });
    await bakeGenerator(GEN, { host: again, variations: 3 });
    expect(Array.from(decodeWavPcm(again.binary.get("audio/ui/coin.baked3.wav")!)!.pcm)).toEqual(pcm[2]);
    expect(result.queue).toBe("audio/ui/coin.baked.playlist.json");
    const queue = parsePlaylist(JSON.parse(p.text.get(result.queue!)!), result.queue!);
    expect(queue.problems).toEqual([]);
    expect(queue.playlist.type).toBe("queue");
    expect(queue.playlist.queue).toEqual({ pick: "random", avoidRepeat: 1, continuous: null });
    expect(queue.playlist.entries.map((e) => (e.kind === "embedded" && e.embedded.entries[0]?.kind === "sample" ? e.embedded.entries[0].sample : null))).toEqual(result.files.map((f) => f.path));
  });

  it("re-renders one variation of several over its own file (Rebake)", async () => {
    const p = new MemoryProject({ [GEN]: formatGenerator(coin) });
    const all = await bakeGenerator(GEN, { host: p, variations: 3 });
    if ("refused" in all) throw new Error(all.refused);
    const third = Array.from(decodeWavPcm(p.binary.get("audio/ui/coin.baked3.wav")!)!.pcm);
    p.binary.set("audio/ui/coin.baked3.wav", new Uint8Array(4));
    const again = await bakeGenerator(GEN, { host: p, variation: 2, paths: ["audio/ui/coin.baked3.wav"] });
    if ("refused" in again) throw new Error(again.refused);
    expect(again.files.map((f) => [f.path, f.seed, f.variation])).toEqual([["audio/ui/coin.baked3.wav", 1736, 2]]);
    expect(Array.from(decodeWavPcm(p.binary.get("audio/ui/coin.baked3.wav")!)!.pcm)).toEqual(third);
    expect(p.files.filter((f) => f.endsWith(".wav"))).toHaveLength(3);
  });

  it("points the generator's uses at the bake as one undoable project edit", async () => {
    const clip = { format: "myco.playlist@1", type: "clip", entries: [{ generator: GEN, volume: -3, curves: { "gen:level": { input: "voiceTime", curve: [[0, -12]] } } }] };
    const seq = {
      format: "myco.playlist@1", type: "sequence",
      sequence: { length: 4, tracks: [{ id: "t1", name: "A", kind: "audio", clips: [{ id: "c1", generator: GEN, at: 1, length: 0.5 }, { id: "c2", sample: "a.wav", at: 2, length: 0 }] }] },
    };
    const other = { format: "myco.playlist@1", type: "clip", entries: [{ generator: "audio/ui/other.generator.json" }] };
    const files: Record<string, string> = { [GEN]: formatGenerator(coin), "a.playlist.json": JSON.stringify(clip), "b.playlist.json": JSON.stringify(seq), "c.playlist.json": JSON.stringify(other) };
    const p = new MemoryProject(files);
    const result = await bakeGenerator(GEN, { host: p, replaceUses: true });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.replaced).toEqual(["a.playlist.json", "b.playlist.json"]);
    expect(p.edits).toBe(1);
    expect(p.undoStack[0]!.label).toBe("Replace uses of coin.generator.json · coin.baked.wav");
    const a = JSON.parse(p.text.get("a.playlist.json")!);
    expect(a.entries[0]).toEqual({ sample: "audio/ui/coin.baked.wav", volume: -3 });
    const b = JSON.parse(p.text.get("b.playlist.json")!);
    expect(b.sequence.tracks[0].clips[0]).toEqual({ id: "c1", sample: "audio/ui/coin.baked.wav", at: 1, length: 0.5 });
    expect(p.text.get("c.playlist.json")).toBe(files["c.playlist.json"]);
    // One undo puts every file back.
    p.undo();
    for (const path of ["a.playlist.json", "b.playlist.json", "c.playlist.json"]) expect(p.text.get(path)).toBe(files[path]);
  });

  it("with a Queue, points an embedded Clip and a sequence clip at the Queue", () => {
    const json = { type: "queue", entries: [{ embedded: { type: "clip", entries: [{ generator: GEN }] }, weight: 2 }] };
    expect(replaceGeneratorUsesInJson(json, GEN, "s.wav", "q.playlist.json")).toEqual({ type: "queue", entries: [{ playlist: "q.playlist.json", weight: 2 }] });
    const clip = { id: "c", generator: GEN, at: 0, length: 1 };
    expect(replaceGeneratorUsesInJson(clip, GEN, "s.wav", "q.playlist.json")).toEqual({ id: "c", playlist: "q.playlist.json", at: 0, length: 1 });
    expect(replaceGeneratorUsesInJson({ entries: [{ sample: "x.wav" }] }, GEN, "s.wav", null)).toBeNull();
  });

  it("refuses a silence, an unreadable file and Replace uses without a project edit", async () => {
    const p = new MemoryProject({ "s.generator.json": formatGenerator({ kind: "silence", params: defaultGeneratorParams("silence"), seed: null, vary: 0 }) });
    expect(await bakeGenerator("s.generator.json", { host: p })).toEqual({ refused: "a silence has nothing to bake" });
    expect(await bakeGenerator("missing.generator.json", { host: p })).toEqual({ refused: "missing.generator.json can't be read" });
    const { editProjectFiles: _e, ...noEdit } = p;
    void _e;
    const host: BakeHost = { files: [], readText: noEdit.readText, writeBinary: noEdit.writeBinary, writeText: noEdit.writeText };
    expect(await bakeGenerator(GEN, { host, body: coin, replaceUses: true })).toEqual({ refused: "Replace uses needs a project to edit" });
  });
});

describe("isBakeStale", () => {
  it("is false for the patch baked and true once the patch changes", () => {
    const sidecar = { generated: { generator: GEN, hash: generatorPatchHash(coin), seed: 1734, variation: 0 } };
    expect(isBakeStale(sidecar, coin)).toBe(false);
    // Formatting and display-only fields don't matter; values and the seed do.
    expect(isBakeStale(sidecar, { ...coin, note: "Shop", preset: "jump" })).toBe(false);
    expect(isBakeStale(sidecar, { ...coin, params: { ...coin.params, decay: 0.5 } })).toBe(true);
    expect(isBakeStale(sidecar, { ...coin, seed: 1 })).toBe(true);
    expect(isBakeStale({ generated: null }, coin)).toBe(false);
  });
});
