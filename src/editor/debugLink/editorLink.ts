// The editor's end of the debug link (ADR 0376): it listens (on this machine, and on the LAN when Preferences allow),
// accepts builds from this machine at once and asks before accepting one from another machine (the accept prompt), keeps
// the connected builds (the status bar's menu), and which one the live debuggers read (`active`). Plugins reach it
// through the SDK (`editorDebugLink()`) and talk to a build through its `DebugLinkPeer` (subscriptions, requests,
// commands). The listening transport is given, so a headless test listens over loopback; in the editor it is the
// WebSocket transport where this host can listen.
import { batch, computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { Engine } from "../../engine/core/Engine";
import { createTransport, type Transport } from "../../engine/net/Transport";
import { DebugLinkListener, ToolConnector, type DebugLinkPeer } from "../../engine/debugLink/client";
import type { EndpointKind } from "../../engine/debugLink/protocol";
import { DEFAULT_DEBUG_LINK_PORT } from "../../engine/debugLink/config";
import type { NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";
import { nativeInterfaces } from "../../engine/debugLink/tauriListener";
import { TokenGate } from "../../engine/debugLink/pairing/gate";
import {
  RoomJoinTransport,
  RoomOffer,
  currentPage,
  hasWebRtc,
  roomPlace,
  roomTokenBits,
  type PageLocation,
  type RoomOfferState,
  type RoomWebRtcOptions,
} from "../../engine/debugLink/rooms";
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
  /** How room codes travel (ADR 0404): joining a build's room by its code, and offering a room (`offerRoom`). */
  readonly rooms?: EditorRoomOptions;
  /** Hears what the link wants the user to read (the editor's message log). */
  readonly log?: (kind: "info" | "warning" | "error", text: string) => void;
}

/** How the link's rooms are reached (defaults: a page's WebSocket and `RTCPeerConnection`, the page's own location). */
export interface EditorRoomOptions {
  /** The transport each rendezvous connection uses (default `websocket`; tests pass `loopback`). */
  readonly signalTransport?: string;
  /** Its options (the loopback's clock in tests). */
  readonly signalOptions?: Readonly<Record<string, unknown>>;
  /** The `webrtc` transport's options (the Preferences' ICE servers are added to them). */
  readonly webrtc?: RoomWebRtcOptions;
  /** Where this page was loaded from, for where its rooms open (default the global `location`; null for none). */
  readonly page?: PageLocation | null;
  /** The offered room's gate clock, ms (default `performance.now`). */
  readonly now?: () => number;
  /** The offered room's token and room number source (default `crypto.getRandomValues`). */
  readonly randomToken?: (bits: number) => number;
}

/** A room this tool offers (`offerRoom`): a build given its code (`?debug-code=`) joins it. */
export interface OfferedRoom {
  /** The room code to show (it changes after each pairing and expiry), or null while none is open. */
  readonly code: ReadonlySignal<string | null>;
  /**
   * Where the offer stands: opening a room, waiting with a code, a build joining, retrying after the rendezvous failed,
   * or unavailable (no rendezvous this tool can use: `why`).
   */
  readonly state: ReadonlySignal<RoomOfferState | { readonly kind: "unavailable"; readonly why: string }>;
  /** A sentence to show beside the code (a page opened from `localhost` pairs only with builds on this machine), or null. */
  readonly notice: string | null;
  /** Stops offering (builds already paired stay connected). */
  stop(): void;
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
  /** The last error each build sent for the link itself: a build says why before it closes the link (ADR 0376). */
  private readonly linkErrors = new WeakMap<DebugLinkPeer, string>();

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
      onClose: (peer) => {
        const error = this.linkErrors.get(peer);
        if (error !== undefined) this.options.log?.("error", `Debug link: "${peer.hello.name}" closed the link: ${error}`);
        this.left(peer);
      },
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
    this.roomJoin?.connector.poll();
    const offered = this.offered;
    if (offered) {
      offered.listener.poll();
      if (this.offered !== offered) return;
      const state = offered.offer.state;
      const was = offered.state.peek();
      if (state.kind !== was.kind || ("code" in state && "code" in was && state.code !== was.code) || ("why" in state && "why" in was && state.why !== was.why)) {
        batch(() => {
          offered.state.value = state;
          offered.code.value = offered.offer.code;
        });
      }
    }
  }

  /**
   * Offers a rendezvous room (ADR 0404, the reverse direction): where this tool can't be reached by a build (a browser
   * Studio or editor), it opens a room on its own server's rendezvous, or the hosted one in Settings, and shows the room
   * code; a build launched with it (`?debug-code=`, `--debug-code`) joins the room and connects over WebRTC, and joins
   * `builds` without a prompt once its token passes this room's gate (the rendezvous checked it too). A later call
   * replaces an earlier offer; `stop` ends it (and the builds that paired through it), as `stop()` and `apply()` do.
   */
  offerRoom(): OfferedRoom {
    this.endOffer();
    const kind = this.ownKind();
    const rooms = this.options.rooms;
    const webrtc = this.webrtcOptions();
    const page = rooms?.page === undefined ? currentPage() : rooms.page;
    const place = roomPlace(kind, page, this.prefs?.rendezvous || null, hasWebRtc(webrtc));
    const code = signal<string | null>(null);
    if (place.kind === "none") return { code, state: signal({ kind: "unavailable", why: place.message }), notice: null, stop() {} };
    const now = rooms?.now ?? (() => performance.now());
    const random = rooms?.randomToken ?? defaultRandomToken;
    const gate = new TokenGate({ now, randomToken: random, tokenBits: roomTokenBits(place) });
    const offer = new RoomOffer({ place, gate, kind, signalTransport: () => this.signalTransport(), webrtc, now, randomRoom: random });
    const listener = new DebugLinkListener(offer, { onPeer: (peer) => this.arrived(peer), onClose: (peer) => this.left(peer) }, { gate, sameMachine: () => false });
    const offered: Offered = { listener, offer, code, state: signal<OfferedRoom["state"]["value"]>({ kind: "opening" }) };
    this.offered = offered;
    void listener.listen(place.url);
    this.startTimer();
    return {
      code,
      state: offered.state,
      notice: place.notice,
      stop: () => {
        if (this.offered === offered) this.endOffer();
      },
    };
  }

  private offered: Offered | null = null;

  private endOffer(why = "The room offer stopped."): void {
    const offered = this.offered;
    if (!offered) return;
    this.offered = null;
    offered.listener.close();
    batch(() => {
      offered.code.value = null;
      offered.state.value = { kind: "unavailable", why };
    });
  }

  private ownKind(): EndpointKind {
    return "__TAURI_INTERNALS__" in globalThis ? "native" : typeof location !== "undefined" && location.protocol === "https:" ? "page-https" : "page-http";
  }

  /** The `webrtc` options rooms use: the given ones plus the Preferences' ICE servers. */
  private webrtcOptions(): RoomWebRtcOptions {
    const ice = this.prefs?.iceServers ?? [];
    return { ...this.options.rooms?.webrtc, ...(ice.length > 0 ? { iceServers: ice.map((urls) => ({ urls })) } : {}) };
  }

  private signalTransport(): Transport {
    return createTransport(this.options.rooms?.signalTransport ?? "websocket", { ...this.options.rooms?.signalOptions });
  }

  private roomJoin: { readonly transport: RoomJoinTransport; readonly connector: ToolConnector } | null = null;

  /** The connector that joins builds' rooms (made on the first room code: it needs WebRTC). */
  private ensureRoomJoin(): { readonly transport: RoomJoinTransport; readonly connector: ToolConnector } {
    if (this.roomJoin) return this.roomJoin;
    const kind = this.ownKind();
    const transport = new RoomJoinTransport({ kind, signalTransport: () => this.signalTransport(), webrtc: this.webrtcOptions() });
    const connector = new ToolConnector(transport, {
      kind,
      name: this.options.name ?? "Myco editor",
      events: { onPeer: (peer) => this.joined(peer), onClose: (peer) => this.left(peer) },
    });
    this.roomJoin = { transport, connector };
    this.startTimer();
    return this.roomJoin;
  }

  private startTimer(): void {
    if (this.options.autoPoll !== false && this.timer === null) this.timer = setInterval(() => this.poll(), this.options.pollMs ?? 33);
  }

  /**
   * Connects to a listening build (ADR 0403): by the code it shows, or a typed address. Resolves once it paired (it
   * joins `builds` at once: the tool chose to connect, so there is no prompt); rejects with the reason
   * (`connectFlow.ts`). C7: the flow is U1's.
   */
  async connect(target: ConnectTarget): Promise<void> {
    const connector = this.ensureConnector();
    const interfaces = await this.machineInterfaces();
    const page = this.options.rooms?.page === undefined ? currentPage() : this.options.rooms.page;
    const link = this;
    return connectToBuild(target, {
      connector,
      interfaces: () => interfaces,
      pageHost: page?.hostname ?? null,
      waitFor: (done, timeoutMs) => this.waitFor(done, timeoutMs),
      rooms: {
        get connector() {
          return link.ensureRoomJoin().connector;
        },
        kind: this.ownKind(),
        hosted: this.prefs?.rendezvous || null,
        webrtc: hasWebRtc(this.webrtcOptions()),
        refusal: (address) => this.roomJoin?.transport.refusal(address) ?? null,
      },
    });
  }

  /**
   * Serves the play Engine as a build on this link while the editor plays (ADR 0403, U3), so a tool can pair with
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
    this.connector = new ToolConnector(createTransport("websocket"), {
      kind: this.ownKind(),
      name: this.options.name ?? "Myco editor",
      events: { onPeer: (peer) => this.joined(peer), onClose: (peer) => this.left(peer) },
    });
    this.startTimer();
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
    this.roomJoin?.connector.close();
    this.roomJoin = null;
    this.endOffer("The debug link restarted; offer a room again.");
    batch(() => {
      this.buildsSignal.value = [];
      this.pendingSignal.value = [];
      this.activeSignal.value = null;
      this.stateSignal.value = { kind: "off" };
    });
  }

  private arrived(peer: DebugLinkPeer): void {
    peer.onError = (message) => this.linkErrors.set(peer, message);
    const b: ConnectedBuild = { id: this.nextId++, name: peer.hello.name, platform: peer.hello.platform, remote: peer.remote, peer };
    // A build whose pair carried the shown code's token (a room's, `offerRoom`) needs no prompt: the person gave it the code.
    if (peer.admission === "token" || isLocalRemote(peer.remote)) return this.admit(b);
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

/** An offered room as the link keeps it. */
interface Offered {
  readonly listener: DebugLinkListener;
  readonly offer: RoomOffer;
  readonly code: Signal<string | null>;
  readonly state: Signal<OfferedRoom["state"]["value"]>;
}

function defaultRandomToken(bits: number): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! % 2 ** bits;
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
