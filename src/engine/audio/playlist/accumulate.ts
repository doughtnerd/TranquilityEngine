/**
 * Down-the-tree accumulation (ADR 0329 "Down the tree"; the prototype's `resolve`, PL:909–913): what a voice inherits
 * from every playlist and entry above it.
 *
 * - gains add in dB, pitch adds in semitones;
 * - pan takes the deepest non-zero value;
 * - low-pass takes the minimum cutoff, high-pass the maximum;
 * - playlist effects (`fx`, the part of a level that comes from a playlist's own effect chain) accumulate the same way
 *   but are dropped where a playlist overrides its `output`: its audio leaves the parent's mix there, so the parent's
 *   effects don't apply to it.
 *
 * Pure; no plugin, no DOM.
 */

/** The no-filter cutoffs. */
export const LOWPASS_NONE = 24000;
export const HIGHPASS_NONE = 0;

/** The playlist-effect part of a level, mapped onto voice controls until instance submixes run effect chains (ADR 0331). */
export interface EffectProps {
  gainDb: number;
  lowpass: number;
  highpass: number;
}

/** What a voice has inherited so far. */
export interface VoiceProps {
  gainDb: number;
  pitchSt: number;
  /** -1..1; 0 = centre (also "not set"). */
  pan: number;
  lowpass: number;
  highpass: number;
  fx: EffectProps;
}

/** One level's contribution (any field may be absent). */
export interface LevelProps {
  gainDb?: number;
  pitchSt?: number;
  pan?: number;
  lowpass?: number;
  highpass?: number;
  /** This level's playlist effects. */
  fx?: Partial<EffectProps>;
  /** The level overrides the output bus: the parent's playlist effects stop here. */
  outputOverride?: boolean;
}

export const NO_EFFECTS: Readonly<EffectProps> = Object.freeze({ gainDb: 0, lowpass: LOWPASS_NONE, highpass: HIGHPASS_NONE });

export const rootProps = (): VoiceProps => ({ gainDb: 0, pitchSt: 0, pan: 0, lowpass: LOWPASS_NONE, highpass: HIGHPASS_NONE, fx: { ...NO_EFFECTS } });

/** `parent` with one more level below it. A new object; `parent` is unchanged. */
export function accumulate(parent: Readonly<VoiceProps>, level: LevelProps): VoiceProps {
  const base = level.outputOverride ? NO_EFFECTS : parent.fx;
  const fx: EffectProps = {
    gainDb: base.gainDb + (level.fx?.gainDb ?? 0),
    lowpass: Math.min(base.lowpass, level.fx?.lowpass ?? LOWPASS_NONE),
    highpass: Math.max(base.highpass, level.fx?.highpass ?? HIGHPASS_NONE),
  };
  return {
    gainDb: parent.gainDb + (level.gainDb ?? 0),
    pitchSt: parent.pitchSt + (level.pitchSt ?? 0),
    pan: level.pan !== undefined && level.pan !== 0 ? level.pan : parent.pan,
    lowpass: Math.min(parent.lowpass, level.lowpass ?? LOWPASS_NONE),
    highpass: Math.max(parent.highpass, level.highpass ?? HIGHPASS_NONE),
    fx,
  };
}

/** The voice's final controls: the levels and the playlist effects combined. */
export function voiceControls(p: Readonly<VoiceProps>): { gainDb: number; pitchSt: number; pan: number; lowpass: number; highpass: number } {
  return {
    gainDb: p.gainDb + p.fx.gainDb,
    pitchSt: p.pitchSt,
    pan: p.pan,
    lowpass: Math.min(p.lowpass, p.fx.lowpass),
    highpass: Math.max(p.highpass, p.fx.highpass),
  };
}
