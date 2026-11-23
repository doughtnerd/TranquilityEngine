// Baked samples in a build (ADR 0342): a sample with enabled baked effects and no render ships a render and points at it;
// flattened, normalize-only and non-WAV samples are left alone (the last with a log line); a render the Studio cached
// is shipped as it is; a derived sample gets its own render.
import { describe, expect, it } from "vitest";
import { renderCachePath, renderKey } from "../engine/audio/sample/renderCache";
import { parseSampleEdits } from "../engine/audio/sample/format";
import { decodeWavPcm } from "../engine/audio/sample/wavPcm";
import { encodeWavFloat32 } from "../engine/audio/sample/wavEncode";
import { MANIFEST_FORMAT, type GameManifest } from "./format";
import { exportRenderPath, withRenderedSamples } from "./sampleRenders";
import type { WebBuildPlan } from "./webBuild";

const RATE = 8000;
const wav = encodeWavFloat32(new Float32Array(800).fill(0.25), 1, RATE);
const GAIN = [{ id: "g", type: "gain", on: true, params: { gain: 6 } }];
const side = (sample: unknown) => JSON.stringify({ format: "myco.import@1", volume: 0.8, sample });

function setup(files: Record<string, string | Uint8Array>) {
  const copies = Object.keys(files).filter((p) => !p.startsWith(".myco/")).sort();
  const manifest: GameManifest = { format: MANIFEST_FORMAT, name: "g", mainScene: null, files: copies, scripts: [] };
  const plan: WebBuildPlan = { manifest, copies, generated: new Map() };
  const log: string[] = [];
  const read = async (p: string) => {
    if (!(p in files)) throw new Error(`no ${p}`);
    return files[p];
  };
  return { plan, read, log, logger: (l: string) => log.push(l) };
}

describe("withRenderedSamples", () => {
  it("renders a baked sample without a render, ships it beside the source and points the build's sidecar at it", async () => {
    const t = setup({ "a.wav": wav, "a.wav.meta.json": side({ effects: GAIN, markers: [{ id: "m", type: "exit", at: 0.05 }] }) });
    const out = await withRenderedSamples(t.plan, t.read, t.logger);
    const key = await renderKey(wav, parseSampleEdits({ effects: GAIN, markers: [{ id: "m", type: "exit", at: 0.05 }] }, "s", []));
    const render = exportRenderPath("a.wav", key);
    expect(render).toMatch(/^a\.render-[0-9a-f]{12}\.wav$/);
    const pcm = decodeWavPcm(out.binaries!.get(`project/${render}`)!)!;
    expect(pcm.pcm[0]).toBeCloseTo(0.25 * Math.pow(10, 6 / 20), 4);
    const sidecar = JSON.parse(out.generated.get("project/a.wav.meta.json")!);
    expect(sidecar).toMatchObject({ format: "myco.import@1", volume: 0.8, sample: { effects: GAIN, source: render } });
    expect(out.manifest.files).toContain(render);
    expect(JSON.parse(out.generated.get("game.json")!).files).toContain(render);
    expect(t.log).toEqual([`a.wav: rendered its baked effects into ${render}.`]);
  });

  it("leaves flattened, normalize-only and effect-free samples alone, and says why a non-WAV ships without its effects", async () => {
    const t = setup({
      "b.wav": wav, "b.flat1.wav": wav, "b.wav.meta.json": side({ effects: GAIN, source: "b.flat1.wav" }),
      "n.wav": wav, "n.wav.meta.json": side({ normalize: { mode: "peak", target: -1, gainDb: 3 } }),
      "o.wav": wav, "o.wav.meta.json": side({ effects: [{ ...GAIN[0], on: false }] }),
      "c.ogg": new Uint8Array(4), "c.ogg.meta.json": side({ effects: GAIN }),
    });
    const out = await withRenderedSamples(t.plan, t.read, t.logger);
    expect(out).toBe(t.plan);
    expect(t.log).toEqual(["c.ogg: its baked effects can't be rendered by the export (c.ogg isn't a WAV); it ships without them. Flatten it in the Studio first."]);
  });

  it("ships the Studio's cached render of the same content as it is", async () => {
    const key = await renderKey(wav, parseSampleEdits({ effects: GAIN }, "s", []));
    const cached = encodeWavFloat32(new Float32Array([0.1, 0.2]), 1, RATE);
    const t = setup({ "a.wav": wav, "a.wav.meta.json": side({ effects: GAIN }), [renderCachePath(key)]: cached });
    const out = await withRenderedSamples(t.plan, t.read, t.logger);
    expect(out.binaries!.get(`project/${exportRenderPath("a.wav", key)}`)).toBe(cached);
    expect(t.log[0]).toContain("(from the Studio's render cache)");
  });

  it("gives a derived sample with its own effects a render of its own", async () => {
    const derived = { format: "myco.sample@1", source: "a.wav", range: null, lineage: { kind: "duplicate", parent: "a.wav", mode: "pin" }, sample: { effects: [{ ...GAIN[0], params: { gain: -6 } }] } };
    const t = setup({ "a.wav": wav, "d.sample.json": JSON.stringify(derived) });
    const out = await withRenderedSamples(t.plan, t.read, t.logger);
    const written = JSON.parse(out.generated.get("project/d.sample.json")!);
    expect(written.sample.source).toMatch(/^a\.render-[0-9a-f]{12}\.wav$/);
    expect(written.lineage).toEqual(derived.lineage);
    const pcm = decodeWavPcm(out.binaries!.get(`project/${written.sample.source}`)!)!;
    expect(pcm.pcm[0]).toBeCloseTo(0.25 * Math.pow(10, -6 / 20), 4);
    expect(out.generated.has("project/a.wav.meta.json")).toBe(false);
  });
});
