/**
 * What the engine still knows of the retired audio event format (`*.audioevent.json`, `myco.audioevent@1`, ADR 0158):
 * how to recognise a file of it, and the one message every refusal of it gives (ADR 0329: "Exports and the runtime
 * refuse `myco.audioevent@1` with a message naming the migration"). The format's parse is kept only for the migration
 * (`migrate/legacy/`).
 */

export const AUDIO_EVENT_FORMAT = "myco.audioevent@1";
export const AUDIO_EVENT_SUFFIX = ".audioevent.json";

/** Whether `path` names an audio event file (any case). */
export const isAudioEventPath = (path: string): boolean => path.toLowerCase().endsWith(AUDIO_EVENT_SUFFIX);

/** The refusal of the audio event file at `path` (`where` names what refused it, for example `Audio.play`). */
export function audioEventRefusal(where: string, path: string): string {
  return `${where}: "${path}" is an audio event (${AUDIO_EVENT_FORMAT}), which this engine no longer plays. Migrate it to a playlist: open the project in the editor or the Audio Studio (they offer the migration), or run \`npm run audio:migrate -- <project folder>\` (ADR 0329).`;
}
