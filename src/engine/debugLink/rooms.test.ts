// Room codes (ADR 0404; plan task R5) over a loopback rendezvous and the fake peer pair, on one injected clock: a page
// build offers a room and shows its code, a tool joins by the code and pairs (the rendezvous checks the token, then the
// build's gate); a wrong token is refused; a room expires and the next code replaces it; the reverse direction (a tool
// offers, a build given `?debug-code=` joins); a hosted code with no hosted rendezvous is refused; where a page opens
// its room (`roomPlace`) for each kind of page.
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../myco";
import { createTransport } from "../net/Transport";
import "../net/transport/loopback";
import { DebugLinkListener, ToolConnector, type ConnectAttempt, type DebugLinkPeer } from "./client";
import { FakeNet, fakePeers, flushPeers } from "./fakePeers.testSupport";
import { startBuildListener, startDebugLink } from "./host";
import { decodePairCode, encodePairCode, type RoomPairCode } from "./pairing/code";
import { TokenGate } from "./pairing/gate";
import { RendezvousServer } from "./rendezvous/server";
import { ROOM_EXPIRY_MS } from "./rendezvous/protocol";
import {
  LOOPBACK_ROOM_NOTICE,
  RoomJoinTransport,
  RoomOffer,
  joinCandidates,
  joinPath,
  joinRefusalMessage,
  roomAddress,
  roomPlace,
  roomTokenBits,
  type PageLocation,
} from "./rooms";
import { registerDebugTopic } from "./topics";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
});

const PAGE: PageLocation = { protocol: "http:", hostname: "192.168.1.20", port: "3000" };
const RENDEZVOUS = "ws://192.168.1.20:3000/myco-rendezvous";
const TOOL_LAN = [{ address: "192.168.7.9", family: "IPv4" as const }];

/** One clock, a never-repeating random source, a rendezvous on the page's server, and the fake peer network. */
async function world(rendezvousAt = RENDEZVOUS) {
  let t = 1000;
  let seed = 0;
  const now = () => t;
  const randomToken = (bits: number) => (++seed * 104_729) % 2 ** bits;
  const server = new RendezvousServer({ transport: createTransport("loopback", { now }), now });
  await server.listen(rendezvousAt);
  undo.push(() => server.close());
  const PeerConnection = fakePeers(new FakeNet());
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  undo.push(registerDebugTopic("counter", async () => () => ({ subscribe: () => ({ refused: "no" }), request: (method: string) => ({ method }) })));
  const extra: (() => void)[] = [];
  /** Polls everything (the rendezvous, the Engine's frame, whatever else is given) until `done`, or gives up. */
  const pump = async (done: () => boolean, rounds = 300): Promise<boolean> => {
    for (let i = 0; i < rounds; i++) {
      server.poll();
      engine.step(1 / 60);
      for (const e of extra) e();
      await flushPeers();
      if (done()) return true;
      t += 10;
    }
    return false;
  };
  const signal = () => createTransport("loopback", { now });
  return { now, step: (ms: number) => void (t += ms), randomToken, server, PeerConnection, engine, pump, extra, signal };
}

type World = Awaited<ReturnType<typeof world>>;

async function pageBuild(w: World, page: PageLocation = PAGE, debug: Record<string, unknown> = { listen: true }) {
  const lines: string[] = [];
  const build = (await startBuildListener(w.engine, {
    debug,
    name: "Page game",
    kind: "page-http",
    page,
    transport: "loopback",
    transportOptions: { now: w.now },
    webrtc: { PeerConnection: w.PeerConnection },
    now: w.now,
    randomToken: w.randomToken,
    log: (l) => lines.push(l),
  }))!;
  undo.push(() => build.close());
  return { build, lines };
}

function tool(w: World) {
  const transport = new RoomJoinTransport({ kind: "native", signalTransport: w.signal, webrtc: { PeerConnection: w.PeerConnection } });
  const peers: DebugLinkPeer[] = [];
  const connector = new ToolConnector(transport, { kind: "native", name: "Studio", events: { onPeer: (p) => peers.push(p) } });
  undo.push(() => connector.close());
  w.extra.push(() => connector.poll());
  /** Joins the room `code` names (its first candidate from this tool's networks). */
  const join = (code: string): { attempt: ConnectAttempt; address: string } => {
    const read = decodePairCode(code);
    if (!("code" in read) || read.code.kind !== "room") throw new Error(`not a room code: ${code}`);
    const room = read.code;
    const address = roomAddress(joinCandidates(room, { kind: "native", interfaces: TOOL_LAN }, null)[0]!, room.room, room.token);
    return { attempt: connector.connect(address, room.token), address };
  };
  return { transport, connector, peers, join };
}

const settled = (a: ConnectAttempt) => () => a.state === "paired" || a.state === "failed" || a.state === "refused";

/** The same code with another token. */
function otherToken(code: string): string {
  const read = decodePairCode(code) as { code: RoomPairCode };
  return encodePairCode({ ...read.code, token: (read.code.token + 1) % 2 ** 20 });
}

describe("a page build offers a room", () => {
  it("shows a LAN room code for its own server, and a tool joining by it pairs and gets answers", async () => {
    const w = await world();
    const { build } = await pageBuild(w);
    expect(build.code).toBeNull();
    expect(build.notice).toBe("Opening a pairing room…");
    expect(await w.pump(() => build.code !== null)).toBe(true);
    expect(build.notice).toBeNull();
    expect(build.lan).toBe(true);
    expect(build.address).toBe(RENDEZVOUS);
    const read = decodePairCode(build.code!) as { code: RoomPairCode };
    expect(read.code.kind).toBe("room");
    expect(read.code.rendezvous).toEqual({ octets: [1, 20], port: 3000 });
    expect(read.code.token).toBe(build.token!.token);

    const first = build.code!;
    const t = tool(w);
    const { attempt } = t.join(first);
    expect(await w.pump(settled(attempt))).toBe(true);
    expect(attempt.state).toBe("paired");
    expect(t.peers[0]!.hello.name).toBe("Page game");
    let answer: unknown = null;
    void t.peers[0]!.request("counter", "ping").then((a) => (answer = a));
    expect(await w.pump(() => answer !== null)).toBe(true);
    expect(answer).toEqual({ method: "ping" });
    expect(build.tools).toEqual([{ name: "Studio", kind: "native", remote: expect.any(String) }]);

    // The room was single use: the next one opens with the gate's next token, so the overlay shows a new code.
    expect(await w.pump(() => build.code !== null && build.code !== first)).toBe(true);
    expect(w.server.roomCount).toBe(1);
  });

  it("refuses a wrong token at the rendezvous, and the build keeps its code", async () => {
    const w = await world();
    const { build } = await pageBuild(w);
    await w.pump(() => build.code !== null);
    const code = build.code!;
    const t = tool(w);
    const { attempt, address } = t.join(otherToken(code));
    expect(await w.pump(settled(attempt))).toBe(true);
    expect(attempt.state).toBe("failed");
    expect(t.transport.refusal(address)).toBe("bad-token");
    expect(build.tools).toEqual([]);
    expect(build.code).toBe(code);
  });

  it("opens a new room when the room expires; the old code finds no room", async () => {
    const w = await world();
    const { build } = await pageBuild(w);
    await w.pump(() => build.code !== null);
    const old = build.code!;
    w.step(ROOM_EXPIRY_MS + 1);
    expect(await w.pump(() => build.code !== null && build.code !== old)).toBe(true);
    const t = tool(w);
    const { attempt, address } = t.join(old);
    expect(await w.pump(settled(attempt))).toBe(true);
    expect(attempt.state).toBe("failed");
    expect(t.transport.refusal(address)).toBe("no-room");
  });

  it("from localhost: a code a tool on this machine joins, with the note to open the page by its address", async () => {
    const w = await world("ws://127.0.0.1:3000/myco-rendezvous");
    const { build, lines } = await pageBuild(w, { protocol: "http:", hostname: "127.0.0.1", port: "3000" });
    await w.pump(() => build.code !== null);
    expect(build.notice).toBe(LOOPBACK_ROOM_NOTICE);
    expect(lines).toContain(`[myco] debug link: ${LOOPBACK_ROOM_NOTICE}`);
    const room = (decodePairCode(build.code!) as { code: RoomPairCode }).code;
    const urls = joinCandidates(room, { kind: "native", interfaces: TOOL_LAN }, null);
    expect(urls).toEqual(["ws://192.168.0.1:3000/myco-rendezvous", "ws://127.0.0.1:3000/myco-rendezvous"]);
    const t = tool(w);
    const attempt = t.connector.connect(roomAddress(urls[1]!, room.room, room.token), room.token);
    expect(await w.pump(settled(attempt))).toBe(true);
    expect(attempt.state).toBe("paired");
  });

  it("can't make a room on https without a hosted rendezvous, and says why", async () => {
    const w = await world();
    const { build, lines } = await pageBuild(w, { protocol: "https:", hostname: "game.example", port: "" });
    expect(build.code).toBeNull();
    expect(build.notice).toContain("hosted rendezvous");
    expect(lines.some((l) => l.includes("no pairing room"))).toBe(true);
  });
});

describe("a tool offers a room (the reverse direction)", () => {
  it("a build given the room code joins it and is let in by its token", async () => {
    const w = await world();
    const place = roomPlace("page-http", PAGE, null);
    if (place.kind === "none") throw new Error(place.message);
    const gate = new TokenGate({ now: w.now, randomToken: w.randomToken, tokenBits: roomTokenBits(place) });
    const offer = new RoomOffer({ place, gate, kind: "page-http", signalTransport: w.signal, webrtc: { PeerConnection: w.PeerConnection }, now: w.now, randomRoom: w.randomToken });
    const peers: DebugLinkPeer[] = [];
    const listener = new DebugLinkListener(offer, { onPeer: (p) => peers.push(p) }, { gate, sameMachine: () => false });
    undo.push(() => listener.close());
    await listener.listen(place.url);
    w.extra.push(() => listener.poll());
    expect(await w.pump(() => offer.code !== null)).toBe(true);

    const handle = (await startDebugLink(w.engine, {
      debug: { link: "ws://elsewhere:7790/myco-debug" },
      name: "Joining game",
      code: offer.code,
      kind: "page-http",
      page: { protocol: "http:", hostname: "192.168.1.30", port: "8080" },
      transport: "loopback",
      transportOptions: { now: w.now },
      webrtc: { PeerConnection: w.PeerConnection },
      log: () => {},
    }))!;
    undo.push(() => handle.close());
    expect(handle.address).toBe(RENDEZVOUS);
    expect(await w.pump(() => handle.state === "accepted")).toBe(true);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.admission).toBe("token");
    expect(peers[0]!.hello.name).toBe("Joining game");
  });

  it("a build given a wrong room token stops, saying the room refused it", async () => {
    const w = await world();
    const place = roomPlace("page-http", PAGE, null);
    if (place.kind === "none") throw new Error(place.message);
    const gate = new TokenGate({ now: w.now, randomToken: w.randomToken, tokenBits: roomTokenBits(place) });
    const offer = new RoomOffer({ place, gate, kind: "page-http", signalTransport: w.signal, webrtc: { PeerConnection: w.PeerConnection }, now: w.now, randomRoom: w.randomToken });
    const listener = new DebugLinkListener(offer, {}, { gate, sameMachine: () => false });
    undo.push(() => listener.close());
    await listener.listen(place.url);
    w.extra.push(() => listener.poll());
    await w.pump(() => offer.code !== null);
    const lines: string[] = [];
    const handle = (await startDebugLink(w.engine, {
      debug: {},
      name: "Joining game",
      code: otherToken(offer.code!),
      kind: "page-http",
      page: PAGE,
      transport: "loopback",
      transportOptions: { now: w.now },
      webrtc: { PeerConnection: w.PeerConnection },
      log: (l) => lines.push(l),
    }))!;
    undo.push(() => handle.close());
    expect(await w.pump(() => lines.some((l) => l.includes("refused the code (bad-token)")))).toBe(true);
    expect(listener.peers).toHaveLength(0);
  });
});

describe("hosted room codes", () => {
  const hostedCode = (): RoomPairCode => ({ kind: "room", rendezvous: null, room: 9, token: 12345 });

  it("are refused with a clear message when no hosted rendezvous is configured", async () => {
    expect(joinPath("page-http", hostedCode(), null)).toEqual({ path: "unreachable", reason: "needs-rendezvous" });
    expect(joinRefusalMessage("needs-rendezvous", hostedCode(), "tool")).toContain("no hosted rendezvous is configured");
    const w = await world();
    const lines: string[] = [];
    const handle = await startDebugLink(w.engine, { debug: {}, name: "g", code: encodePairCode(hostedCode()), kind: "page-http", page: PAGE, webrtc: { PeerConnection: w.PeerConnection }, log: (l) => lines.push(l) });
    expect(handle).toBeNull();
    expect(lines.join("\n")).toContain("game.json's debug.rendezvous");
  });

  it("go through the configured one", () => {
    expect(joinPath("page-http", hostedCode(), "wss://rv.example/myco-rendezvous")).toEqual({ path: "webrtc", rendezvous: "hosted" });
    expect(joinCandidates(hostedCode(), { kind: "page", host: "localhost" }, "wss://rv.example/myco-rendezvous")).toEqual(["wss://rv.example/myco-rendezvous"]);
    // A page on https can't open ws://, even to a hosted rendezvous.
    expect(joinPath("page-https", hostedCode(), "ws://rv.example/myco-rendezvous")).toEqual({ path: "unreachable", reason: "needs-hosted-rendezvous" });
  });
});

describe("roomPlace", () => {
  const hosted = "wss://rv.example/myco-rendezvous";
  it("a page on http by its LAN address: its own server", () => {
    expect(roomPlace("page-http", PAGE, hosted)).toEqual({ kind: "lan", url: RENDEZVOUS, location: { octets: [1, 20], port: 3000 }, loopbackOnly: false, notice: null });
  });
  it("from localhost: the hosted rendezvous when there is one, else its own server for this machine only", () => {
    const local: PageLocation = { protocol: "http:", hostname: "localhost", port: "8080" };
    expect(roomPlace("page-http", local, hosted)).toEqual({ kind: "hosted", url: hosted, notice: null });
    expect(roomPlace("page-http", local, null)).toEqual({ kind: "lan", url: "ws://localhost:8080/myco-rendezvous", location: { octets: [0, 1], port: 8080 }, loopbackOnly: true, notice: LOOPBACK_ROOM_NOTICE });
  });
  it("a port no code names: the hosted rendezvous, else a sentence naming the ports", () => {
    const odd: PageLocation = { ...PAGE, port: "5173" };
    expect(roomPlace("page-http", odd, hosted).kind).toBe("hosted");
    const none = roomPlace("page-http", odd, null);
    expect(none.kind === "none" && none.message).toContain("port 5173");
  });
  it("a page on https: only a wss:// hosted rendezvous", () => {
    const https: PageLocation = { protocol: "https:", hostname: "game.example", port: "" };
    expect(roomPlace("page-https", https, hosted).kind).toBe("hosted");
    expect(roomPlace("page-https", https, "ws://rv.example/myco-rendezvous").kind).toBe("none");
    expect(roomPlace("page-https", https, null).kind).toBe("none");
  });
  it("no WebRTC: none", () => {
    const none = roomPlace("page-http", PAGE, hosted, false);
    expect(none.kind === "none" && none.message).toContain("WebRTC");
  });
});
