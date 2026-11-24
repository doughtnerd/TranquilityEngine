// The connect flow (ADR 0403 "Pairing code") through `connectToBuild`: a real `ToolConnector` on the loopback transport
// against a listening build on a headless Engine, on one injected clock (`waitFor` polls by hand, never wall time).
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../../myco";
import { createTransport } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { ToolConnector, type DebugLinkPeer } from "../../engine/debugLink/client";
import { startBuildListener } from "../../engine/debugLink/host";
import { decodePairCode, encodePairCode, type RoomPairCode } from "../../engine/debugLink/pairing/code";
import { TOKEN_EXPIRY_MS } from "../../engine/debugLink/pairing/gate";
import { pairRefusalMessage } from "../../engine/debugLink/protocol";
import { FakeNet, fakePeers, flushPeers } from "../../engine/debugLink/fakePeers.testSupport";
import { RendezvousServer } from "../../engine/debugLink/rendezvous/server";
import { ROOM_EXPIRY_MS } from "../../engine/debugLink/rendezvous/protocol";
import { RoomJoinTransport } from "../../engine/debugLink/rooms";
import { NO_ROOM_MESSAGE, connectToBuild, type ConnectFailure, type ConnectHost, type ConnectTarget } from "./connectFlow";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
});

const BUILD_LAN = [{ address: "192.168.1.20", family: "IPv4" as const }];
const BUILD_URL = "ws://192.168.1.20:7790/myco-debug";

async function setup(debug: Record<string, unknown> = { listen: true, lan: true }, sameMachine = false) {
  let t = 1000;
  let seed = 0;
  const now = () => t;
  const engine = await Engine.create({ headless: true });
  undo.push(() => engine.dispose());
  const build = (await startBuildListener(engine, {
    debug,
    name: "Listening game",
    transport: "loopback",
    transportOptions: { now },
    interfaces: () => BUILD_LAN,
    sameMachine: () => sameMachine,
    now,
    randomToken: (bits) => (++seed * 104_729) % 2 ** bits,
    log: () => {},
  }))!;
  undo.push(() => build.close());
  const peers: DebugLinkPeer[] = [];
  const tool = new ToolConnector(createTransport("loopback", { now }), { kind: "native", name: "Editor", events: { onPeer: (p) => peers.push(p) } });
  undo.push(() => tool.close());
  const tried: string[] = [];
  const timeouts: number[] = [];
  /** The loopback has no network: the urls in `reaches` go to where the build really listens, others reach nothing. */
  const connectorFor = (reaches: readonly string[]): ToolConnector =>
    ({
      connect: (url: string, token?: number) => {
        tried.push(token === undefined ? `${url} (no token)` : url);
        return tool.connect(reaches.includes(url) ? build.address : url, token);
      },
    }) as unknown as ToolConnector;
  const host = (over: Partial<ConnectHost> & { reaches?: readonly string[] } = {}): ConnectHost => {
    const { reaches, ...rest } = over;
    return {
      connector: connectorFor(reaches ?? []),
      interfaces: () => [],
      pageHost: null,
      waitFor: async (done, timeoutMs) => {
        timeouts.push(timeoutMs);
        for (let waited = 0; waited <= timeoutMs; waited += 100) {
          tool.poll();
          engine.step(1 / 60);
          tool.poll();
          if (done()) return true;
          t += 100;
        }
        return false;
      },
      ...rest,
    };
  };
  return { build, peers, tried, timeouts, host, step: (ms: number) => void (t += ms) };
}

async function failureOf(run: Promise<void>): Promise<ConnectFailure> {
  const err = await run.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).cause as ConnectFailure;
}

const codeFor = (build: { code: string | null }): ConnectTarget => ({ code: build.code! });

/** The same code with its last character changed: well-formed, but a wrong token. */
function wrongCode(code: string): string {
  return code.slice(0, -1) + (code.endsWith("0") ? "1" : "0");
}

describe("connectToBuild", () => {
  it("pairs by an address code, trying candidates in turn until one answers", async () => {
    const { build, peers, tried, host } = await setup();
    await connectToBuild(codeFor(build), host({ interfaces: () => [{ address: "10.0.0.5", family: "IPv4" }, { address: "192.168.7.9", family: "IPv4" }], reaches: [BUILD_URL] }));
    expect(tried).toEqual(["ws://10.0.1.20:7790/myco-debug", BUILD_URL]);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.state).toBe("accepted");
  });

  it("reads a code typed in lower case with spaces", async () => {
    const { build, peers, host } = await setup();
    const typed = build.code!.toLowerCase().replace("-", " - ");
    await connectToBuild({ code: ` ${typed} ` }, host({ interfaces: () => BUILD_LAN, reaches: [BUILD_URL] }));
    expect(peers).toHaveLength(1);
  });

  it("completes the code from an http page's own host", async () => {
    const { build, tried, host } = await setup();
    await connectToBuild(codeFor(build), host({ pageHost: "172.16.4.4", reaches: ["ws://172.16.1.20:7790/myco-debug"] }));
    expect(tried).toEqual(["ws://172.16.1.20:7790/myco-debug"]);
  });

  it("connects to a typed address directly, without a token", async () => {
    const { peers, tried, host } = await setup({ listen: true }, true);
    await connectToBuild({ address: "ws://127.0.0.1:7790/myco-debug" }, host({ reaches: ["ws://127.0.0.1:7790/myco-debug"] }));
    expect(tried).toEqual(["ws://127.0.0.1:7790/myco-debug (no token)"]);
    expect(peers).toHaveLength(1);
  });

  it("connects to a picked build's address, with the code's token and none of the code's own address", async () => {
    const { build, peers, tried, host } = await setup();
    const picked = "ws://192.168.1.99:7790/myco-debug";
    await connectToBuild({ code: build.code!, address: picked }, host({ interfaces: () => [{ address: "10.0.0.5", family: "IPv4" }], reaches: [picked] }));
    expect(tried).toEqual([picked]); // not the 10.0.1.20 / 192.168.1.20 the code would complete to
    expect(peers).toHaveLength(1);
  });

  it("refuses a wrong code for a picked build, and an unreadable picked address", async () => {
    const { build, host } = await setup();
    const picked = "ws://192.168.1.99:7790/myco-debug";
    expect(await failureOf(connectToBuild({ code: wrongCode(build.code!), address: picked }, host({ reaches: [picked] })))).toEqual({ kind: "refused", message: pairRefusalMessage("bad-token") });
    expect((await failureOf(connectToBuild({ code: build.code!, address: "not an address" }, host()))).kind).toBe("bad-code");
  });

  it("doesn't combine a picked build with a room code, and an empty picked address uses the code as before", async () => {
    const { build, tried, host } = await setup();
    const room = encodePairCode({ kind: "room", rendezvous: null, room: 5, token: 7 });
    const failure = await failureOf(connectToBuild({ code: room, address: "ws://192.168.1.99:7790/myco-debug" }, host()));
    expect(failure.kind).toBe("bad-code");
    expect(tried).toEqual([]);
    await connectToBuild({ code: build.code!, address: "  " }, host({ interfaces: () => BUILD_LAN, reaches: [BUILD_URL] }));
    expect(tried).toEqual([BUILD_URL]);
  });

  it("stops at once on a wrong code, with the build's message", async () => {
    const { build, tried, host, peers } = await setup();
    const failure = await failureOf(
      connectToBuild({ code: wrongCode(build.code!) }, host({ interfaces: () => [{ address: "192.168.7.9" }, { address: "10.0.0.5" }], reaches: [BUILD_URL, "ws://10.0.1.20:7790/myco-debug"] })),
    );
    expect(failure).toEqual({ kind: "refused", message: pairRefusalMessage("bad-token") });
    expect(tried).toHaveLength(1);
    expect(peers).toHaveLength(0);
  });

  it("reports an expired code", async () => {
    const { build, step, host } = await setup();
    const target = codeFor(build);
    step(TOKEN_EXPIRY_MS + 1);
    const failure = await failureOf(connectToBuild(target, host({ interfaces: () => BUILD_LAN, reaches: [BUILD_URL] })));
    expect(failure).toEqual({ kind: "refused", message: pairRefusalMessage("expired") });
  });

  it("refuses a code that was already used", async () => {
    const { build, host } = await setup();
    const h = host({ interfaces: () => BUILD_LAN, reaches: [BUILD_URL] });
    const code = build.code!;
    await connectToBuild({ code }, h);
    expect((await failureOf(connectToBuild({ code }, h))).kind).toBe("refused");
  });

  it("says a room code needs a rendezvous where the host can't join rooms, without connecting", async () => {
    const { tried, host } = await setup();
    const code = encodePairCode({ kind: "room", rendezvous: null, room: 5, token: 7 });
    const failure = await failureOf(connectToBuild({ code }, host()));
    expect(failure.kind).toBe("needs-rendezvous");
    expect(failure.message).toContain("rendezvous");
    expect(tried).toEqual([]);
  });

  it("refuses text that isn't a code, an empty field and an unreadable address", async () => {
    const { host } = await setup();
    expect((await failureOf(connectToBuild({ code: "hello" }, host()))).kind).toBe("bad-code");
    expect((await failureOf(connectToBuild({ code: "  " }, host()))).kind).toBe("bad-code");
    expect((await failureOf(connectToBuild({ address: "" }, host()))).kind).toBe("bad-code");
    expect((await failureOf(connectToBuild({ address: "not an address" }, host()))).kind).toBe("bad-code");
  });

  it("is unreachable when nothing listens at any candidate", async () => {
    const { build, host, tried } = await setup();
    const failure = await failureOf(connectToBuild(codeFor(build), host({ interfaces: () => [{ address: "10.0.0.5" }, { address: "192.168.7.9" }] })));
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toContain("2 addresses");
    expect(tried).toHaveLength(2);
  });

  it("gives each candidate four seconds and gives up on one that doesn't answer", async () => {
    const { build, host, timeouts, peers } = await setup();
    const waits: number[] = [];
    const failure = await failureOf(
      connectToBuild(codeFor(build), host({ interfaces: () => BUILD_LAN, reaches: [BUILD_URL], waitFor: async (_done, ms) => (waits.push(ms), false) })),
    );
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toContain("no answer");
    expect(waits).toEqual([4000]);
    expect(timeouts).toEqual([]);
    expect(peers).toHaveLength(0);
  });
});

// Room codes (ADR 0404, R5): a page build waits in a room on its own server's rendezvous (loopback here); the flow joins
// it through the room connector, over the fake peer pair.
describe("connectToBuild with a room code", () => {
  async function roomSetup() {
    let t = 1000;
    let seed = 0;
    const now = () => t;
    const randomToken = (bits: number) => (++seed * 104_729) % 2 ** bits;
    const server = new RendezvousServer({ transport: createTransport("loopback", { now }), now });
    await server.listen("ws://192.168.1.20:3000/myco-rendezvous");
    undo.push(() => server.close());
    const PeerConnection = fakePeers(new FakeNet());
    const engine = await Engine.create({ headless: true });
    undo.push(() => engine.dispose());
    const build = (await startBuildListener(engine, {
      debug: { listen: true },
      name: "Page game",
      kind: "page-http",
      page: { protocol: "http:", hostname: "192.168.1.20", port: "3000" },
      transport: "loopback",
      transportOptions: { now },
      webrtc: { PeerConnection },
      now,
      randomToken,
      log: () => {},
    }))!;
    undo.push(() => build.close());
    const transport = new RoomJoinTransport({ kind: "page-http", signalTransport: () => createTransport("loopback", { now }), webrtc: { PeerConnection } });
    const peers: DebugLinkPeer[] = [];
    const connector = new ToolConnector(transport, { kind: "page-http", name: "Browser Studio", events: { onPeer: (p) => peers.push(p) } });
    undo.push(() => connector.close());
    const tick = async () => {
      server.poll();
      engine.step(1 / 60);
      connector.poll();
      await flushPeers();
      t += 10;
    };
    for (let i = 0; i < 100 && build.code === null; i++) await tick();
    const host = (hosted: string | null = null): ConnectHost => ({
      connector: null as unknown as ToolConnector, // a room code never uses the WebSocket connector
      interfaces: () => [],
      pageHost: "192.168.7.9",
      waitFor: async (done, timeoutMs) => {
        for (let waited = 0; waited <= timeoutMs; waited += 10) {
          await tick();
          if (done()) return true;
        }
        return false;
      },
      rooms: { connector, kind: "page-http", hosted, webrtc: true, refusal: (a) => transport.refusal(a) },
    });
    return { build, peers, host, step: (ms: number) => void (t += ms), tick };
  }

  it("joins the build's room and pairs", async () => {
    const { build, peers, host } = await roomSetup();
    expect(build.code).not.toBeNull();
    await connectToBuild({ code: build.code! }, host());
    expect(peers).toHaveLength(1);
    expect(peers[0]!.hello.name).toBe("Page game");
  });

  it("stops at once on a wrong token, with the refusal's message", async () => {
    const { build, peers, host } = await roomSetup();
    const read = decodePairCode(build.code!) as { code: RoomPairCode };
    const wrong = encodePairCode({ ...read.code, token: (read.code.token + 1) % 2 ** 20 });
    expect(await failureOf(connectToBuild({ code: wrong }, host()))).toEqual({ kind: "refused", message: pairRefusalMessage("bad-token") });
    expect(peers).toHaveLength(0);
  });

  it("says the room is gone once it expired", async () => {
    const { build, host, step, tick } = await roomSetup();
    const old = build.code!;
    step(ROOM_EXPIRY_MS + 1);
    for (let i = 0; i < 100 && build.code === old; i++) await tick();
    expect(await failureOf(connectToBuild({ code: old }, host()))).toEqual({ kind: "refused", message: NO_ROOM_MESSAGE });
  });

  it("refuses a hosted code when no hosted rendezvous is set, without connecting", async () => {
    const { host, peers } = await roomSetup();
    const failure = await failureOf(connectToBuild({ code: encodePairCode({ kind: "room", rendezvous: null, room: 5, token: 7 }) }, host(null)));
    expect(failure.kind).toBe("needs-rendezvous");
    expect(failure.message).toContain("no hosted rendezvous is configured");
    expect(peers).toHaveLength(0);
  });
});
