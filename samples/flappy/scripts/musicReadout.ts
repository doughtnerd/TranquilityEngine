import { Audio } from "myco";

/**
 * The town music's health readout (the phone prime lead, P1 of the M4 listening pass): per playing music instance
 * `Audio.debug().music`'s `leadMs` (how far ahead of the audio clock the player plans a start), `primeEmaMs` (the smoothed
 * time the decoder takes to ready the streamed stem, with the last one) and `lateGroups` and `groupsHeld` (both should stay 0).
 * `Audio.debug()` allocates, so the text is rebuilt four times a second at most, and only while the readout is on.
 */
export class MusicReadout {
  on = false;
  private text = "";
  private at = -Infinity;

  toggle(): boolean {
    this.on = !this.on;
    this.at = -Infinity;
    return this.on;
  }

  /** The readout's text (empty while it is off). */
  lines(now = performance.now()): string {
    if (!this.on) return "";
    if (now - this.at < 250) return this.text;
    this.at = now;
    const rows = Audio.debug().music ?? [];
    if (rows.length === 0) {
      this.text = "music: none playing";
      return this.text;
    }
    const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
    this.text = rows
      .map((r) => `music ${r.asset.replace(/^.*\//, "").replace(/\.audioevent\.json$/, "")}\nlead ${f(r.leadMs)} ms\nprime ${f(r.primeEmaMs)} ms (last ${f(r.primeLastMs)})\nlate ${r.lateGroups}, held ${r.groupsHeld}`)
      .join("\n");
    return this.text;
  }
}

/**
 * A small "music" button for a touch screen, which has no M key: a round chip in the bottom-right corner of the window that
 * toggles the readout. It is only made where the primary pointer is coarse (a phone or tablet), and is plain DOM because a
 * touch press has no pointer position for the UI to hit-test before it lands. A press on it doesn't reach the game (no flap).
 */
export function touchToggle(onPress: () => void): () => void {
  if (typeof document === "undefined" || !document.body || typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches) return () => {};
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = "♪";
  el.setAttribute("aria-label", "Music readout");
  Object.assign(el.style, {
    position: "fixed",
    right: "8px",
    bottom: "8px",
    width: "44px",
    height: "44px",
    zIndex: "50",
    font: "600 22px system-ui, sans-serif",
    color: "#fff",
    background: "rgba(0, 0, 0, 0.35)",
    border: "1px solid rgba(255, 255, 255, 0.4)",
    borderRadius: "22px",
    touchAction: "none",
  });
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    onPress();
  });
  document.body.appendChild(el);
  return () => el.remove();
}
