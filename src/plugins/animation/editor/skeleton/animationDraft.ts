// How the animation cards edit the Import Settings draft (ADR 0143, 0373; T54): the draft's `animation` section (null when
// every value is the default), and applying a refused-or-next edit of it through `applyEdit` onto the draft. Apply and
// Revert are the shell's, so every change a card makes is one change of the draft, written by the one Apply.
import { applyEdit, type EditResult, type ImportSettingsViewProps } from "../../../../editor/sdk";
import { defaultModelAnimationSettings, modelAnimationToJson, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import type { ModelAnimation } from "../../../../engine/scene/models";

/** The draft's animation section, with the defaults when it has none. */
export const animationOf = (draft: ImportSettingsViewProps["draft"]): ModelAnimationSettings => draft.animation ?? defaultModelAnimationSettings();

/**
 * Apply `result` to the draft: a refusal is reported (status bar and message log); an accepted section replaces the draft's
 * (null when it is all defaults, so the sidecar leaves it out). `base` is what the edit started from (the section as
 * the card showed it). Returns whether it was accepted.
 */
export function applyAnimation(props: Pick<ImportSettingsViewProps, "set" | "draft">, result: EditResult<ModelAnimationSettings>, label: string, base: ModelAnimationSettings = animationOf(props.draft)): boolean {
  return applyEdit(result, label, (next) => props.set({ animation: modelAnimationToJson(next) ? next : null }), base);
}

/**
 * The bone map the card shows: the draft's, else the one the importer guessed for the saved profile (`boneMapSource:
 * "guessed"`, in memory: the first edit puts it in the draft, so Apply saves it). `base` is the section with that map in it.
 */
export function workingBoneMap(anim: ModelAnimationSettings, loaded: ModelAnimation | null): { readonly map: Readonly<Record<string, string>>; readonly showingGuess: boolean; readonly guessed: Readonly<Record<string, string>>; readonly base: ModelAnimationSettings } {
  const guessed = loaded?.boneMapSource === "guessed" && (loaded.skeleton?.profile ?? null) === (anim.profile ?? null) ? loaded.boneMap : {};
  const showingGuess = Object.keys(anim.boneMap).length === 0 && Object.keys(guessed).length > 0;
  return { map: showingGuess ? guessed : anim.boneMap, showingGuess, guessed, base: showingGuess ? { ...anim, boneMap: guessed } : anim };
}
