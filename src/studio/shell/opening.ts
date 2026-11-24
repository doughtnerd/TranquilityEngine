// What the Studio window shows while it waits for the request it was opened for (the launcher's or the editor's
// hand-off, ADR 0380, 0408): a plain "Opening…" rather than its own start screen, which looks like the launcher and made
// opening a take or connecting seem to open the launcher a second time. Null: nothing is pending.
import { signal } from "@preact/signals";

/** The waiting line, or null once the first request is handled (or never came). */
export const studioOpening = signal<string | null>(null);

/** How long the window waits for its request before it shows its start screen after all, ms. */
export const OPENING_TIMEOUT_MS = 10_000;
