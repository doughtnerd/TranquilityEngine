import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, defineInput, defineSystem, f32, i32, u8, type BootstrapConfig, type BootstrapSetting, type ProjectSettingsInput } from "../engine";
import { World } from "../engine/core/World";
import { engineWorld, netWorldInfo, worldViewStates } from "../engine/editor";
import { netSession } from "../engine/net/session";
import type { LoopbackTransport } from "../engine/net/transport/loopback";
import { NetStatsSampler, byCategory, clampConditions, clientLayout, createThinInput, ghostTypeLabel, hostLayout, playBootstrap, trafficCategory, withConditions, playWorldSources } from "./netPlay";
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

  it("plays a lobby's layout (ADR 0068) as it is: the lobby makes the match Worlds, not Play", () => {
    const pirates = (JSON.parse(readFileSync(fileURLToPath(new URL("../../samples/pirates/project.json", import.meta.url)), "utf8")) as { bootstrap: BootstrapConfig }).bootstrap;
    expect(hostLayout(pirates)).toBeNull();
    expect(playBootstrap(pirates, { clients: 2, thin: 1 })).toBeNull();
  });
});

describe("the play bootstrap for the Host pattern (a server template created at runtime)", () => {
  /** samples/arena's bootstrap: one client World on a menu, a Server template and a second client template. */
  const ARENA = (JSON.parse(readFileSync(fileURLToPath(new URL("../../samples/arena/project.json", import.meta.url)), "utf8")) as { bootstrap: BootstrapConfig }).bootstrap;

  it("creates the server template as a World and links N clients and T thin clients to it, loading the server's scenes", () => {
    const layout = hostLayout(ARENA)!;
    expect(layout.client.name).toBe("Client");
    expect(layout.server).toEqual({ name: "Server", tags: ["server"], renders: false, input: false, scenes: ["scenes/arena.scene.json"] });
    const play = playBootstrap(ARENA, { clients: 2, thin: 1 })!;
    expect(play.pattern).toBe("host");
    expect(play.server).toBe("Server");
    expect(play.template).toBe("Client");
    expect(play.clients).toEqual(["Client 1", "Client 2"]);
    expect(play.thin).toEqual(["Thin 1"]);
    expect(play.bootstrap.worlds).toEqual([
      { name: "Client 1", tags: ["client"], scenes: ["scenes/arena.scene.json"] },
      { name: "Client 2", tags: ["client"], scenes: ["scenes/arena.scene.json"] },
      { name: "Thin 1", tags: ["client"], scenes: ["scenes/arena.scene.json"], renders: false, input: false },
      { name: "Server", tags: ["server"], renders: false, input: false, scenes: ["scenes/arena.scene.json"] },
    ]);
    expect(play.bootstrap.links).toEqual(["Client 1", "Client 2", "Thin 1"].map((from) => ({ from, to: "Server", transport: "loopback" })));
    // The templates stay, so the game's own Engine.createWorld("Client 2") still works.
    expect(play.bootstrap.templates).toEqual(ARENA.templates);
  });

  it("keeps the project's links to Spawnable Worlds that no copy took the name of (ADR 0062)", () => {
    const play = playBootstrap(ARENA, { clients: 1, thin: 0 })!;
    expect(play.bootstrap.links).toEqual([
      { from: "Client 1", to: "Server", transport: "loopback" },
      { from: "Client 2", to: "Server", transport: "loopback" }, // the HUD's second local player
    ]);
  });

  it("keeps the clients' own scenes (the menu) when asked, and other Worlds in place", () => {
    const setting: BootstrapConfig = { ...ARENA, worlds: [{ name: "Tools", tags: ["local"] }, ...ARENA.worlds] };
    const play = playBootstrap(setting, { clients: 1, thin: 0, clientScenes: "own" })!;
    expect(play.bootstrap.worlds.map((w) => [w.name, w.scenes])).toEqual([
      ["Tools", undefined],
      ["Client 1", ["scenes/main.scene.json"]],
      ["Server", ["scenes/arena.scene.json"]],
    ]);
  });

  it("names the server World as its template does, and keeps names unique", () => {
    const setting: BootstrapConfig = { worlds: [{ name: "Menu" }, { name: "Client 1", tags: ["local"] }], templates: { Host: { name: "Match", tags: ["server"] } } };
    const play = playBootstrap(setting, { clients: 1, thin: 1 })!;
    expect(play.server).toBe("Match");
    expect(play.template).toBe("Menu"); // no client-tagged World: the first one
    expect(play.bootstrap.worlds.map((w) => w.name)).toEqual(["Client 1 2", "Thin 1", "Client 1", "Match"]);
  });

  it("isn't used when the bootstrap has links, a server World, or no server template", () => {
    expect(hostLayout({ worlds: [{ name: "A", tags: ["client"] }], templates: { B: { tags: ["client"] } } })).toBeNull();
    expect(hostLayout({ worlds: [{ name: "A" }, { name: "S", tags: ["server"] }], templates: { T: { tags: ["server"] } } })).toBeNull();
    expect(hostLayout({ worlds: [{ name: "A" }, { name: "B" }], links: [{ from: "A", to: "B", transport: "loopback" }], templates: { T: { tags: ["server"] } } })).toBeNull();
    // Links naming Spawnable Worlds (ADR 0062) don't rule the pattern out.
    expect(hostLayout({ worlds: [{ name: "A" }], links: [{ from: "A", to: "T", transport: "loopback" }], templates: { T: { tags: ["server"] } } })).not.toBeNull();
    expect(playBootstrap({ worlds: [{ name: "A" }] }, { clients: 2, thin: 0 })).toBeNull();
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
      peers: [
        {
          id: 1,
          state: "open" as const,
          remote: "r",
          rtt: 5,
          sent: traffic(bytes),
          received: traffic(bytes / 2),
          snapshotBytes: 20,
          ghosts: 1,
          inputs: [],
          ghostTypes: [
            { type: "prefabs/player.prefab.json", bytes: bytes / 2 },
            ...(bytes > 100 ? [{ type: "scenes/arena.scene.json#flag", bytes: 10 }] : []),
          ],
        },
      ],
    });
    const sampler = new NetStatsSampler();
    expect(sampler.sample([world(100)], 0)[0].peers[0].out.bytesPerSecond).toBe(0);
    const later = sampler.sample([world(600)], 500)[0].peers[0];
    expect(later.out.bytesPerSecond).toBe(1000);
    expect(later.in.bytesPerSecond).toBe(500);
    expect(later.out.byCategory.snapshots).toBe(1000);
    // Bandwidth per ghost type: the player prefab went from 50 to 300 bytes in half a second; the flag appeared with 10.
    expect(later.ghostTypeRates).toEqual([
      { type: "prefabs/player.prefab.json", bytes: 300, bytesPerSecond: 500 },
      { type: "scenes/arena.scene.json#flag", bytes: 10, bytesPerSecond: 20 },
    ]);
    expect(later.ghostTypeRates.map((t) => ghostTypeLabel(t.type))).toEqual(["player", "arena#flag"]);
    expect(ghostTypeLabel("prefabs/units/tank.prefab.json › turret")).toBe("tank › turret");
  });

  it("puts conditions in loopback links' options (and WebSocket ones, loopback in a page), so links simulate them from the handshake", () => {
    const config: BootstrapConfig = {
      worlds: [{ name: "Client" }, { name: "Server" }, { name: "Remote" }],
      links: [
        { from: "Client", to: "Server", transport: "loopback", options: { address: "a", latencyMs: 5 } },
        { from: "Remote", to: "Server", transport: "websocket", options: { url: "ws://x" } },
        { from: "Client", to: "Server", transport: "custom" },
      ],
    };
    const out = withConditions(config, { latencyMs: 120, jitterMs: 4, lossPercent: 10 }) as BootstrapConfig;
    expect(out.links![0].options).toEqual({ address: "a", latencyMs: 120, jitterMs: 4, loss: 0.1 });
    // In a page, a WebSocket link between two of its Worlds runs over loopback (ADR 0102).
    expect(out.links![1].options).toEqual({ url: "ws://x", latencyMs: 120, jitterMs: 4, loss: 0.1 });
    expect(out.links![2]).toBe(config.links![2]);
    expect(withConditions(config, null)).toBe(config);
    expect(withConditions("scripts/boot.ts", { latencyMs: 1, jitterMs: 0, lossPercent: 0 })).toBe("scripts/boot.ts");
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

/** A game system that writes the keyboard into `Drive` every tick, as samples/arena's `arena.ReadInput` does (zeros without input). */
defineSystem({
  name: "test.netplay.WriteKeyboard",
  phase: "fixedUpdate",
  worlds: ["keyboard-writer"],
  run() {
    Drive.write({ x: 0, steps: 0, fire: 0 });
  },
});

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

  it("plays the Host pattern: the server template becomes a World, clients join over loopback, thin clients' input beats the game's own writes", async () => {
    // Like samples/arena: one client World, a server template the game would create at runtime,
    // and a system that writes the keyboard into the input stream every tick (zeros without input).
    const HOST: BootstrapConfig = {
      worlds: [{ name: "Client", tags: ["client", "keyboard-writer"] }],
      templates: { Server: { tags: ["server"], renders: false, input: false } },
    };
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(HOST), netPlay: { clients: 1, thin: 1, thinInput: "random" } });
    try {
      expect(play.netPlay?.pattern).toBe("host");
      expect(play.engine.worlds().map((w) => w.name)).toEqual(["Client 1", "Thin 1", "Server"]);
      let r = 0.3;
      const thin = createThinInput(play.engine, ["Thin 1"], "random", () => ((r = (r * 9301 + 0.49297) % 1), r));
      for (let i = 0; i < 90; i++) {
        thin.update();
        play.engine.step(frame);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const server = engineWorld(play.engine, "Server")!;
      const session = netSession(server)!;
      expect(session.allPeers().filter((p) => p.state === "open")).toHaveLength(2);
      // The server reads the thin client's synthetic input, not the zeros the game wrote over it.
      const seen = session.allPeers().map((p) => World._runIn(server, () => (p.node ? Drive.of(p.node) : null)));
      expect(seen.some((v) => v !== null && v.x !== 0)).toBe(true);
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
      play.setConditions({ latencyMs: 0, jitterMs: 0, lossPercent: 0 }); // Off
      expect(conditions()).toEqual(Array(3).fill({ latencyMs: 0, jitterMs: 0, loss: 0 }));
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

describe("playWorldSources", () => {
  it("maps Play's client copies to the project World they copy, for the Worlds panel's live arrows", () => {
    const sources = playWorldSources({ clients: ["Client 1", "Client 2"], thin: ["Thin 1"], template: "Client" });
    expect([...sources]).toEqual([
      ["Client 1", "Client"],
      ["Client 2", "Client"],
      ["Thin 1", "Client"],
    ]);
  });
});
