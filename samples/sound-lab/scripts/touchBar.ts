/** One on-screen button: it stands in for `key` (a key name as `Input.getKeyDown` takes it, or any name the page understands). */
export interface TouchButton {
  key: string;
  label: string;
}

/**
 * A row of large buttons over the game view, for a page whose keys a phone can't press. A button press is queued; the
 * page drains the queue in `update` and treats each entry as that key going down, so keyboard and touch share one path.
 * The bar is plain DOM, a strip along the bottom of the game canvas, because a pointer press on a `UIButton` is located from
 * the last pointer move and a touch has none before its press. A press on the bar never reaches the canvas, so it is not a
 * tap for `PointerTaps`. With no DOM (a headless test) the bar is inert.
 */
export class TouchBar {
  private root: HTMLElement | null = null;
  private pending: string[] = [];
  private box = "";

  constructor(buttons: TouchButton[]) {
    if (typeof document === "undefined" || !document.body) return;
    const root = document.createElement("div");
    root.setAttribute("data-touch-bar", "");
    Object.assign(root.style, {
      position: "fixed",
      display: "flex",
      flexWrap: "wrap",
      gap: "6px",
      justifyContent: "center",
      zIndex: "50",
      boxSizing: "border-box",
      pointerEvents: "none",
      userSelect: "none",
    });
    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      el.setAttribute("data-key", b.key);
      Object.assign(el.style, {
        pointerEvents: "auto",
        minWidth: "56px",
        minHeight: "44px",
        padding: "6px 12px",
        font: "600 15px system-ui, sans-serif",
        color: "#fff",
        background: "rgba(20, 23, 28, 0.82)",
        border: "1px solid rgba(255, 255, 255, 0.45)",
        borderRadius: "8px",
        touchAction: "none",
        cursor: "pointer",
      });
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.pending.push(b.key);
      });
      // A focused button takes Space and Enter as a click; keep the keyboard for the page.
      el.addEventListener("keydown", (e) => e.preventDefault());
      root.appendChild(el);
    }
    document.body.appendChild(root);
    this.root = root;
    this.place();
  }

  /** The keys pressed since the last call, in order. Also keeps the bar along the game canvas. */
  drain(): string[] {
    this.place();
    if (this.pending.length === 0) return this.pending;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.pending = [];
  }

  /** Puts the strip along the bottom of the largest focusable canvas (the game view), or of the window. */
  private place(): void {
    const root = this.root;
    if (!root) return;
    let best: DOMRect | null = null;
    const canvases = document.querySelectorAll<HTMLCanvasElement>("canvas[tabindex]");
    for (let i = 0; i < canvases.length; i++) {
      const r = canvases[i]!.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (!best || r.width * r.height > best.width * best.height)) best = r;
    }
    const r = best ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const box = `${r.left}|${r.bottom}|${r.width}|${window.innerHeight}`;
    if (box === this.box) return;
    this.box = box;
    root.style.left = `${r.left + 6}px`;
    root.style.width = `${Math.max(0, r.width - 12)}px`;
    root.style.bottom = `${Math.max(0, window.innerHeight - r.bottom) + 6}px`;
  }
}

/**
 * The tap form of a pointer press: the time stamps (`performance.now()` base, as `KeyboardEvent.timeStamp`) of presses on the
 * game canvas, for a page that times taps. The stamp is the event's own, so a tap isn't up to a frame late.
 */
export class PointerTaps {
  private listener: ((e: PointerEvent) => void) | null = null;
  private times: number[] = [];

  constructor() {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof HTMLCanvasElement === "undefined") return;
    this.listener = (e) => {
      if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement) || e.target.tabIndex < 0) return;
      this.times.push(e.timeStamp);
    };
    window.addEventListener("pointerdown", this.listener, true);
  }

  /** The time stamps of the presses since the last call. */
  drain(): number[] {
    if (this.times.length === 0) return this.times;
    const out = this.times;
    this.times = [];
    return out;
  }

  destroy(): void {
    if (this.listener) window.removeEventListener("pointerdown", this.listener, true);
    this.listener = null;
  }
}
