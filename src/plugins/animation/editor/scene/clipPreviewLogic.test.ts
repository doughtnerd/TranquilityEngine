// The clip preview's model side (ADR 0373; T18): which model a clip previews on, the clip's timing read from an authored
// or compiled clip (fixture `runtime/wasm/fixtures/walk.anim`), and the playhead the play/pause button and scrubber drive.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../../../../myco";
import { readClipInfo } from "../../runtime/assetInfo";
import { ClipPlayhead, clipTiming, modelOfClip, previewModel } from "./clipPreviewLogic";

const WALK = new Uint8Array(readFileSync(new URL("../../runtime/wasm/fixtures/walk.anim", import.meta.url)));
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;

afterEach(() => Assets.clearSources());

describe("the model a clip previews on", () => {
  it("is a model clip's own model, else the one dragged onto the preview (per clip)", () => {
    expect(modelOfClip("models/hero.glb#Anim/Run")).toBe("models/hero.glb");
    expect(modelOfClip("asset:models/hero.glb#Anim/Run")).toBe("models/hero.glb");
    expect(modelOfClip("animation/run.anim.json")).toBeNull();
    expect(previewModel("models/hero.glb#Anim/Run").value).toBe("models/hero.glb");
    const own = previewModel("animation/run.anim.json");
    expect(own.value).toBeNull();
    own.value = "models/hero.glb";
    expect(previewModel("animation/run.anim.json").value).toBe("models/hero.glb");
    expect(previewModel("animation/jump.anim.json").value).toBeNull();
  });
});

describe("a clip's timing", () => {
  it("reads an authored clip's duration and loop flag", async () => {
    Assets.addSource(Assets.fromObject({ "animation/run.anim.json": { format: "myco.anim-source@1", duration: 0.8, loop: true } }));
    expect(await clipTiming("asset:animation/run.anim.json")).toEqual({ duration: 0.8, looping: true, known: true });
  });

  it("reads a compiled clip's header", async () => {
    Assets.addSource(Assets.fromObject({ "animation/walk.anim.bin": dataUrl(WALK) }));
    const info = readClipInfo(WALK)!;
    expect(await clipTiming("animation/walk.anim.bin")).toEqual({ duration: info.duration, looping: info.looping, known: true });
  });

  it("stands in one looping second for a clip it can't read (a model's clip before import, a missing file)", async () => {
    expect(await clipTiming("models/hero.glb#Anim/Run")).toEqual({ duration: 1, looping: true, known: false });
    expect(await clipTiming("animation/gone.anim.json")).toEqual({ duration: 1, looping: true, known: false });
  });
});

describe("the preview's playhead", () => {
  it("advances only while playing, and wraps a looping clip", () => {
    const p = new ClipPlayhead();
    p.setTiming({ duration: 1, looping: true, known: true });
    p.advance(0.5);
    expect(p.time.value).toBe(0);
    p.toggle();
    expect(p.playing.value).toBe(true);
    p.advance(0.75);
    p.advance(0.5);
    expect(p.time.value).toBeCloseTo(0.25, 9);
    p.toggle();
    p.advance(0.5);
    expect(p.time.value).toBeCloseTo(0.25, 9);
  });

  it("stops at the end of a clip that doesn't loop, and plays again from the start", () => {
    const p = new ClipPlayhead();
    p.setTiming({ duration: 2, looping: false, known: true });
    p.play();
    p.advance(3);
    expect(p.time.value).toBe(2);
    expect(p.playing.value).toBe(false);
    p.play();
    expect(p.time.value).toBe(0);
    expect(p.playing.value).toBe(true);
  });

  it("scrubs within the clip, pausing", () => {
    const p = new ClipPlayhead();
    p.setTiming({ duration: 2, looping: true, known: true });
    p.play();
    p.seek(1.5);
    expect(p.time.value).toBe(1.5);
    expect(p.playing.value).toBe(false);
    p.seek(9);
    expect(p.time.value).toBe(2);
    p.seek(-1);
    expect(p.time.value).toBe(0);
    p.seek(1.5);
    p.setTiming({ duration: 1, looping: true, known: true }); // a shorter clip keeps the time within it
    expect(p.time.value).toBe(1);
    expect(p.duration).toBe(1);
  });
});
