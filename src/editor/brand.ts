// Product branding (ADR 0037): Myco Engine by Foxfire Studios. The art is the webp masters in
// branding/, resized for the editor into ui/brand/ (logos as WebP, the favicon as PNG).
import { version } from "../../src-tauri/tauri.conf.json";
import foxfireIcon from "./ui/brand/foxfire-icon.webp";
import mycoIcon from "./ui/brand/myco-icon.webp";
import mycoLogo from "./ui/brand/myco-logo.webp";
import mycoLogoLight from "./ui/brand/myco-logo-light.webp";

export const PRODUCT_NAME = "Myco Engine";
export const STUDIO_NAME = "Foxfire Studios";
/** The desktop app's version (src-tauri/tauri.conf.json). */
export const VERSION = version;

/** `mycoLogoLight` is the same art in dark ink with a transparent background, for light themes (ADR 0116). */
export const art = { mycoIcon, mycoLogo, mycoLogoLight, foxfireIcon };
