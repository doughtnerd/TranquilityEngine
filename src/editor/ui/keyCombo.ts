// Key combinations as text ("Mod+Shift+Z", "F6", "?", "Space") (ADR 0349): parsed once, matched against keyboard
// events and shown the way each platform writes them ("Ctrl+Shift+Z" on Windows and Linux, "⇧⌘Z" on macOS). `Mod` is
// Cmd on macOS and Ctrl elsewhere. The keyboard shortcuts dialog and the Audio Studio's keymap use it.

export interface KeyCombo {
  /** The key, lower case for letters ("z", "1", "f6", "?", " " for Space, "arrowleft"). */
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

const NAMED: Record<string, string> = { space: " ", esc: "escape", del: "delete", left: "arrowleft", right: "arrowright", up: "arrowup", down: "arrowdown" };

/** Parse "Mod+Shift+Z"; null when it names no key. */
export function parseCombo(text: string): KeyCombo | null {
  const parts = text.split("+").map((p) => p.trim());
  // "Mod++" or a lone "+": the key is a plus sign.
  if (text.endsWith("++") || text === "+") parts.splice(parts.length - 2, 2, "+");
  const combo = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === "mod" || p === "cmdorctrl") combo.mod = true;
    else if (p === "ctrl" || p === "control") combo.ctrl = true;
    else if (p === "alt" || p === "option") combo.alt = true;
    else if (p === "shift") combo.shift = true;
    else if (p !== "") combo.key = NAMED[p] ?? p;
  }
  return combo.key ? combo : null;
}

/** The parts of a keyboard event a combo is matched against. */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** The key an event names, as a combo writes it: letters and digits by physical key where `key` was changed by Alt or Shift. */
function eventKey(e: KeyEventLike): string {
  const key = (e.key ?? "").toLowerCase();
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code) && (e.altKey || key.length !== 1 || !/[a-z]/.test(key))) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code) && (e.altKey || e.shiftKey || !/\d/.test(key))) return code.slice(5);
  return key;
}

/**
 * Whether `e` is `combo` on this platform. Symbols typed with Shift ("?") match by the character, so Shift isn't
 * compared for them; letters, digits and named keys need exactly the combo's modifiers.
 */
export function matchesCombo(combo: KeyCombo, e: KeyEventLike, mac: boolean): boolean {
  const wantCtrl = combo.ctrl || (combo.mod && !mac);
  const wantMeta = combo.mod && mac;
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== combo.alt) return false;
  const symbol = combo.key.length === 1 && !/[a-z0-9 ]/.test(combo.key);
  if (symbol) return (e.key ?? "") === combo.key;
  return e.shiftKey === combo.shift && eventKey(e) === combo.key;
}

const KEY_NAMES: Record<string, string> = { " ": "Space", escape: "Esc", delete: "Del", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", enter: "Enter", backspace: "Backspace", tab: "Tab", home: "Home", end: "End" };
const keyName = (key: string) => KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));

/** How the platform writes `combo`: "Ctrl+Shift+Z", or "⇧⌘Z" on macOS. */
export function formatCombo(combo: KeyCombo, mac: boolean): string {
  if (mac) return `${combo.ctrl ? "⌃" : ""}${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${combo.mod ? "⌘" : ""}${keyName(combo.key)}`;
  return [combo.ctrl || combo.mod ? "Ctrl" : null, combo.alt ? "Alt" : null, combo.shift ? "Shift" : null, keyName(combo.key)].filter(Boolean).join("+");
}

/** `formatCombo` of a combo's text (the text itself when it doesn't parse). */
export const formatKeys = (text: string, mac: boolean): string => {
  const combo = parseCombo(text);
  return combo ? formatCombo(combo, mac) : text;
};

/**
 * A character key shortcut (WCAG 2.1.4): a letter, digit, symbol or Space with no modifier but Shift, which a user can
 * turn off. Function keys, arrows, Delete and the like aren't (they type nothing).
 */
export const isSingleKey = (combo: KeyCombo): boolean => !combo.mod && !combo.ctrl && !combo.alt && combo.key.length === 1;

/** Whether this is macOS (where Mod is ⌘), from the browser. */
export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "");
