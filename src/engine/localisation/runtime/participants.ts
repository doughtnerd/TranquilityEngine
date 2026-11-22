/**
 * Language participants (ADR 0342 §6, the internal seam 0343 uses): systems that must have a language ready before a
 * switch to it completes. `Locale.setLanguage(code)` (and the start language at boot) runs every participant's
 * `prepare(code)` beside loading the language's strings, and changes the language only once all of them settled, so
 * the switch is atomic: UI fonts (`ui/fonts.ts`) load the language's font files; the audio runtime can load the voice
 * language's packages the same way.
 *
 * A participant that rejects is warned about and doesn't stop the switch (text then draws in the fallback font); a
 * participant bounds its own waiting (fonts wait at most 3 s). Nothing here is public API.
 */

export interface LanguageParticipant {
  /** For warnings: "fonts", "voice". */
  readonly name: string;
  /** Get `code` ready (a pseudo-language passes the reference language's code). */
  prepare(code: string): Promise<void> | void;
}

const participants = new Set<LanguageParticipant>();

/** Add a participant to every language switch from now on; returns its removal. */
export function registerLanguageParticipant(p: LanguageParticipant): () => void {
  participants.add(p);
  return () => participants.delete(p);
}

/** Run every participant's `prepare(code)`; resolves once all settled (never rejects). */
export async function prepareParticipants(code: string): Promise<void> {
  await Promise.all(
    [...participants].map(async (p) => {
      try {
        await p.prepare(code);
      } catch (err) {
        console.warn(`[myco] Language "${code}": ${p.name} couldn't get ready (${(err as Error)?.message ?? err}); switching anyway.`);
      }
    }),
  );
}
