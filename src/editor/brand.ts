// Product branding (ADR 0037): Myco Engine by Foxfire Studios. The art is the webp masters in
// branding/, resized for the editor into ui/brand/ (logos as WebP, the favicon as PNG).
import { version } from "../../src-tauri/tauri.conf.json";
import foxfireIcon from "./ui/brand/foxfire-icon.webp";
import mycoIcon from "./ui/brand/myco-icon.webp";
import mycoLogo from "./ui/brand/myco-logo.webp";
import mycoLogoLight from "./ui/brand/myco-logo-light.webp";
import foxfireSplash from "./ui/brand/foxfire-splash.webp";
import mycoSplash from "./ui/brand/myco-splash.webp";
import biosonicLogo from "./ui/brand/biosonic-logo.webp";
import biosonicIcon from "./ui/brand/biosonic-icon.webp";

export const PRODUCT_NAME = "Myco Engine";
export const STUDIO_NAME = "Foxfire Studios";
/** The audio design app's name (ADR 0380): its projects screen and the launcher's card. The Studio's own screens still say Audio Studio. */
export const AUDIO_APP_NAME = "Biosonic";
/** The desktop app's version (src-tauri/tauri.conf.json). */
export const VERSION = version;

/** `mycoLogoLight` is the same art in dark ink with a transparent background, for light themes (ADR 0116). `biosonicIcon` is the headphones of the Biosonic logo without its wordmark, the Audio Studio's header mark (ADR 0420). */
export const art = { mycoIcon, mycoLogo, mycoLogoLight, foxfireIcon, biosonicIcon };

/** The launcher's art (ADR 0380), on the brand black in every theme: the studio's and each app's splash logo (3:2, 1:1 for Biosonic). */
export const launcherArt = { foxfireSplash, mycoSplash, biosonicLogo };
