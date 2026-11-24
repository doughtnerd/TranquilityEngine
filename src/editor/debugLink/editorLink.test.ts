// The editor's debug link (ADR 0376) over loopback: builds from this machine are accepted at once and the first becomes
// the one the debuggers read; a build from another machine waits for the accept prompt, and a refused one isn't asked
// about again; choosing and disconnecting builds; listening off, unavailable, or refused by a taken address.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../../myco";
import { ToolConnector } from "../../engine/debugLink/client";
import { createTransport, type Transport, type TransportConnection } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { EnvelopeKind, encodeEnvelope, jsonPayload } from "../../engine/debugLink/protocol";
import { DebugLinkSession } from "../../engine/debugLink/session";
import { listenAddress, type DebugLinkPreferences } from "./debugLinkLogic";
import { EditorDebugLink } from "./editorLink";
import { decodePairCode, encodePairCode } from "../../engine/debugLink/pairing/code";
import "../../engine/net/transport/websocket";
import type { PlayBuild } from "./playBuild";
import { startDebugLink } from "../../engine/debugLink/host";
import { FakeNet, fakePeers, flushPeers } from "../../engine/debugLink/fakePeers.testSupport";
import { RendezvousServer } from "../../engine/debugLink/rendezvous/server";

let port = 9100;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** `inner`, with every connection reporting `remote` (a build on another machine). */
function remoteAs(inner: Transport, remote: string): Transport {
  const wrapped = new Map<TransportConnection, TransportConnection>();
  const wrap = (c: TransportConnection): TransportConnection => {
    let w = wrapped.get(c);
    if (!w) {
      w = { get id() { return c.id; }, remote, get state() { return c.state; }, send: (ch, d) => c.send(ch, d), close: (r) => c.close(r) };
      wrapped.set(c, w);
    }
    return w;
  };
  return { listen: (a) => inner.listen(a), connect: (a) => wrap(inner.connect(a)), poll: () => inner.poll().map((e) => ({ ...e, connection: wrap(e.connection) })), close: () => inner.close() };
}

async function editorLink(remote?: string) {
  const prefs: DebugLinkPreferences = { listen: true, lan: remote !== undefined, port: port++ };
  const link = new EditorDebugLink({ transport: () => (remote ? remoteAs(createTransport("loopback"), remote) : createTransport("loopback")), autoPoll: false });
  stops.push(() => link.stop());
  await link.apply(prefs);
  const builds: DebugLinkSession[] = [];
  const connect = (name: string) => {
    const t = createTransport("loopback");
    stops.push(() => t.close());
    const s = new DebugLinkSession({ transport: t, connection: t.connect(listenAddress(prefs)), hello: { name, platform: "web", topics: [] }, topics: new Map() });
    builds.push(s);
    return s;
  };
  const pump = () => {
    for (const b of builds) b.frameStart();
    link.poll();
    for (const b of builds) b.frameStart();
  };
  return { link, prefs, connect, pump };
}

describe("the editor's debug link", () => {
  it("accepts builds from this machine at once; the first is the one the debuggers read", async () => {
    const { link, connect, pump } = await editorLink();
    expect(link.state.value).toEqual({ kind: "listening", address: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/myco-debug$/) });
    const a = connect("A");
    const b = connect("B");
    pump();
    expect(link.builds.value.map((x) => x.name)).toEqual(["A", "B"]);
    expect(link.pending.value).toEqual([]);
    expect(link.active.value?.name).toBe("A");
    expect([a.state, b.state]).toEqual(["accepted", "accepted"]);
    link.choose(link.builds.value[1]!.id);
    expect(link.active.value?.name).toBe("B");
    link.choose(null);
    expect(link.active.value).toBeNull();
    link.choose(link.builds.value[1]!.id);
    link.disconnect(link.builds.value[1]!.id);
    expect(link.builds.value.map((x) => x.name)).toEqual(["A"]);
    expect(link.active.value?.name).toBe("A");
    pump();
    expect(b.state).toBe("closed");
  });

  it("asks before accepting a build from another machine", async () => {
    const { link, connect, pump } = await editorLink("192.168.1.30:50000");
    expect(link.state.value).toEqual({ kind: "listening", address: expect.stringMatching(/^ws:\/\/0\.0\.0\.0:/) });
    const a = connect("Remote");
    pump();
    expect(link.builds.value).toEqual([]);
    expect(link.pending.value.map((p) => [p.name, p.remote])).toEqual([["Remote", "192.168.1.30:50000"]]);
    expect(a.state).toBe("waiting");
    link.accept(link.pending.value[0]!.id);
    pump();
    expect(link.pending.value).toEqual([]);
    expect(link.active.value?.name).toBe("Remote");
    expect(a.state).toBe("accepted");
  });

  it("a refused build is turned away, and isn't asked about again when it reconnects", async () => {
    const { link, connect, pump } = await editorLink("192.168.1.31:50000");
    const first = connect("Nosy");
    pump();
    link.refuse(link.pending.value[0]!.id);
    pump();
    expect(first.state).toBe("closed");
    expect(link.pending.value).toEqual([]);
    const again = connect("Nosy");
    pump();
    pump();
    expect(link.pending.value).toEqual([]);
    expect(again.state).toBe("closed");
    const other = connect("Other game");
    pump();
    expect(link.pending.value.map((p) => p.name)).toEqual(["Other game"]);
    expect(other.state).toBe("waiting");
  });

  it("is off when listening is off, says when it can't listen, and when the port is taken", async () => {
    const off = new EditorDebugLink({ transport: () => createTransport("loopback"), autoPoll: false });
    stops.push(() => off.stop());
    await off.apply({ listen: false, lan: false, port: port++ });
    expect(off.state.value).toEqual({ kind: "off" });
    const browser = new EditorDebugLink({ transport: () => null, autoPoll: false });
    await browser.apply({ listen: true, lan: false, port: port++ });
    expect(browser.state.value).toEqual({ kind: "unavailable", why: expect.stringContaining("can't listen") });
    const { prefs } = await editorLink();
    const second = new EditorDebugLink({ transport: () => createTransport("loopback"), autoPoll: false });
    stops.push(() => second.stop());
    await second.apply(prefs);
    expect(second.state.value).toEqual({ kind: "unavailable", why: expect.stringContaining("Couldn't listen at") });
  });

  it("listening again (a preference changed) drops the builds of the old listener", async () => {
    const { link, prefs, connect, pump } = await editorLink();
    const a = connect("A");
    pump();
    expect(link.builds.value).toHaveLength(1);
    await link.apply({ ...prefs, port: port++ });
    expect(link.builds.value).toEqual([]);
    expect(link.active.value).toBeNull();
    pump();
    expect(a.state).toBe("closed");
  });

  it("says why when a build refuses what the editor sent and closes the link", async () => {
    const prefs: DebugLinkPreferences = { listen: true, lan: false, port: port++ };
    const logged: [string, string][] = [];
    const link = new EditorDebugLink({ transport: () => createTransport("loopback"), autoPoll: false, log: (kind, text) => logged.push([kind, text]) });
    stops.push(() => link.stop());
    await link.apply(prefs);
    // A build that speaks another protocol version, as a session answers one: an error for the link, then the close.
    const t = createTransport("loopback");
    stops.push(() => t.close());
    const c = t.connect(listenAddress(prefs));
    t.poll();
    c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.hello, topic: "", id: 0, payload: jsonPayload({ name: "Old game", platform: "web", topics: [] }) }));
    link.poll();
    expect(link.builds.value.map((b) => b.name)).toEqual(["Old game"]);
    c.send("reliable", encodeEnvelope({ kind: EnvelopeKind.error, topic: "", id: 0, payload: jsonPayload({ message: "the other end speaks debug link version 2; this one speaks 1" }) }));
    c.close("The build closed the debug link: the other end speaks debug link version 2; this one speaks 1");
    link.poll();
    expect(link.builds.value).toEqual([]);
    expect(logged).toEqual([["error", 'Debug link: "Old game" closed the link: the other end speaks debug link version 2; this one speaks 1']]);
  });
});

describe("the editor's Play on its link (servePlay)", () => {
  /** A link that serves Play over loopback, its play Engine, and a tool connecting from this machine. */
  async function playing(prefs: DebugLinkPreferences) {
    const link = new EditorDebugLink({ transport: () => createTransport("loopback"), autoPoll: false, playTransport: "loopback", playOptions: { log: () => {} } });
    stops.push(() => link.stop());
    await link.apply(prefs);
    const engine = await Engine.create({ headless: true });
    stops.push(() => engine.dispose());
    const tool = new ToolConnector(createTransport("loopback"), { kind: "native", name: "Audio Studio" });
    stops.push(() => tool.close());
    return { link, engine, tool };
  }
  const listening = async (build: PlayBuild) => {
    await vi.waitFor(() => expect(build.state.value.kind).toBe("serving"));
    return (build.state.value as { address: string }).address;
  };

  it("serves Play from the editor's port + 1 while it plays; a tool on this machine pairs with no code; stop closes it", async () => {
    const { link, engine, tool } = await playing({ listen: true, lan: false, port: 9600 });
    expect(link.play.value).toBeNull();
    const play = link.servePlay(engine, "Game (editor Play)");
    expect(link.play.value).not.toBeNull();
    expect(await listening(play)).toBe("ws://127.0.0.1:9601/myco-debug");
    const attempt = tool.connect("ws://127.0.0.1:9601/myco-debug");
    for (let i = 0; i < 3; i++) {
      tool.poll();
      engine.step(1 / 60);
      tool.poll();
    }
    expect(attempt.state).toBe("paired");
    expect(play.tools.value.map((t) => t.name)).toEqual(["Audio Studio"]);
    expect(link.builds.value).toEqual([]); // a tool paired with Play isn't a build of the editor's
    play.stop();
    tool.poll();
    expect(attempt.peer!.state).toBe("closed");
    expect(link.play.value).toBeNull();
    expect(play.state.value).toEqual({ kind: "stopped" });
  });

  it("follows the preferences: off says so, on again listens again, on the LAN by the new ones", async () => {
    const { link, engine } = await playing({ listen: false, lan: false, port: 9610 });
    const play = link.servePlay(engine, "Game (editor Play)");
    expect(play.state.value).toEqual({ kind: "unavailable", why: expect.stringContaining("debug link is off") });
    await link.apply({ listen: true, lan: true, port: 9620 });
    expect(await listening(play)).toBe("ws://0.0.0.0:9621/myco-debug");
    link.stop();
    expect(link.play.value).toBeNull();
    expect(play.state.value).toEqual({ kind: "stopped" });
  });
});

describe("the editor's own network addresses (the desktop shell's interface list)", () => {
  const lan = [{ address: "192.168.1.20", family: "IPv4" as const, internal: false }];

  it("Play shows a LAN code once the addresses are fetched, from the list fetched once", async () => {
    const fetches: number[] = [];
    const link = new EditorDebugLink({
      transport: () => createTransport("loopback"),
      autoPoll: false,
      playTransport: "loopback",
      playOptions: { log: () => {} },
      interfaces: async () => (fetches.push(1), lan),
    });
    stops.push(() => link.stop());
    await link.apply({ listen: true, lan: true, port: 7790 });
    const engine = await Engine.create({ headless: true });
    stops.push(() => engine.dispose());
    const play = link.servePlay(engine, "Game (editor Play)");
    expect(play.state.value).toEqual({ kind: "starting" });
    await vi.waitFor(() => expect(play.code.value).not.toBeNull());
    expect(decodePairCode(play.code.value!)).toMatchObject({ code: { kind: "address", octets: [1, 20] } });
    link.servePlay(engine, "Game (editor Play)"); // a replaced Play reuses the list
    await vi.waitFor(() => expect(link.play.value?.code.value).not.toBeNull());
    expect(fetches).toHaveLength(1);
  });

  it("a stopped Play is not started by a fetch that finishes later", async () => {
    let release!: (list: typeof lan) => void;
    const link = new EditorDebugLink({
      transport: () => createTransport("loopback"),
      autoPoll: false,
      playTransport: "loopback",
      playOptions: { log: () => {} },
      interfaces: () => new Promise((r) => (release = r)),
    });
    stops.push(() => link.stop());
    await link.apply({ listen: true, lan: true, port: 9710 });
    const engine = await Engine.create({ headless: true });
    stops.push(() => engine.dispose());
    const play = link.servePlay(engine, "Game (editor Play)");
    play.stop();
    release(lan);
    await new Promise((r) => setTimeout(r, 20));
    expect(link.play.value).toBeNull();
    expect(play.state.value).toEqual({ kind: "stopped" });
  });

  it("connect completes a code from them: the only candidate is on the machine's own network", async () => {
    vi.useFakeTimers();
    try {
      const link = new EditorDebugLink({ transport: () => null, autoPoll: false, interfaces: async () => [{ address: "10.5.0.3", family: "IPv4" }] });
      stops.push(() => link.stop());
      const code = encodePairCode({ kind: "address", octets: [1, 20], portOffset: 0, token: 5 });
      const result = link.connect({ code }).then(
        () => "paired",
        (e: Error) => String((e.cause as { message?: string } | undefined)?.message ?? e.message),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toContain("ws://10.5.1.20:7790/myco-debug");
    } finally {
      vi.useRealTimers();
    }
  });
});

// Rooms (ADR 0404, R5) through the editor's link: the reverse direction (the link offers a room, a build given its code
// joins and is admitted without a prompt), and room codes typed into connect.
describe("the editor link's rooms", () => {
  const PAGE = { protocol: "http:", hostname: "192.168.1.20", port: "3000" };

  async function roomWorld(page: typeof PAGE | null = PAGE) {
    let t = 1000;
    let seed = 0;
    const now = () => t;
    const randomToken = (bits: number) => (++seed * 104_729) % 2 ** bits;
    const server = new RendezvousServer({ transport: createTransport("loopback", { now }), now });
    await server.listen("ws://192.168.1.20:3000/myco-rendezvous");
    stops.push(() => server.close());
    const PeerConnection = fakePeers(new FakeNet());
    const link = new EditorDebugLink({
      transport: () => null,
      autoPoll: false,
      interfaces: async () => [],
      rooms: { signalTransport: "loopback", signalOptions: { now }, webrtc: { PeerConnection }, page, now, randomToken },
    });
    stops.push(() => link.stop());
    await link.apply({ listen: true, lan: false, port: port++ });
    const engine = await Engine.create({ headless: true });
    stops.push(() => engine.dispose());
    const pump = async (done: () => boolean) => {
      for (let i = 0; i < 300; i++) {
        server.poll();
        link.poll();
        engine.step(1 / 60);
        await flushPeers();
        if (done()) return true;
        t += 10;
      }
      return false;
    };
    return { link, engine, pump, now, PeerConnection };
  }

  it("offers a room; a build given its code joins and is admitted without a prompt", async () => {
    const { link, engine, pump, now, PeerConnection } = await roomWorld();
    const offered = link.offerRoom();
    expect(offered.state.value).toEqual({ kind: "opening" });
    expect(await pump(() => offered.code.value !== null)).toBe(true);
    expect(offered.state.value).toEqual({ kind: "waiting", code: offered.code.value });
    expect(decodePairCode(offered.code.value!)).toMatchObject({ code: { kind: "room", rendezvous: { octets: [1, 20], port: 3000 } } });

    const handle = (await startDebugLink(engine, {
      debug: {},
      name: "Joining game",
      code: offered.code.value,
      kind: "page-http",
      page: { protocol: "http:", hostname: "192.168.1.30", port: "8080" },
      transport: "loopback",
      transportOptions: { now },
      webrtc: { PeerConnection },
      log: () => {},
    }))!;
    stops.push(() => handle.close());
    expect(await pump(() => link.builds.value.length === 1)).toBe(true);
    expect(link.builds.value[0]!.name).toBe("Joining game");
    expect(link.pending.value).toEqual([]);

    offered.stop();
    expect(offered.state.value.kind).toBe("unavailable");
    expect(offered.code.value).toBeNull();
  });

  it("says why it can't offer a room (a page on https with no hosted rendezvous)", async () => {
    const { link } = await roomWorld({ protocol: "https:", hostname: "studio.example", port: "" });
    const offered = link.offerRoom();
    expect(offered.state.value.kind).toBe("unavailable");
    expect((offered.state.value as { why: string }).why).toContain("hosted rendezvous");
  });

  it("connect refuses a hosted room code until a hosted rendezvous is set", async () => {
    const { link } = await roomWorld();
    const code = encodePairCode({ kind: "room", rendezvous: null, room: 3, token: 4 });
    const err = await link.connect({ code }).then(() => null, (e: Error) => e);
    expect((err?.cause as { kind: string }).kind).toBe("needs-rendezvous");
    expect(err?.message).toContain("Settings > Debug link");
  });
});
