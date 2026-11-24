// The editor's end of the debug link (ADR 0376): it listens (on this machine, and on the LAN when Preferences allow),
// accepts builds from this machine at once and asks before accepting one from another machine (the accept prompt), keeps
// the connected builds (the status bar's menu), and which one the live debuggers read (`active`). Plugins reach it
// through the SDK (`editorDebugLink()`) and talk to a build through its `DebugLinkPeer` (subscriptions, requests,
// commands). The listening transport is given, so a headless test listens over loopback; in the editor it is the
// WebSocket transport where this host can listen.
import { batch, signal, type ReadonlySignal } from "@preact/signals";
import type { Transport } from "../../engine/net/Transport";
import { DebugLinkListener, type DebugLinkPeer } from "../../engine/debugLink/client";
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
  /** Hears what the link wants the user to read (the editor's message log). */
  readonly log?: (kind: "info" | "warning" | "error", text: string) => void;
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

  constructor(private readonly options: EditorDebugLinkOptions) {}

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

  /** Listens as `prefs` say, closing an earlier listener (and its builds) first. */
  async apply(prefs: DebugLinkPreferences): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    if (!prefs.listen) return;
    const transport = this.options.transport();
    if (!transport) {
      this.stateSignal.value = { kind: "unavailable", why: "This editor can't listen for builds here: a browser page can't open a server socket. The desktop editor can." };
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

  /** Stops listening; every build is disconnected. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.listener?.close();
    this.listener = null;
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

const refusalKey = (b: Pick<BuildEntry, "remote" | "name">) => `${remoteHost(b.remote)}\n${b.name}`;
