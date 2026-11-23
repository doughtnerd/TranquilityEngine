import { Audio } from "myco";

/**
 * The town music's readout: per playing music playlist (`Audio.debug().events`, the playlist instances under `music/`)
 * its voices and the entries it started late (should stay 0), and the audio clock. `Audio.debug()` allocates, so the text
 * is rebuilt four times a second at most, and only while the readout is on.
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
    const rows = Audio.debug().events.filter((r) => r.asset.startsWith("music/"));
    if (rows.length === 0) {
      this.text = "music: none playing";
      return this.text;
    }
    this.text = rows
      .map((r) => `music ${r.asset.replace(/^.*\//, "").replace(/\.playlist\.json$/, "")}\nvoices ${r.voices}, late ${r.lateStarts}\nclock ${Audio.time.toFixed(2)} s`)
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
