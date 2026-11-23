// The editor's debug link (ADR 0376) over loopback: builds from this machine are accepted at once and the first becomes
// the one the debuggers read; a build from another machine waits for the accept prompt, and a refused one isn't asked
// about again; choosing and disconnecting builds; listening off, unavailable, or refused by a taken address.
import { afterEach, describe, expect, it } from "vitest";
import { createTransport, type Transport, type TransportConnection } from "../../engine/net/Transport";
import "../../engine/net/transport/loopback";
import { DebugLinkSession } from "../../engine/debugLink/session";
import { listenAddress, type DebugLinkPreferences } from "./debugLinkLogic";
import { EditorDebugLink } from "./editorLink";

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
});
