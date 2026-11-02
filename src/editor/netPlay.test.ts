import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, defineInput, f32, i32, u8, type BootstrapConfig, type BootstrapSetting, type ProjectSettingsInput } from "../engine";
import { World } from "../engine/core/World";
import { engineWorld, netWorldInfo, worldViewStates } from "../engine/editor";
import { netSession } from "../engine/net/session";
import type { LoopbackTransport } from "../engine/net/transport/loopback";
import { NetStatsSampler, byCategory, clampConditions, clientLayout, createThinInput, playBootstrap, trafficCategory } from "./netPlay";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { openScene, sceneCamera } from "./state";
import { sampleProject } from "./testing";

// Multiplayer play mode (ADR 0033 §9, T15): the play-time bootstrap, thin clients and conditions.

const CLIENT_SERVER: BootstrapConfig = {
  worlds: [
    { name: "Server", tags: ["server"], tickRate: 30 },
    { name: "P1", tags: ["client"], tickRate: 30 },
    { name: "P2", tags: ["client"], tickRate: 30 },
    { name: "Tools", tags: ["local"] },
  ],
  links: [
    { from: "P1", to: "Server", transport: "loopback", options: { interpolationMs: 50 } },
    { from: "P2", to: "Server", transport: "loopback" },
  ],
  templates: { Match: { tags: ["server"] } },
};

describe("the play bootstrap", () => {
  it("copies the project's first client World as Client 1…N and Thin 1…T, each with its links", () => {
    const play = playBootstrap(CLIENT_SERVER, { clients: 2, thin: 1 })!;
    expect(play.template).toBe("P1");
    expect(play.clients).toEqual(["Client 1", "Client 2"]);
    expect(play.thin).toEqual(["Thin 1"]);
    expect(play.bootstrap.worlds).toEqual([
      { name: "Server", tags: ["server"], tickRate: 30 },
      { name: "Client 1", tags: ["client"], tickRate: 30 },
      { name: "Client 2", tags: ["client"], tickRate: 30 },
      { name: "Thin 1", tags: ["client"], tickRate: 30, renders: false, input: false },
      { name: "Tools", tags: ["local"] },
    ]);
    // P1's link (with its options) for each, P2's dropped with P2.
    expect(play.bootstrap.links).toEqual(
      ["Client 1", "Client 2", "Thin 1"].map((from) => ({ from, to: "Server", transport: "loopback", options: { interpolationMs: 50 } })),
    );
    expect(play.bootstrap.templates).toEqual(CLIENT_SERVER.templates);
  });

  it("keeps the project's World order: a client listed first stays the default World", () => {
    const setting: BootstrapConfig = {
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server"] },
      ],
      links: [{ from: "Client", to: "Server", transport: "loopback" }],
    };
    const play = playBootstrap(setting, { clients: 1, thin: 2 })!;
    expect(play.bootstrap.worlds.map((w) => w.name)).toEqual(["Client 1", "Thin 1", "Thin 2", "Server"]);
  });

  it("clamps the counts to 1–4 clients and 0–8 thin clients, and keeps names unique", () => {
    const setting: BootstrapConfig = { ...CLIENT_SERVER, worlds: [...CLIENT_SERVER.worlds, { name: "Client 1", tags: ["local"] }] };
    const play = playBootstrap(setting, { clients: 9, thin: 20 })!;
    expect(play.clients).toEqual(["Client 1 2", "Client 2", "Client 3", "Client 4"]);
    expect(play.thin).toHaveLength(8);
    expect(playBootstrap(CLIENT_SERVER, { clients: 0, thin: -1 })!.clients).toEqual(["Client 1"]);
  });

  it("prefers a client-tagged World as the template, and keeps Worlds that listen (a relay) as they are", () => {
    const setting: BootstrapConfig = {
      worlds: [
        { name: "Bot", tags: ["local"] },
        { name: "Player", tags: ["client"] },
        { name: "Relay", tags: ["server"] },
        { name: "Server", tags: ["server"] },
      ],
      links: [
        { from: "Bot", to: "Relay", transport: "loopback" },
        { from: "Player", to: "Relay", transport: "loopback" },
        { from: "Relay", to: "Server", transport: "loopback" },
      ],
    };
    const layout = clientLayout(setting)!;
    expect(layout.template.name).toBe("Player");
    expect([...layout.replaced].sort()).toEqual(["Bot", "Player"]);
    const play = playBootstrap(setting, { clients: 1, thin: 0 })!;
    expect(play.bootstrap.worlds.map((w) => w.name)).toEqual(["Client 1", "Relay", "Server"]);
    expect(play.bootstrap.links).toEqual([
      { from: "Relay", to: "Server", transport: "loopback" },
      { from: "Client 1", to: "Relay", transport: "loopback" },
    ]);
  });

  it("is null for a project without a client/server layout, which plays as it is", () => {
    expect(playBootstrap(undefined, { clients: 2, thin: 1 })).toBeNull();
    expect(playBootstrap("scripts/Bootstrap.ts", { clients: 2, thin: 1 })).toBeNull();
    expect(playBootstrap({ worlds: [{ name: "A" }, { name: "B", tags: ["server"] }] }, { clients: 2, thin: 1 })).toBeNull();
    expect(playBootstrap({ worlds: [{ name: "A" }], links: [{ from: "A", to: "Gone", transport: "loopback" }] }, { clients: 2, thin: 1 })).toBeNull();
  });
});

describe("stats helpers", () => {
  it("group message kinds and turn counters into rates over about a second", () => {
    expect(["net.snapshot", "net.snapshotAck", "net.input:game.Move(x:f32)", "net.rpc", "net.ping", "net.pong", "net.hello", "net.custom"].map(trafficCategory)).toEqual([
      "snapshots",
      "acks",
      "inputs",
      "RPCs",
      "pings",
      "pings",
      "handshake",
      "other",
    ]);
    const traffic = (bytes: number) => ({ bytes, messages: bytes / 10, byKind: { "net.snapshot": { bytes: bytes - 10, messages: bytes / 10 - 1 }, "net.ping": { bytes: 10, messages: 1 } } });
    expect(byCategory(traffic(100)).snapshots).toEqual({ bytes: 90, messages: 9 });
    const world = (bytes: number) => ({
      world: "Server",
      role: "server" as const,
      tick: 0,
      serverTick: 0,
      interpolationTick: 0,
      rtt: 0,
      ghosts: null,
      closed: [],
      prediction: null,
      peers: [{ id: 1, state: "open" as const, remote: "r", rtt: 5, sent: traffic(bytes), received: traffic(bytes / 2), snapshotBytes: 20, ghosts: 1, inputs: [] }],
    });
    const sampler = new NetStatsSampler();
    expect(sampler.sample([world(100)], 0)[0].peers[0].out.bytesPerSecond).toBe(0);
    const later = sampler.sample([world(600)], 500)[0].peers[0];
    expect(later.out.bytesPerSecond).toBe(1000);
    expect(later.in.bytesPerSecond).toBe(500);
    expect(later.out.byCategory.snapshots).toBe(1000);
  });

  it("clamps conditions to the sliders' ranges", () => {
    expect(clampConditions({ latencyMs: 900, jitterMs: -3, lossPercent: Number.NaN })).toEqual({ latencyMs: 500, jitterMs: 0, lossPercent: 0 });
  });
});

// --- in play mode --------------------------------------------------------------------------------

let editor: Engine;
let sample: EditorProject;
const frame = 1 / 60;

function withBootstrap(bootstrap: BootstrapSetting): EditorProject {
  const settings: ProjectSettingsInput = { ...sample.settings, bootstrap };
  return Object.defineProperty(Object.create(sample), "settings", { value: settings }) as EditorProject;
}

const Drive = defineInput("test.netplay.Drive", { x: f32, steps: i32, fire: u8 });

describe("multiplayer play mode", () => {
  beforeEach(async () => {
    Input.reset();
    sample = sampleProject();
    useProjectAssets(sample);
    editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(sample) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
    openSceneFile(editor, sample.mainScene!);
  });

  afterEach(async () => {
    editor.dispose();
    await replaceScripts(new Map());
  });

  const LINKED: BootstrapConfig = {
    worlds: [
      { name: "P1", tags: ["client"] },
      { name: "P2", tags: ["client"] },
      { name: "Server", tags: ["server"] },
    ],
    links: [
      { from: "P1", to: "Server", transport: "loopback" },
      { from: "P2", to: "Server", transport: "loopback" },
    ],
  };

  it("plays N clients plus thin clients; thin clients don't render or take input, and send input", async () => {
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(LINKED), netPlay: { clients: 2, thin: 1, thinInput: "random" } });
    try {
      expect(play.netPlay?.thin).toEqual(["Thin 1"]);
      expect(play.engine.worlds().map((w) => w.name)).toEqual(["Client 1", "Client 2", "Thin 1", "Server"]);
      expect(worldViewStates(play.engine).map((s) => [s.name, s.renders, s.takesInput])).toEqual([
        ["Client 1", true, true],
        ["Client 2", true, false],
        ["Thin 1", false, false],
        ["Server", false, false],
      ]);
      // Every World plays the open scene; the thin client too.
      expect(engineWorld(play.engine, "Thin 1")!.sceneNodes.length).toBe(1);
      for (let i = 0; i < 60; i++) {
        play.updateThinInput();
        play.engine.step(frame);
        await new Promise((r) => setTimeout(r, 2)); // loopback runs on the real clock here
      }
      const server = netWorldInfo(play.engine).find((w) => w.world === "Server")!;
      expect(server.peers.filter((p) => p.state === "open")).toHaveLength(3);
      // Only the thin client wrote input; the server got it.
      const withInput = server.peers.filter((p) => p.inputs.some((i) => i.id === "test.netplay.Drive" && i.received > 0));
      expect(withInput).toHaveLength(1);
    } finally {
      play.stop();
    }
  });

  it("plays the project's own Worlds without netPlay, or when it has no client/server layout", async () => {
    let play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(LINKED) });
    expect(play.netPlay).toBeNull();
    expect(play.engine.worlds().map((w) => w.name)).toEqual(["P1", "P2", "Server"]);
    play.stop();
    const unlinked: BootstrapConfig = { worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"] }] };
    play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(unlinked), netPlay: { clients: 3, thin: 2 } });
    expect(play.netPlay).toBeNull();
    expect(play.engine.worlds().map((w) => w.name)).toEqual(["Client", "Server"]);
    play.stop();
  });

  it("simulates conditions on the clients' and the server's transports, from the start and live", async () => {
    const play = await startPlay({
      editor,
      scene: openScene.value!,
      project: withBootstrap(LINKED),
      netPlay: { clients: 2, thin: 0 },
      conditions: { latencyMs: 80, jitterMs: 10, lossPercent: 5 },
    });
    try {
      const conditions = () =>
        ["Client 1", "Client 2", "Server"].flatMap((name) => netSession(engineWorld(play.engine, name)!)!.transportList().map((t) => (t as LoopbackTransport).conditions));
      expect(conditions()).toEqual(Array(3).fill({ latencyMs: 80, jitterMs: 10, loss: 0.05 }));
      play.setConditions({ latencyMs: 200, jitterMs: 0, lossPercent: 0 });
      expect(conditions()).toEqual(Array(3).fill({ latencyMs: 200, jitterMs: 0, loss: 0 }));
    } finally {
      play.stop();
    }
  });

  it("writes zeros, or a random walk within each field's range", async () => {
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(LINKED), netPlay: { clients: 1, thin: 1 } });
    try {
      const thinWorld = engineWorld(play.engine, "Thin 1")!;
      const read = () => ({ ...(World._runIn(thinWorld, () => Drive.local) as Record<string, number>) });
      let r = 0;
      const random = () => ((r = (r * 9301 + 0.49297) % 1), r);
      const walk = createThinInput(play.engine, ["Thin 1"], "random", random);
      for (let i = 0; i < 50; i++) {
        walk.update();
        const v = read();
        expect(Math.abs(v.x)).toBeLessThanOrEqual(1);
        expect([-1, 0, 1]).toContain(v.steps);
        expect([0, 1]).toContain(v.fire);
      }
      createThinInput(play.engine, ["Thin 1"], "zeros").update();
      expect(read()).toEqual({ x: 0, steps: 0, fire: 0 });
    } finally {
      play.stop();
    }
  });
});
