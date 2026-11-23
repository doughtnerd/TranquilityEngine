// The editor's end of the debug link (ADR 0376): it listens (on this machine, and on the LAN when Preferences allow),
// accepts builds from this machine at once and asks before accepting one from another machine (the accept prompt), keeps
// the connected builds (the status bar's menu), and which one the live debuggers read (`active`). Plugins reach it
// through the SDK (`editorDebugLink()`) and talk to a build through its `DebugLinkPeer` (subscriptions, requests,
// commands). The listening transport is given, so a headless test listens over loopback; in the editor it is the
// WebSocket transport where this host can listen.
import { batch, computed, signal, type ReadonlySignal } from "@preact/signals";
import type { Engine } from "../../engine/core/Engine";
import { createTransport, type Transport } from "../../engine/net/Transport";
import { DebugLinkListener, ToolConnector, type DebugLinkPeer } from "../../engine/debugLink/client";
import type { EndpointKind } from "../../engine/debugLink/protocol";
import { DEFAULT_DEBUG_LINK_PORT } from "../../engine/debugLink/config";
import type { NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";
import { nativeInterfaces } from "../../engine/debugLink/tauriListener";
import { connectToBuild, type ConnectTarget } from "./connectFlow";
import { servePlayBuild, type PlayBuild, type PlayBuildOptions, type PlayBuildState } from "./playBuild";
import { isLocalRemote, listenAddress, remoteHost, type BuildEntry, type DebugLinkPreferences } from "./debugLinkLogic";

/** A build that said hello. */
export interface ConnectedBuild extends BuildEntry {
  readonly peer: DebugLinkPeer;
}

/** Whether and where the editor listens. */
export type ListenState =
  | { readonly kind: "off" }
  | { readonly kind: "listening"; readonly address: string }
  | { readonly kind: "unavailable"; readonly why: string };

export interface EditorDebugLinkOptions {
  /** A transport that can listen, or null when this host can't (a plain browser page). */
  readonly transport: () => Transport | null;
  /** Polls on a timer (default true; tests poll by hand). */
  readonly autoPoll?: boolean;
  /** How often, milliseconds (default 33). */
  readonly pollMs?: number;
  /** This tool's name in a build's list when it connects out ("Audio Studio on DESKTOP-1"; default "Myco editor"). */
  readonly name?: string;
  /**
   * The listening transport Play serves tools on (`servePlay`, a transport name: default `websocket`), or null when this
   * host can't listen. Tests pass `loopback`.
   */
  readonly playTransport?: string | null;
  /** Where this machine's network addresses come from (default `nativeInterfaces`: the desktop shell's, empty elsewhere). */
  readonly interfaces?: () => Promise<readonly NetworkInterfaceAddress[]>;
  /** Everything else about how Play listens (tests: the loopback's clock, the gate's clock, this machine's addresses). */
  readonly playOptions?: Omit<PlayBuildOptions, "transport" | "lan" | "port">;
}

/** @internal The editor's debug link. */
export class EditorDebugLink {
  private readonly buildsSignal = signal<readonly ConnectedBuild[]>([]);
  private readonly pendingSignal = signal<readonly ConnectedBuild[]>([]);
  private readonly activeSignal = signal<ConnectedBuild | null>(null);
  private readonly stateSignal = signal<ListenState>({ kind: "off" });
  private listener: DebugLinkListener | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  /** Builds refused this session (host and name): their reconnection attempts are closed without asking again. */
  private readonly refused = new Set<string>();
  private generation = 0;

  constructor(private readonly options: EditorDebugLinkOptions) {
    if (!options.interfaces && !("__TAURI_INTERNALS__" in globalThis)) this.interfaceList = [];
  }

  /** Accepted builds, in connection order. */
  get builds(): ReadonlySignal<readonly ConnectedBuild[]> {
    return this.buildsSignal;
  }
  /** Builds from other machines waiting for the accept prompt's answer. */
  get pending(): ReadonlySignal<readonly ConnectedBuild[]> {
    return this.pendingSignal;
  }
  /** The build the live debuggers read (null: none; the play session's own source then). */
  get active(): ReadonlySignal<ConnectedBuild | null> {
    return this.activeSignal;
  }
  get state(): ReadonlySignal<ListenState> {
    return this.stateSignal;
  }

  /** Play served as a build while the editor plays (`servePlay`), or null; the builds menu's slot reads it. */
  get play(): ReadonlySignal<PlayBuild | null> {
    return this.playSignal;
  }

  /** Listens as `prefs` say, closing an earlier listener (and its builds) first. A served Play listens again by them. */
  async apply(prefs: DebugLinkPreferences): Promise<void> {
    this.closeListening();
    this.prefs = prefs;
    this.restartPlay();
    const generation = ++this.generation;
    if (!prefs.listen) return;
    const transport = this.options.transport();
    if (!transport) {
      this.stateSignal.value = { kind: "unavailable", why: "This editor can't listen for builds here: a browser page can't open a server socket. The desktop editor can, and this one can still connect to a build by its code (Connect to a build… in the builds menu)." };
      return;
    }
    const listener = new DebugLinkListener(transport, {
      onPeer: (peer) => this.arrived(peer),
      onClose: (peer) => this.left(peer),
    });
    const address = listenAddress(prefs);
    try {
      await listener.listen(address);
    } catch (err) {
      listener.close();
      if (generation === this.generation) this.stateSignal.value = { kind: "unavailable", why: `Couldn't listen at ${address}: ${(err as Error)?.message ?? err}` };
      return;
    }
    if (generation !== this.generation) {
      listener.close();
      return;
    }
    this.listener = listener;
    this.stateSignal.value = { kind: "listening", address };
    if (this.options.autoPoll !== false) this.timer = setInterval(() => this.poll(), this.options.pollMs ?? 33);
  }

  /** Handles what arrived (the timer calls it; tests call it by hand). */
  poll(): void {
    this.listener?.poll();
    this.connector?.poll();
  }

  /**
   * Connects to a listening build (ADR 0380): by the code it shows, or a typed address. Resolves once it paired (it
   * joins `builds` at once: the tool chose to connect, so there is no prompt); rejects with the reason
   * (`connectFlow.ts`). C7: the flow is U1's.
   */
  async connect(target: ConnectTarget): Promise<void> {
    const connector = this.ensureConnector();
    const interfaces = await this.machineInterfaces();
    return connectToBuild(target, {
      connector,
      interfaces: () => interfaces,
      pageHost: typeof location !== "undefined" && !("__TAURI_INTERNALS__" in globalThis) ? location.hostname : null,
      waitFor: (done, timeoutMs) => this.waitFor(done, timeoutMs),
    });
  }

  /**
   * Serves the play Engine as a build on this link while the editor plays (ADR 0380, U3), so a tool can pair with
   * Play: on a listener of its own from the editor's port + 1, on the LAN when the preferences listen there, not at all
   * while they turn the link off (`playBuild.ts` says why it is a listener of its own). A later call replaces an earlier
   * one; the returned build's `stop` (Play stopped) ends it. Its signals follow the build across preference changes.
   */
  servePlay(engine: Engine, name: string): PlayBuild {
    this.endPlay();
    const served = { engine, name };
    this.served = served;
    this.restartPlay();
    const current = this.playSignal;
    return {
      code: computed(() => current.value?.code.value ?? null),
      tools: computed(() => current.value?.tools.value ?? []),
      state: computed((): PlayBuildState => (this.served === served ? (current.value?.state.value ?? { kind: "starting" }) : { kind: "stopped" })),
      stop: () => {
        if (this.served === served) this.endPlay();
      },
    };
  }

  /** This machine's addresses, fetched once: known at once where there's nothing to ask (a browser page), null until then in a native shell. */
  private interfaceList: readonly NetworkInterfaceAddress[] | null = null;
  private interfaceFetch: Promise<readonly NetworkInterfaceAddress[]> | null = null;
  private restarts = 0;

  private machineInterfaces(): Promise<readonly NetworkInterfaceAddress[]> {
    if (this.interfaceList) return Promise.resolve(this.interfaceList);
    return (this.interfaceFetch ??= (this.options.interfaces ?? nativeInterfaces)().then(
      (list) => (this.interfaceList = list),
      () => (this.interfaceList = []),
    ));
  }

  private readonly playSignal = signal<PlayBuild | null>(null);
  private prefs: DebugLinkPreferences | null = null;
  /** The play Engine `servePlay` was given, while it serves. */
  private served: { readonly engine: Engine; readonly name: string } | null = null;

  /** (Re)starts serving the remembered play Engine by the current preferences. */
  private restartPlay(): void {
    this.restarts++;
    this.playSignal.peek()?.stop();
    const served = this.served;
    if (!served) {
      this.playSignal.value = null;
      return;
    }
    const prefs = this.prefs ?? { listen: true, lan: false, port: DEFAULT_DEBUG_LINK_PORT };
    if (!prefs.listen) {
      this.playSignal.value = offBuild();
      return;
    }
    const begin = (list: readonly NetworkInterfaceAddress[]) => {
      this.playSignal.value = servePlayBuild(served.engine, served.name, {
        interfaces: () => list,
        ...this.options.playOptions,
        transport: this.options.playTransport === undefined ? "websocket" : this.options.playTransport,
        lan: prefs.lan,
        port: prefs.port + 1,
      });
    };
    if (this.interfaceList) return begin(this.interfaceList);
    // The first fetch in a native shell: Play starts once the addresses are known (its code needs them).
    this.playSignal.value = null;
    const restart = this.restarts;
    void this.machineInterfaces().then((list) => {
      if (this.served === served && this.restarts === restart) begin(list);
    });
  }

  private endPlay(): void {
    this.served = null;
    this.playSignal.peek()?.stop();
    this.playSignal.value = null;
  }

  private connector: ToolConnector | null = null;

  private ensureConnector(): ToolConnector {
    if (this.connector) return this.connector;
    const kind: EndpointKind =
      "__TAURI_INTERNALS__" in globalThis ? "native" : typeof location !== "undefined" && location.protocol === "https:" ? "page-https" : "page-http";
    this.connector = new ToolConnector(createTransport("websocket"), {
      kind,
      name: this.options.name ?? "Myco editor",
      events: { onPeer: (peer) => this.joined(peer), onClose: (peer) => this.left(peer) },
    });
    if (this.options.autoPoll !== false && this.timer === null) this.timer = setInterval(() => this.poll(), this.options.pollMs ?? 33);
    return this.connector;
  }

  /** Polls until `done` or `timeoutMs` of wall time (a person waits on a connect; tests poll by hand and pass 0). */
  private async waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      this.poll();
      if (done()) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 33));
    }
  }

  /** A build this link connected to paired: no prompt (the person typed its code). */
  private joined(peer: DebugLinkPeer): void {
    this.admit({ id: this.nextId++, name: peer.hello.name, platform: peer.hello.platform, remote: peer.remote, peer });
  }

  /** Lets a pending build in. */
  accept(id: number): void {
    const b = this.pendingSignal.peek().find((p) => p.id === id);
    if (!b) return;
    batch(() => {
      this.pendingSignal.value = this.pendingSignal.peek().filter((p) => p.id !== id);
      this.admit(b);
    });
  }

  /** Turns a pending build away; its reconnection attempts are refused for the rest of the session. */
  refuse(id: number): void {
    const b = this.pendingSignal.peek().find((p) => p.id === id);
    if (!b) return;
    this.refused.add(refusalKey(b));
    this.pendingSignal.value = this.pendingSignal.peek().filter((p) => p.id !== id);
    b.peer.close("The editor refused the connection.");
  }

  /** Makes build `id` the one the debuggers read (null: none). */
  choose(id: number | null): void {
    this.activeSignal.value = id === null ? null : (this.buildsSignal.peek().find((b) => b.id === id) ?? this.activeSignal.peek());
  }

  /** Closes the link to build `id`. */
  disconnect(id: number): void {
    const b = this.buildsSignal.peek().find((x) => x.id === id);
    if (!b) return;
    b.peer.close("The editor disconnected.");
    this.left(b.peer);
  }

  /** Stops listening; every build is disconnected, and a served Play's tools too. */
  stop(): void {
    this.endPlay();
    this.closeListening();
  }

  private closeListening(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listener?.close();
    this.listener = null;
    this.connector?.close();
    this.connector = null;
    batch(() => {
      this.buildsSignal.value = [];
      this.pendingSignal.value = [];
      this.activeSignal.value = null;
      this.stateSignal.value = { kind: "off" };
    });
  }

  private arrived(peer: DebugLinkPeer): void {
    const b: ConnectedBuild = { id: this.nextId++, name: peer.hello.name, platform: peer.hello.platform, remote: peer.remote, peer };
    if (isLocalRemote(peer.remote)) return this.admit(b);
    if (this.refused.has(refusalKey(b))) {
      peer.close("The editor refused the connection.");
      return;
    }
    this.pendingSignal.value = [...this.pendingSignal.peek(), b];
  }

  private admit(b: ConnectedBuild): void {
    b.peer.accept();
    batch(() => {
      this.buildsSignal.value = [...this.buildsSignal.peek(), b];
      if (!this.activeSignal.peek()) this.activeSignal.value = b;
    });
  }

  private left(peer: DebugLinkPeer): void {
    batch(() => {
      this.pendingSignal.value = this.pendingSignal.peek().filter((p) => p.peer !== peer);
      const builds = this.buildsSignal.peek().filter((b) => b.peer !== peer);
      this.buildsSignal.value = builds;
      if (this.activeSignal.peek()?.peer === peer) this.activeSignal.value = builds[0] ?? null;
    });
  }
}

/** Play while the preferences turn the link off: nothing listens. */
function offBuild(): PlayBuild {
  return {
    code: signal(null),
    tools: signal([]),
    state: signal<PlayBuildState>({ kind: "unavailable", why: "The debug link is off, so tools can't pair with Play. Turn it on in Settings." }),
    stop() {},
  };
}

const refusalKey =(b: Pick<BuildEntry, "remote" | "name">) => `${remoteHost(b.remote)}\n${b.name}`;
