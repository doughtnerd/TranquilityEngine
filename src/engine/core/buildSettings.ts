// `project.json`'s `build` key (ADR 0041, 0446): the game export's settings, read by the exporter and checked by the
// editor's Project panel, with one set of rules for both. The engine never reads it, so nothing the player runs imports
// this module (`settings.ts` reaches it only from `projectSettingsIssues`, which the player doesn't call).
import type { SettingsIssue } from "./settings";

/** Optional build settings in project.json under `build` (read by the exporter only). */
export interface BuildSettings {
  /** A square PNG or SVG in the project for the app icon; default: a neutral generated icon. */
  icon?: string;
  /** Reverse-DNS app identifier (where saves go, and the installer's id); default `com.myco.game.<name>`. */
  identifier?: string;
  /** App version, `x.y.z`; default 0.1.0. */
  version?: string;
}

const IDENTIFIER = /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ICON = /\.(png|svg)$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Everything wrong with a `build` value as written, by field (`"build.identifier"`, `"build.version"`, `"build.icon"`,
 * or `"build"` when it isn't an object). `files` (the project's files) lets the icon be checked for existing; without
 * it, only its form is. Absent: nothing. Other keys in it are kept and not checked.
 */
export function buildSettingsProblems(written: unknown, files?: readonly string[]): SettingsIssue[] {
  if (written === undefined) return [];
  if (!isRecord(written)) return [{ field: "build", message: "Build settings must be an object with an icon, identifier and version." }];
  const problems: SettingsIssue[] = [];
  const { identifier, version, icon } = written;
  if (identifier !== undefined && !(typeof identifier === "string" && IDENTIFIER.test(identifier))) problems.push({ field: "build.identifier", message: "The app identifier must be a reverse-DNS name like com.example.mygame." });
  if (version !== undefined && !(typeof version === "string" && VERSION.test(version))) problems.push({ field: "build.version", message: "The version must look like 1.2.3." });
  if (icon !== undefined) {
    const path = typeof icon === "string" ? icon.replace(/^\.?\//, "") : undefined;
    if (path === undefined || !ICON.test(path)) problems.push({ field: "build.icon", message: "The icon must be a square PNG or SVG file." });
    else if (files && !files.includes(path)) problems.push({ field: "build.icon", message: `${icon} isn't in the project.` });
  }
  return problems;
}
