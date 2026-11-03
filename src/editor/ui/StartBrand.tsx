import { art, PRODUCT_NAME, STUDIO_NAME, VERSION } from "../brand";
import { aboutOpen } from "./AboutDialog";
import "./brand.css";

/** The start screen's header: the Myco Engine logo (its heading). */
export function StartHeader() {
  return (
    <header class="start-brand">
      <h1 class="start-title">
        <img class="start-logo" src={art.mycoLogo} alt={PRODUCT_NAME} width={240} height={201} />
      </h1>
      <p class="start-tagline">2D &amp; 3D game engine and editor</p>
    </header>
  );
}

/** The start screen's footer: the Foxfire Studios credit, the version and About. */
export function StartFooter() {
  return (
    <footer class="start-footer">
      <img src={art.foxfireIcon} alt="" width={20} height={20} />
      <span>by {STUDIO_NAME}</span>
      <span class="start-footer-sep" aria-hidden="true">·</span>
      <span>v{VERSION}</span>
      <button class="link-button" onClick={() => (aboutOpen.value = true)}>
        About
      </button>
    </footer>
  );
}
