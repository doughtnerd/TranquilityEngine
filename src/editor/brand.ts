// Product branding (ADR 0037): Myco Engine by Foxfire Studios. The art is the webp masters in
// branding/, resized for the editor into ui/brand/ (logos as WebP, the favicon as PNG).
import { version } from "../../src-tauri/tauri.conf.json";
import foxfireIcon from "./ui/brand/foxfire-icon.webp";
import mycoIcon from "./ui/brand/myco-icon.webp";
import mycoLogo from "./ui/brand/myco-logo.webp";

export const PRODUCT_NAME = "Myco Engine";
export const STUDIO_NAME = "Foxfire Studios";
/** The desktop app's version (src-tauri/tauri.conf.json). */
export const VERSION = version;

export const art = { mycoIcon, mycoLogo, foxfireIcon };
