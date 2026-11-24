// The pairing overlay of a build with debugging on (ADR 0403 "Pairing code"): a small corner box showing the listener's
// current code (or the address to type when it has none) while no tool is connected, hidden once one pairs, shown again
// when the last one leaves; F8 toggles it at any time. A page's code is a room code (ADR 0404), with the listener's
// notice under it or in its place (opening the room, why it can't, or that a page opened from `localhost` pairs only on
// this machine). The player imports this module only by `import()` and only when
// `game.json` has `debug` (vite.shared.ts `DEBUG_LINK` matches it), so a release export holds none of it.
//
// It is a game overlay, not editor chrome, so it uses neutral fixed styling (a dark translucent box, light monospace
// text) instead of the editor's theme tokens, readable over any game. Plain DOM; the player has no UI framework.

/** What the overlay reads from the build's listener (a `BuildListener` satisfies it); read again at each update. */
export interface OverlaySource {
  readonly code: string | null;
  readonly address: string;
  readonly tools: readonly unknown[];
  /**
   * A sentence beside the code, or in place of it when there is none (a page's room: "Opening a pairing room…", why it
   * can't open one, or "open this page by its network address…" from `localhost`); null or absent: none.
   */
  readonly notice?: string | null;
}

export interface OverlayElement {
  hidden: boolean;
  textContent: string | null;
  style: { cssText: string };
  remove(): void;
}

interface KeyEventLike {
  readonly key: string;
  preventDefault(): void;
}

/** The slice of the page the overlay uses (the global `window` satisfies it). */
export interface OverlayHost {
  readonly document: {
    createElement(tag: "div"): OverlayElement;
    readonly body: { append(el: OverlayElement): void };
  };
  addEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  removeEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
}

export interface DebugOverlayOptions {
  /** The page (default: the global window). */
  readonly host?: OverlayHost;
  /**
   * What drives `update` (default: every animation frame, so a code the gate issues shows within a frame). Called once
   * with `update`; returns the function that stops it.
   */
  readonly schedule?: (update: () => void) => () => void;
}

export interface DebugOverlay {
  /** Whether the box is showing now. */
  readonly visible: boolean;
  /** Re-reads the source: its code, and whether a tool is connected. */
  update(): void;
  /** Removes the box and its key listener. */
  dispose(): void;
}

const STYLE =
  "position:fixed;right:8px;bottom:8px;z-index:2147483647;padding:6px 10px;border-radius:4px;" +
  "background:rgba(20,20,20,0.82);color:#f2f2f2;font:13px/1.3 ui-monospace,Consolas,monospace;" +
  "pointer-events:none;user-select:none;white-space:pre";

/** The box's text: the code to type into the tool (with the notice under it), else the notice, else the address. */
function overlayText(source: OverlaySource): string {
  const notice = source.notice || null;
  if (source.code) return `Debug pairing code: ${source.code}\n${notice ? `${notice}\n` : ""}(F8 hides this)`;
  if (notice) return `Debug link: ${notice}\n(F8 hides this)`;
  return `Debug link: type the address: ${source.address}\n(F8 hides this)`;
}

function frameLoop(tick: () => void): () => void {
  let id = 0;
  const loop = () => {
    tick();
    id = requestAnimationFrame(loop);
  };
  id = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(id);
}

/** Shows the overlay for `source` and keeps it up to date. */
export function installDebugOverlay(source: OverlaySource, options: DebugOverlayOptions = {}): DebugOverlay {
  const host = options.host ?? (window as unknown as OverlayHost);
  const box = host.document.createElement("div");
  box.style.cssText = STYLE;
  host.document.body.append(box);

  let visible = true;
  let connected: boolean | null = null; // the last connection state seen: a change resets F8's choice
  const render = () => {
    box.hidden = !visible;
    box.textContent = overlayText(source);
  };
  const update = () => {
    const now = source.tools.length > 0;
    if (now !== connected) {
      connected = now;
      visible = !now;
    }
    render();
  };
  const onKey = (e: KeyEventLike) => {
    if (e.key !== "F8") return;
    e.preventDefault();
    visible = !visible;
    render();
  };
  host.addEventListener("keydown", onKey);
  update();

  const stop = (options.schedule ?? frameLoop)(update);
  return {
    get visible() {
      return visible;
    },
    update,
    dispose() {
      stop();
      host.removeEventListener("keydown", onKey);
      box.remove();
    },
  };
}
