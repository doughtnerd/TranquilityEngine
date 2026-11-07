import { signal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { art, PRODUCT_NAME, STUDIO_NAME, VERSION } from "../brand";
import { useLightLogo } from "../theme";
import "./brand.css";

/** Whether the About dialog is open. */
export const aboutOpen = signal(false);

/** About Myco Engine: the logo, version and credits (from the toolbar's icon, Settings or the start screen). */
export function AboutDialog() {
  const close = useRef<HTMLButtonElement>(null);
  const open = aboutOpen.value;
  // A layout effect, so Escape works from the first frame the dialog shows.
  useLayoutEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      aboutOpen.value = false;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div class="dialog-backdrop about-backdrop" onPointerDown={(e) => e.target === e.currentTarget && (aboutOpen.value = false)}>
      <div class="dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class={`about-hero${useLightLogo.value ? " light-logo" : ""}`}>
          <img src={useLightLogo.value ? art.mycoLogoLight : art.mycoLogo} alt="" width={320} height={268} />
        </div>
        <h2 id="about-title">About {PRODUCT_NAME}</h2>
        <p class="about-version">Version {VERSION}</p>
        <p>A 2D and 3D TypeScript game engine and editor: Unity-style scripting over an ECS core, a Godot-style node graph.</p>
        <div class="about-studio">
          <img src={art.foxfireIcon} alt="" width={40} height={40} />
          <div>
            <div class="about-studio-name">Made by {STUDIO_NAME}</div>
            <div class="about-credits">Built with three.js, Rapier, Howler, Preact, Monaco and Tauri.</div>
          </div>
        </div>
        <div class="dialog-buttons">
          <button ref={close} onClick={() => (aboutOpen.value = false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
