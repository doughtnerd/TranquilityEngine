// The desktop editor's listening WebSocket transport (ADR 0379) against stand-ins for Tauri's IPC, through the transport
// interface (`createTransport("websocket")`) and the editor's debug link. The stand-in speaks the native side's wire
// format (`native/ws-listener/src/wire.rs`): one in memory, where the test plays the native server; one over a real
// WebSocket server (`ws`), where a build's session connects with the engine's client transport.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createTransport, transportCanListen, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";
import { DebugLinkSession } from "./session";
import { DebugLinkListener, type DebugLinkPeer } from "./client";
import { DEBUG_LINK_PATH } from "./config";
import { TAURI_HOSTING_TRANSPORT, hostRendezvous, nativeInterfaces, registerTauriWebSocketTransport, tauriListenerPort } from "./tauriListener";
import { encodeRendezvousMessage, decodeServerMessage, RENDEZVOUS_PATH, type RendezvousClientMessage } from "./rendezvous/protocol";
import "../net/transport/loopback";
import { Engine } from "../../myco";
import { startBuildListener } from "./host";
import { decodePairCode } from "./pairing/code";

type Record_ = { op: "send"; connection: number; data: number[] } | { op: "close"; connection: number; code: number; reason: string };

interface Backend {
  listen(args: { host: string; port: number; path: string; count?: number }, emit: (event: ArrayBuffer) => void): Promise<{ id: number; port: number }>;
  send(listener: number, records: Record_[]): Promise<void>;
  close(listener: number): Promise<void>;
}

const tauri = vi.hoisted(() => ({ backend: null as unknown as Backend, calls: [] as string[], noRange: false, interfaces: [] as unknown }));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(readonly onmessage: (message: ArrayBuffer) => void) {}
  },
  invoke: async (cmd: string, args: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => {
    tauri.calls.push(cmd);
    switch (cmd) {
      case "myco_debuglink_listen_range": {
        if (tauri.noRange) throw new Error("Command myco_debuglink_listen_range not found");
        const { host, firstPort, count, path, events } = args as { host: string; firstPort: number; count: number; path: string; events: { onmessage: (m: ArrayBuffer) => void } };
        return tauri.backend.listen({ host, port: firstPort, path, count }, (m) => events.onmessage(m));
      }
      case "myco_debuglink_listen": {
        const { host, port, path, events } = args as { host: string; port: number; path: string; events: { onmessage: (m: ArrayBuffer) => void } };
        return tauri.backend.listen({ host, port, path }, (m) => events.onmessage(m));
      }
      case "myco_debuglink_send":
        return tauri.backend.send(Number(options!.headers["myco-listener"]), decodeOutbox(args as Uint8Array));
      case "myco_debuglink_close":
        return tauri.backend.close((args as { id: number }).id);
      case "myco_debuglink_interfaces":
        if (tauri.interfaces instanceof Error) throw tauri.interfaces;
        return tauri.interfaces;
    }
    throw new Error(`unknown command ${cmd}`);
  },
}));

// The native side's wire format, as the stand-ins need it.
const text = new TextEncoder();
const untext = new TextDecoder();
function event(kind: number, connection: number, rest: Uint8Array = new Uint8Array()): ArrayBuffer {
  const out = new Uint8Array(5 + rest.byteLength);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, connection);
  out.set(rest, 5);
  return out.buffer;
}
const accept = (c: number, remote: string, path?: string) => event(1, c, text.encode(path === undefined ? remote : `${remote}
${path}`));
const message = (c: number, bytes: number[]) => event(2, c, Uint8Array.from(bytes));
function closed(c: number, code: number, reason: string): ArrayBuffer {
  const r = text.encode(reason);
  const rest = new Uint8Array(2 + r.byteLength);
  new DataView(rest.buffer).setUint16(0, code);
  rest.set(r, 2);
  return event(3, c, rest);
}
function decodeOutbox(body: Uint8Array): Record_[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Record_[] = [];
  for (let at = 0; at < body.byteLength; ) {
    const op = view.getUint8(at);
    const connection = view.getUint32(at + 1);
    const bytes = body.subarray(at + 9, at + 9 + view.getUint32(at + 5));
    at += 9 + bytes.byteLength;
    if (op === 1) out.push({ op: "send", connection, data: [...bytes] });
    else out.push({ op: "close", connection, code: (bytes[0]! << 8) | bytes[1]!, reason: untext.decode(bytes.subarray(2)) });
  }
  return out;
}

/** The native server played by the test: what it was asked, and a way to emit events. */
function memoryBackend(options: { refuse?: string; taken?: number[] } = {}) {
  tauri.calls = [];
  tauri.noRange = false;
  const state = {
    listens: [] as { host: string; port: number; path: string; count?: number }[],
    records: [] as Record_[],
    closed: [] as number[],
    emit: (_e: ArrayBuffer) => {},
    /** While set, sends wait for it (to see that calls go one at a time). */
    hold: null as Promise<void> | null,
  };
  tauri.backend = {
    async listen(args, emit) {
      if (options.refuse) throw options.refuse; // Tauri rejects with the command's error string
      state.listens.push(args);
      state.emit = emit;
      // A range: the first `count` ports from the one asked for, the ones in `options.taken` skipped.
      let port = args.port;
      while (options.taken?.includes(port) && port < args.port + (args.count ?? 1)) port++;
      if (options.taken?.includes(port)) throw `ports ${args.port}-${args.port + (args.count ?? 1) - 1} are all in use`;
      return { id: 7, port };
    },
    async send(listener, records) {
      expect(listener).toBe(7);
      if (state.hold) await state.hold;
      state.records.push(...records);
    },
    async close(listener) {
      state.closed.push(listener);
    },
  };
  return state;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const transports: Transport[] = [];
afterEach(() => {
  for (const t of transports.splice(0)) t.close();
});

registerTauriWebSocketTransport();

function transport(): Transport {
  const t = createTransport("websocket");
  transports.push(t);
  return t;
}

function only<K extends TransportEvent["kind"]>(events: TransportEvent[], kind: K): Extract<TransportEvent, { kind: K }> {
  expect(events.map((e) => e.kind)).toEqual([kind]);
  return events[0] as Extract<TransportEvent, { kind: K }>;
}

describe("the desktop listening transport", () => {
  it("is registered as a websocket transport that can listen, and binds the address it's given", async () => {
    const native = memoryBackend();
    expect(transportCanListen("websocket")).toBe(true);
    await transport().listen("ws://127.0.0.1:7790/myco-debug");
    await transport().listen("ws://0.0.0.0:7791/myco-debug");
    await transport().listen("7792");
    expect(native.listens).toEqual([
      { host: "127.0.0.1", port: 7790, path: "/myco-debug", count: 10 },
      { host: "0.0.0.0", port: 7791, path: "/myco-debug", count: 10 },
      { host: "0.0.0.0", port: 7792, path: "/", count: 10 },
    ]);
  });

  it("asks for a range of ports and reports the one it got", async () => {
    const native = memoryBackend({ taken: [7790, 7791] });
    const t = transport();
    expect(tauriListenerPort(t)).toBeNull();
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    expect(native.listens).toEqual([{ host: "127.0.0.1", port: 7790, path: "/myco-debug", count: 10 }]);
    expect(tauriListenerPort(t)).toBe(7792);
    expect(tauri.calls).toEqual(["myco_debuglink_listen_range"]);
  });

  it("a listening build's code names the port the native listener really bound (ADR 0403)", async () => {
    memoryBackend({ taken: [7790, 7791] });
    const engine = await Engine.create({ headless: true });
    const build = await startBuildListener(engine, {
      debug: { listen: true, lan: true },
      name: "Desktop game",
      interfaces: () => [{ address: "192.168.1.20", family: "IPv4" }],
      log: () => {},
    });
    try {
      expect(build?.port).toBe(7792);
      const decoded = decodePairCode(build!.code!);
      expect("code" in decoded && decoded.code.kind === "address" && decoded.code.portOffset).toBe(2);
    } finally {
      build?.close();
      engine.dispose();
    }
  });

  it("asks for exactly port 0 (any free port) without a range", async () => {
    const native = memoryBackend();
    await transport().listen("ws://127.0.0.1:0/myco-debug");
    expect(native.listens[0]!.count).toBe(1);
  });

  it("falls back to the single-port command while the native side has no range command", async () => {
    const native = memoryBackend();
    tauri.noRange = true;
    const t = transport();
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    expect(tauri.calls).toEqual(["myco_debuglink_listen_range", "myco_debuglink_listen"]);
    expect(native.listens).toEqual([{ host: "127.0.0.1", port: 7790, path: "/myco-debug" }]);
    expect(tauriListenerPort(t)).toBe(7790);
  });

  it("opens a connection per accept and moves framed binary messages both ways", async () => {
    const native = memoryBackend();
    const t = transport();
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    native.emit(accept(3, "127.0.0.1:51234"));
    const { connection } = only(t.poll(), "open");
    expect(connection.remote).toBe("127.0.0.1:51234");
    expect(connection.state).toBe("open");

    native.emit(message(3, [0, 10, 20])); // reliable
    native.emit(message(3, [1, 30])); // unreliable
    const [a, b] = t.poll() as Extract<TransportEvent, { kind: "data" }>[];
    expect([a!.channel, [...a!.data], b!.channel, [...b!.data]]).toEqual(["reliable", [10, 20], "unreliable", [30]]);

    connection.send("reliable", Uint8Array.of(5, 6));
    connection.send("unreliable", Uint8Array.of(7));
    await settle();
    expect(native.records).toEqual([
      { op: "send", connection: 3, data: [0, 5, 6] },
      { op: "send", connection: 3, data: [1, 7] },
    ]);
    expect(tauri.calls.filter((c) => c === "myco_debuglink_send")).toHaveLength(1); // one outbox per turn
  });

  it("reports the native side's close, and sends a close the page makes without hearing it back", async () => {
    const native = memoryBackend();
    const t = transport();
    await t.listen("7790");
    native.emit(accept(1, "192.168.1.30:50000"));
    native.emit(accept(2, "[::1]:50001"));
    const [first, second] = t.poll().map((e) => e.connection) as [TransportConnection, TransportConnection];

    native.emit(closed(1, 1001, "build quit"));
    expect(t.poll()).toEqual([{ kind: "close", connection: first, reason: "build quit" }]);
    expect(() => first.send("reliable", Uint8Array.of(1))).toThrow(/closed/);

    second.close("The editor disconnected.");
    expect(only(t.poll(), "close").reason).toBe("The editor disconnected.");
    native.emit(closed(2, 1000, "late")); // the native side's own echo: not a second close
    native.emit(message(2, [0, 1]));
    expect(t.poll()).toEqual([]);
    await settle();
    expect(native.records).toEqual([{ op: "close", connection: 2, code: 1000, reason: "The editor disconnected." }]);
  });

  it("closes a connection that breaks the framing, through the native side", async () => {
    const native = memoryBackend();
    const t = transport();
    await t.listen("7790");
    native.emit(accept(4, "127.0.0.1:1"));
    t.poll();
    native.emit(message(4, [0x80, 1])); // a reserved header bit
    expect(only(t.poll(), "close").reason).toMatch(/protocol error/);
    await settle();
    expect(native.records).toEqual([{ op: "close", connection: 4, code: 1000, reason: expect.stringMatching(/protocol error/) }]);
  });

  it("rejects listen with the native side's reason when the port is taken", async () => {
    memoryBackend({ refuse: "port 7790 is already in use" });
    await expect(transport().listen("ws://127.0.0.1:7790/myco-debug")).rejects.toThrow("port 7790 is already in use");
  });

  it("makes one IPC call at a time, in order", async () => {
    const native = memoryBackend();
    const t = transport();
    await t.listen("7790");
    native.emit(accept(1, "127.0.0.1:1"));
    const [c] = t.poll().map((e) => e.connection) as [TransportConnection];
    let release = () => {};
    native.hold = new Promise((r) => (release = r));
    c.send("reliable", Uint8Array.of(1));
    await settle();
    c.send("reliable", Uint8Array.of(2));
    c.send("reliable", Uint8Array.of(3));
    await settle();
    expect(tauri.calls.filter((x) => x === "myco_debuglink_send")).toHaveLength(1); // the second outbox waits
    native.hold = null;
    release();
    await settle();
    await settle();
    expect(native.records.map((r) => (r.op === "send" ? r.data[1] : -1))).toEqual([1, 2, 3]);
    expect(tauri.calls.filter((x) => x === "myco_debuglink_send")).toHaveLength(2);
  });

  it("closes its connections before the listener when closed, and a listener still binding once it binds", async () => {
    const native = memoryBackend();
    const t = createTransport("websocket");
    await t.listen("7790");
    native.emit(accept(1, "127.0.0.1:1"));
    t.poll();
    t.close();
    await settle();
    expect(native.records).toEqual([{ op: "close", connection: 1, code: 1000, reason: "transport closed" }]);
    expect(tauri.calls).toEqual(["myco_debuglink_listen_range", "myco_debuglink_send", "myco_debuglink_close"]);
    expect(native.closed).toEqual([7]);

    const binding = createTransport("websocket");
    const listening = binding.listen("7791");
    binding.close();
    await listening;
    await settle();
    expect(native.closed).toEqual([7, 7]);
  });
});

/** A native server played by `ws`: what the Rust listener does, in a few lines. */
function wsBackend() {
  const ports: number[] = [];
  const servers = new Map<number, { wss: WebSocketServer; sockets: Map<number, WsSocket> }>();
  let nextListener = 1;
  let nextConnection = 1;
  tauri.backend = {
    listen: ({ host, port, path }, emit) =>
      new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ host, port, path });
        const sockets = new Map<number, WsSocket>();
        const id = nextListener++;
        wss.once("error", (e) => reject(String(e.message)));
        wss.once("listening", () => {
          servers.set(id, { wss, sockets });
          ports.push((wss.address() as { port: number }).port);
          resolve({ id, port: ports.at(-1)! });
        });
        wss.on("connection", (socket, request) => {
          const c = nextConnection++;
          sockets.set(c, socket);
          emit(accept(c, `${request.socket.remoteAddress}:${request.socket.remotePort}`));
          socket.on("message", (data: Buffer) => emit(message(c, [...data])));
          socket.on("close", (code, reason) => {
            if (sockets.delete(c)) emit(closed(c, code, reason.toString()));
          });
        });
      }),
    async send(listener, records) {
      const sockets = servers.get(listener)?.sockets;
      for (const r of records) {
        const socket = sockets?.get(r.connection);
        if (!socket) continue;
        if (r.op === "send") socket.send(Uint8Array.from(r.data));
        else {
          sockets!.delete(r.connection);
          socket.close(r.code, r.reason);
        }
      }
    },
    async close(listener) {
      const s = servers.get(listener);
      servers.delete(listener);
      for (const socket of s?.sockets.values() ?? []) socket.close(1001, "The listener closed.");
      s?.wss.close();
    },
  };
  return { ports };
}

async function until(done: () => boolean, pump: () => void): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) {
    pump();
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(done()).toBe(true);
}

describe("the debug link listener on the desktop transport", () => {
  it("listens, accepts a build from this machine, and disconnects it", async () => {
    const native = wsBackend();
    const peers: DebugLinkPeer[] = [];
    const listener = new DebugLinkListener(createTransport("websocket"), { onPeer: (p) => (p.accept(), peers.push(p)) });
    await listener.listen(`ws://127.0.0.1:0${DEBUG_LINK_PATH}`);
    try {
      // The build connects with the engine's client transport (the page's own WebSocket), to the port the server bound.
      const port = native.ports[0]!;
      const client = transport();
      const build = new DebugLinkSession({ transport: client, connection: client.connect(`ws://localhost:${port}${DEBUG_LINK_PATH}`), hello: { name: "Game", platform: "desktop", topics: [] }, topics: new Map() });
      const pump = () => {
        build.frameStart();
        listener.poll();
      };
      await until(() => build.state === "accepted", pump);
      expect(listener.peers.map((p) => [p.hello.name, p.hello.platform])).toEqual([["Game", "desktop"]]);
      peers[0]!.close();
      await until(() => build.state === "closed", pump);
      expect(listener.peers).toEqual([]);
    } finally {
      listener.close();
    }
  });

  it("says why it can't listen when the port is taken", async () => {
    wsBackend();
    const taken = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => taken.once("listening", r));
    const port = (taken.address() as { port: number }).port;
    const listener = new DebugLinkListener(createTransport("websocket"));
    try {
      await expect(listener.listen(`ws://127.0.0.1:${port}${DEBUG_LINK_PATH}`)).rejects.toThrow(/EADDRINUSE/);
    } finally {
      listener.close();
      taken.close();
    }
  });
});

describe("this machine's network addresses from the shell (nativeInterfaces)", () => {
  const withTauri = (on: boolean) => {
    const g = globalThis as { __TAURI_INTERNALS__?: unknown };
    if (on) g.__TAURI_INTERNALS__ = {};
    else delete g.__TAURI_INTERNALS__;
  };
  afterEach(() => {
    withTauri(false);
    tauri.interfaces = [];
  });

  it("is empty outside Tauri, without asking", async () => {
    tauri.calls.length = 0;
    expect(await nativeInterfaces()).toEqual([]);
    expect(tauri.calls).toEqual([]);
  });

  it("is the shell's list under Tauri, and empty when the command fails (an older shell)", async () => {
    withTauri(true);
    tauri.interfaces = [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "127.0.0.1", family: "IPv4", internal: true }];
    expect(await nativeInterfaces()).toEqual(tauri.interfaces);
    tauri.interfaces = new Error("Command myco_debuglink_interfaces not found");
    expect(await nativeInterfaces()).toEqual([]);
  });

  it("gives a listening build a pairing code for the machine's private address, and none without them", async () => {
    withTauri(true);
    tauri.interfaces = [{ address: "192.168.7.31", family: "IPv4", internal: false }, { address: "127.0.0.1", family: "IPv4", internal: true }];
    const engine = await Engine.create({ headless: true });
    try {
      const list = await nativeInterfaces();
      const build = await startBuildListener(engine, { debug: { listen: true, lan: true, port: 7794 }, name: "Game", platform: "loopback-test", transport: "loopback", interfaces: () => list, log: () => {} });
      try {
        expect(decodePairCode(build!.code!)).toMatchObject({ code: { kind: "address", octets: [7, 31], portOffset: 4 } });
      } finally {
        build!.close();
      }
      tauri.interfaces = new Error("nope");
      const none = await nativeInterfaces();
      const bare = await startBuildListener(engine, { debug: { listen: true, lan: true, port: 7795 }, name: "Game", platform: "loopback-test", transport: "loopback", interfaces: () => none, log: () => {} });
      try {
        expect(bare!.code).toBeNull();
      } finally {
        bare!.close();
      }
    } finally {
      engine.dispose();
    }
  });
});

describe("one native listener serving the rendezvous beside the debug link (ADR 0403)", () => {
  const frame = (m: RendezvousClientMessage) => [0, ...encodeRendezvousMessage(m)];
  const join = (room: number, seat: "waiting" | "joining"): RendezvousClientMessage => ({ t: "join", v: 1, room, token: 5, seat, kind: "page-http" });
  /** What the native side was asked to send to `connection`, decoded as rendezvous messages. */
  const sentTo = (native: ReturnType<typeof memoryBackend>, connection: number) =>
    native.records.flatMap((r) => (r.op === "send" && r.connection === connection ? [decodeServerMessage(Uint8Array.from(r.data.slice(1)))] : []));

  it("listens natively at / and routes by the path each accept reports", async () => {
    const native = memoryBackend();
    const t = transport();
    expect(hostRendezvous(t)).toBeTypeOf("function");
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    expect(native.listens[0]).toMatchObject({ path: "/" });

    native.emit(accept(1, "10.0.0.1:1", "/myco-debug")); // a debug-link peer reaches the transport itself
    native.emit(accept(2, "10.0.0.2:2", RENDEZVOUS_PATH)); // a rendezvous seat does not
    const events = t.poll();
    expect(events.map((e) => e.kind)).toEqual(["open"]);
    expect((events[0] as Extract<TransportEvent, { kind: "open" }>).connection.remote).toBe("10.0.0.1:1");
  });

  it("serves a signalling exchange between two seats over the rendezvous path", async () => {
    const native = memoryBackend();
    const t = transport();
    hostRendezvous(t);
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    native.emit(accept(21, "10.0.0.1:1", RENDEZVOUS_PATH));
    native.emit(accept(22, "10.0.0.2:2", `${RENDEZVOUS_PATH}`));
    native.emit(message(21, frame(join(77, "waiting"))));
    native.emit(message(22, frame(join(77, "joining"))));
    await new Promise((r) => setTimeout(r, 120)); // the hosted rendezvous polls on its own timer
    expect(sentTo(native, 21).map((m) => ("message" in m ? m.message.t : "refused"))).toEqual(["joined", "peer-joined"]);
    expect(sentTo(native, 22).map((m) => ("message" in m ? m.message.t : "refused"))).toEqual(["joined", "peer-joined"]);
    native.emit(message(21, frame({ t: "offer", sdp: "v=0" } as RendezvousClientMessage)));
    await new Promise((r) => setTimeout(r, 120));
    expect(sentTo(native, 22).map((m) => ("message" in m ? m.message.t : "refused"))).toContain("offer");
  });

  it("closes a path that is neither the listen path nor a route", async () => {
    const native = memoryBackend();
    const t = transport();
    hostRendezvous(t);
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    native.emit(accept(5, "10.0.0.5:5", "/elsewhere"));
    await settle();
    expect(t.poll()).toEqual([]);
    expect(native.records).toEqual([{ op: "close", connection: 5, code: 1008, reason: "Not found." }]);
  });

  it("the hosting transport a listening desktop game uses carries the rendezvous on its port", async () => {
    const native = memoryBackend();
    const t = createTransport(TAURI_HOSTING_TRANSPORT);
    transports.push(t);
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    expect(native.listens[0]).toMatchObject({ path: "/" }); // routes the rendezvous path and the debug path itself
    native.emit(accept(31, "10.0.0.1:1", RENDEZVOUS_PATH));
    native.emit(accept(32, "10.0.0.2:2", RENDEZVOUS_PATH));
    native.emit(message(31, frame(join(78, "waiting"))));
    native.emit(message(32, frame(join(78, "joining"))));
    await new Promise((r) => setTimeout(r, 120)); // the hosted rendezvous polls on its own timer
    expect(sentTo(native, 31).map((m) => ("message" in m ? m.message.t : "refused"))).toEqual(["joined", "peer-joined"]);
  });

  it("without a rendezvous the native side keeps the debug path (no filtering)", async () => {
    const native = memoryBackend();
    await transport().listen("ws://127.0.0.1:7790/myco-debug");
    expect(native.listens[0]).toMatchObject({ path: "/myco-debug" });
  });

  it("does nothing for another transport or after listening", async () => {
    memoryBackend();
    expect(hostRendezvous(createTransport("loopback"))).toBeNull();
    const t = transport();
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    expect(hostRendezvous(t)).toBeNull();
  });

  it("stops the rendezvous with the transport", async () => {
    const native = memoryBackend();
    const t = transport();
    hostRendezvous(t);
    await t.listen("ws://127.0.0.1:7790/myco-debug");
    native.emit(accept(9, "10.0.0.9:9", RENDEZVOUS_PATH));
    t.close();
    await settle();
    expect(native.closed).toEqual([7]);
  });
});
