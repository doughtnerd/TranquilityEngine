// A build's debug link on a headless Engine (ADR 0376), over loopback (which listens at any address, here the link's
// WebSocket URL): it loads the registered topics, connects out and says which it serves, applies a tool's commands at
// the next frame start (before the World's scripts run), tries again while the tool isn't listening, and closes with the
// Engine.
import { afterEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject } from "../../myco";
import { createTransport } from "../net/Transport";
import "../net/transport/loopback";
import { DebugLinkListener, type DebugLinkPeer } from "./client";
import { RECONNECT_SECONDS, startDebugLink } from "./host";
import { registerDebugTopic, type DebugTopic } from "./topics";

const log: string[] = [];

class Ticker extends GameBehavior {
  update(): void {
    log.push("script update");
  }
}

let n = 0;
const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  log.length = 0;
});

async function setup(options: { listen?: boolean; override?: string } = {}) {
  const topic: DebugTopic = {
    subscribe: () => ({ refused: "no" }),
    command: (name, params) => void log.push(`command ${name} ${JSON.stringify(params)}`),
    dispose: () => void log.push("topic disposed"),
  };
  undo.push(registerDebugTopic("test", async () => () => topic));
  undo.push(registerDebugTopic("broken", async () => { throw new Error("won't load"); }));
  const address = `ws://debug-host-${++n}:7790/myco-debug`;
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  const peers: DebugLinkPeer[] = [];
  const listener = new DebugLinkListener(createTransport("loopback"), { onPeer: (p) => peers.push(p) });
  undo.push(() => listener.close());
  if (options.listen !== false) await listener.listen(address);
  const lines: string[] = [];
  const handle = (await startDebugLink(engine, { debug: { link: options.override ? "ws://elsewhere:1/" : address }, override: options.override ?? null, name: "Headless", transport: "loopback", log: (l) => lines.push(l) }))!;
  return { engine, listener, peers, handle, lines, address };
}

describe("startDebugLink", () => {
  it("does nothing for a build without debug", async () => {
    const engine = await Engine.create({ headless: true });
    undo.push(() => engine.dispose());
    expect(await startDebugLink(engine, { debug: undefined, name: "x", transport: "loopback" })).toBeNull();
  });

  it("connects out with the topics that loaded, and applies a command at the next frame start, before the scripts", async () => {
    const { engine, listener, peers, handle, lines, address } = await setup();
    expect(handle.address).toBe(address);
    expect(lines).toEqual(['[myco] debug link: the "broken" topic didn\'t load (won\'t load).']);
    GameObject.create("ticker").addBehavior(Ticker);
    engine.step(1 / 60);
    listener.poll();
    expect(peers.map((p) => [p.hello.name, p.hello.platform])).toEqual([["Headless", "web"]]);
    expect(peers[0]!.hello.topics).toContain("test"); // and the active plugins' (the test setup's animation)
    expect(peers[0]!.hello.topics).not.toContain("broken");
    peers[0]!.accept();
    engine.step(1 / 60);
    expect(handle.state).toBe("accepted");
    log.length = 0;
    peers[0]!.command("test", "set", { speed: 2 });
    expect(log).toEqual([]);
    engine.step(1 / 60);
    expect(log).toEqual(['command set {"speed":2}', "script update"]);
  });

  it("takes the launch override's address", async () => {
    const address = `ws://debug-host-${n + 1}:7790/myco-debug`;
    const { handle } = await setup({ override: address });
    expect(handle.address).toBe(address);
    expect(handle.state).not.toBe("closed");
  });

  it("tries again every few seconds of frames until the tool listens", async () => {
    const { engine, listener, peers, address } = await setup({ listen: false });
    engine.step(1 / 60);
    listener.poll();
    expect(peers).toEqual([]);
    await listener.listen(address);
    for (let t = 0; t < RECONNECT_SECONDS - 0.5; t += 0.25) engine.step(0.25);
    listener.poll();
    expect(peers).toEqual([]);
    for (let i = 0; i < 4; i++) engine.step(0.25);
    listener.poll();
    expect(peers).toHaveLength(1);
  });

  it("closes with the Engine: the tool sees it go and the topics are disposed", async () => {
    const { engine, listener, peers } = await setup();
    engine.step(1 / 60);
    listener.poll();
    peers[0]!.accept();
    engine.dispose();
    listener.poll();
    expect(peers[0]!.state).toBe("closed");
    expect(log).toContain("topic disposed");
  });
});
