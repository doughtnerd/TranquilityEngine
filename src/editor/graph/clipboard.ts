// Copying graph pieces through the system clipboard as text: a JSON payload carrying a `format`
// tag, so a paste from anything else (or another kind of graph) is ignored (ADR 0048, 0060).

/** Put a payload on the system clipboard as JSON (best effort: it may be unavailable or refused). */
export function writeGraphClipboard(payload: { format: string }): void {
  void navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => undefined);
}

/** Read a payload from clipboard text, or null if it isn't one of `format` (or `valid` says no). */
export function parseGraphClipboard<T extends { format: string }>(text: string, format: T["format"], valid: (v: T) => boolean = () => true): T | null {
  try {
    const v = JSON.parse(text) as T;
    return v && v.format === format && valid(v) ? v : null;
  } catch {
    return null;
  }
}
