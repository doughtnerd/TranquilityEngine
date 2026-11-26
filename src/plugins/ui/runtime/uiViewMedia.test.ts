import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, Input } from "../../../engine/index";
import { World } from "../../../engine/core/World";
import { getComponentClass } from "../../../engine/core/registry";
import { UIAudio, UISvg, UIText, UIVideo } from "../../../engine/ui/components";
import type { UIMediaSource } from "../../../engine/ui/media";
import { UIPointer } from "../../../engine/tests/uiPointer";
import { UIView } from "./UIView";
import * as SvgModule from "./testComponents/Svg.svelte";
import * as MediaModule from "./testComponents/Media.svelte";

// ADR 0426 in Svelte views: an <svg> kept as an SVG document on its element (re-serialised when anything in it
// changes), its shapes' lengths and pointer events; <video> and <audio> with the media API and Svelte's media bindings.
// No real media: a fake media element is handed to the video through its public `media` seam.

const DT = 1 / 60;
let engine: Engine;
let pointer: UIPointer | null = null;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "ui/svg.svelte": SvgModule, "ui/media.svelte": MediaModule }) });
});

afterEach(() => {
  pointer?.dispose();
  pointer = null;
  engine.dispose();
  Input.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function view(component: string, props: Record<string, unknown> = {}) {
  const log: string[] = [];
  const nodes: Record<string, Record<string, unknown>> = {};
  const all = { log: (s: string) => log.push(s), onnode: (k: string, n: Record<string, unknown>) => (nodes[k] = n), ...props };
  const v = GameObject.create("UI").addBehavior(UIView, { component: `asset:${component}`, props: all });
  await v.ready;
  return { v, log, nodes, set: (more: Record<string, unknown>) => (v.props = { ...all, ...more }) };
}

describe("UIView: inline SVG (ADR 0426)", () => {
  it("keeps the <svg> subtree as its element's SVG document, re-serialised when an attribute changes", async () => {
    const { v, set } = await view("ui/svg.svelte");
    const svg = v.query("#icon")!.as(UISvg);
    expect(svg.markup.startsWith('<svg width="200" height="100" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg">')).toBe(true);
    expect(svg.markup).toContain(`<g transform="translate(10, 0)"><circle cx="15" cy="25" fill="currentColor" r="20"></circle></g>`);
    expect(svg.markup).toContain('<text x="50" y="45">Hi</text>');
    expect(svg.markup).not.toContain("class="); // the <svg>'s class is the cascade's
    // Its size from its attributes, its colour (`currentColor`) from the stylesheet; its shapes aren't UI elements.
    expect([svg.width, svg.height]).toEqual(["200", "100"]);
    expect(svg.color.toCss()).toBe(new Color(0, 1, 0, 1).toCss());
    set({ r: 12 });
    engine.step(DT);
    expect(svg.markup).toContain('r="12"');
  });

  it("measures shapes: getTotalLength() and getPointAtLength() by the arc length of their paths", async () => {
    const { nodes } = await view("ui/svg.svelte");
    const circle = nodes.circle as { getTotalLength(): number; getPointAtLength(d: number): { x: number; y: number } };
    expect(circle.getTotalLength()).toBeCloseTo(2 * Math.PI * 20, 6);
    // A quarter of the way round from the rightmost point (clockwise in y-down coordinates): the bottom.
    const p = circle.getPointAtLength(Math.PI * 10);
    expect(p.x).toBeCloseTo(15, 4);
    expect(p.y).toBeCloseTo(45, 4);
    const square = nodes.path as { getTotalLength(): number; getPointAtLength(d: number): { x: number; y: number } };
    expect(square.getTotalLength()).toBeCloseTo(120, 9);
    const q = square.getPointAtLength(45);
    expect([q.x, q.y]).toEqual([expect.closeTo(90, 6), expect.closeTo(25, 6)]);
  });

  it("sends a pointer event to the shape under it, through its group to the <svg>; elsewhere to the <svg>", async () => {
    const { v, log } = await view("ui/svg.svelte");
    pointer = await UIPointer.create(World.require());
    const svg = v.query("#icon")!.as(UISvg);
    const box = pointer.pointIn(svg, 0, 0);
    // viewBox 0 0 100 50 in a 200 × 100 box: 2 pixels per unit. The circle is at (25, 25) after its group's translate.
    const click = (ux: number, uy: number) => {
      pointer!.dom.moveTo(box.x + ux * 2, box.y + uy * 2);
      pointer!.dom.click();
      engine.step(DT);
      engine.step(DT);
    };
    click(25, 25);
    expect(log).toEqual(["circle click circle", "g click", "svg click circle"]);
    log.length = 0;
    click(75, 25); // inside the square, which only takes the pointer on its stroke
    expect(log).toEqual(["svg click svg"]);
    log.length = 0;
    click(90, 25); // on its right edge's stroke
    expect(log).toEqual(["path click", "svg click path"]);
  });
});

/** A media element with no media in it: events fire as a browser's do when its state changes. */
class FakeMedia implements UIMediaSource {
  paused = true;
  ended = false;
  duration = NaN;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  loop = false;
  src = "";
  plays = 0;
  private time = 0;
  private _volume = 1;
  private _muted = false;
  private _rate = 1;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type });
  }
  play(): Promise<void> {
    this.plays++;
    if (this.paused) {
      this.paused = false;
      this.emit("play");
    }
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  get currentTime(): number {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.emit("seeked");
  }
  get volume(): number {
    return this._volume;
  }
  set volume(v: number) {
    if (v === this._volume) return;
    this._volume = v;
    this.emit("volumechange");
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(v: boolean) {
    if (v === this._muted) return;
    this._muted = v;
    this.emit("volumechange");
  }
  get playbackRate(): number {
    return this._rate;
  }
  set playbackRate(v: number) {
    this._rate = v;
  }
  /** The browser loaded its metadata. */
  load(duration: number, w: number, h: number): void {
    this.duration = duration;
    this.videoWidth = w;
    this.videoHeight = h;
    this.readyState = 4;
    this.emit("loadedmetadata");
    this.emit("durationchange");
  }
  /** Time passed while playing. */
  advance(t: number): void {
    this.time = t;
    this.emit("timeupdate");
  }
}

describe("UIView: <video> and <audio> (ADR 0426)", () => {
  it("maps attributes to the video's fields and its media API onto a media element handed to it", async () => {
    const { v, nodes } = await view("ui/media.svelte");
    const video = v.query("#clip")!.as(UIVideo);
    expect([video.src, video.loop, video.width, video.height]).toEqual(["asset:videos/intro.webm", true, "320", "180"]);
    // Headless there's no HTMLVideoElement to make: nothing plays until a media element is handed in.
    expect(video.media).toBeNull();
    const fake = new FakeMedia();
    video.media = fake;
    engine.step(DT);
    expect(fake.loop).toBe(true); // fields are kept on it each frame
    const node = nodes.video as { play(): Promise<void>; paused: boolean; currentTime: number; volume: number };
    await node.play();
    expect(fake.plays).toBe(1);
    expect(node.paused).toBe(false);
    node.currentTime = 12;
    expect(fake.currentTime).toBe(12);
    node.volume = 0.25;
    engine.step(DT);
    expect(fake.volume).toBe(0.25);
  });

  it("binds currentTime, paused, volume, muted and duration both ways through the media events", async () => {
    const { v, log, set } = await view("ui/media.svelte");
    const fake = new FakeMedia();
    v.query("#clip")!.as(UIVideo).media = fake;
    engine.step(DT);
    const state = () => v.query("#state")!.as(UIText).text;
    fake.load(30, 640, 360);
    engine.step(DT);
    expect(state()).toBe("true 1 false 30");
    // The component's state drives the element…
    set({ paused: false, volume: 0.5 });
    engine.step(DT);
    expect(fake.paused).toBe(false);
    expect(fake.volume).toBe(0.5);
    expect(log).toContain("play");
    // …and the element's events drive the state.
    fake.advance(3.25);
    engine.step(DT);
    expect(v.query("#time")!.as(UIText).text).toBe("3.3");
    fake.muted = true;
    fake.pause();
    engine.step(DT);
    expect(state()).toBe("true 0.5 true 30");
    fake.ended = true;
    fake.emit("ended");
    engine.step(DT);
    expect(log).toContain("ended");
  });

  it("plays <audio> through an AudioSource its node owns, its <source> giving the clip, autoplaying once", async () => {
    const { v } = await view("ui/media.svelte");
    const audio = v.query("#theme")!.as(UIAudio);
    expect([audio.src, audio.autoplay, audio.display]).toEqual(["asset:sounds/theme.ogg", true, "none"]);
    engine.step(DT);
    expect(audio.paused).toBe(false); // autoplay
    // Its time runs on the element's clock while it plays, and stops when it pauses.
    for (let i = 0; i < 30; i++) engine.step(DT);
    expect(audio.currentTime).toBeCloseTo(31 * DT, 3);
    audio.pause();
    const t = audio.currentTime;
    engine.step(DT);
    expect(audio.currentTime).toBe(t);
    // Through the audio plugin when it's on: the AudioSource it made plays the <source>'s clip.
    const type = getComponentClass("engine.AudioSource");
    if (type) expect((audio.node.getComponent(type as never) as unknown as { clip: string }).clip).toBe("asset:sounds/theme.ogg");
  });
});
