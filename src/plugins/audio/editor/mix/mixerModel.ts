// The Mixer panel's strip model (ADR 0171 §6, §7; task Mp1a): pure, no Preact. It builds one strip per bus from the
// authored `audio` section plus the live `Bus` readings, and turns the panel's gestures into mix ops:
//
//   - A fader **drag** previews through `host.apply` + `host.flushNow()` directly (R22: never through the section hook, so
//     nothing enters the undo history while it moves; `flushNow` does its own coalescing to one post per
//     `FADER_COALESCE_MS`), then **one** committed section edit on release, tagged with its ops (`recordMixOps(..., base)`)
//     so the op log trusts them. One edit is one undo step; undo and redo reach the mixer through the op log.
//   - A cancelled drag (Escape) puts the start value back through the same preview path and commits nothing.
//   - A mute toggle or a typed volume is one commit each, with no preview (the hook applies it).
//   - Solo is a monitor control (§6.6): never saved, so it goes to `host.setMonitor` and never commits.
//
// Strips read only: building them never writes the section, so a script's `bus.volume = 0.5` shows in a strip without
// marking the project dirty. The fader's dB taper (`faderModel.ts`) and the meters' hold and clip latch (`meterModel.ts`)
// join in the view; the strip carries the fader value as the linear authored number and the meter as plain numbers.
import { applyOpToDraft, applyOpToSettings, invert, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings, type BusSettings } from "../../../../engine/audio/settings";
import { EMPTY_BUS_LOUDNESS, type BusLoudness } from "../../../../engine/audio/loudnessTypes";
import type { SettingsDraft } from "../../../../editor/sdk";
import { recordMixOps } from "./opLog";

/** The authored fader range (`audio.buses[i].volume`, linear). */
export const FADER_MIN = 0;
export const FADER_MAX = 2;

/** What the model reads of one live bus (a `Bus`'s getters; a test passes plain numbers). */
export interface BusReading {
  /** Script volume (`Bus.volume`). */
  readonly runtimeVolume: number;
  /** Script mute (`Bus.mute`). */
  readonly runtimeMute: boolean;
  /** Script solo (`Bus.solo`). */
  readonly solo: boolean;
  /** Newest peak, linear (`Bus.peak`). */
  readonly peak: number;
  /** Product of every lane up the tree (`Bus.effectiveGain`). */
  readonly effectiveGain: number;
  /** The duck lane, 1 = not ducked (`Bus.duckGain`). */
  readonly duckGain: number;
  readonly activeVoices: number;
  readonly loudness: BusLoudness;
  /** The panel's monitor controls (never saved, §6.6); absent reads false. */
  readonly monitorMute?: boolean;
  readonly monitorSolo?: boolean;
}

/** The meter's plain numbers once `meterModel.ts` has folded the peaks: the strip carries them, it doesn't compute them. */
export interface StripMeter {
  readonly peak: number;
  readonly hold: number;
  readonly clipLatched: boolean;
}

export interface Strip {
  readonly name: string;
  readonly parent: string | null;
  /** Depth in the bus tree (the root is 0). */
  readonly depth: number;
  readonly root: boolean;
  /** The authored fader, linear 0..2 (what a drag changes and what is saved). */
  readonly volume: number;
  /** The authored mute (what the mute button changes and what is saved). */
  readonly mute: boolean;
  /** Reverb send levels on the bus, 0..1, in chain order. */
  readonly sends: readonly number[];
  readonly metered: boolean;
  /** Not playing (no readings): the live fields are at rest. */
  readonly live: boolean;
  readonly runtimeVolume: number;
  readonly runtimeMute: boolean;
  readonly solo: boolean;
  readonly monitorMute: boolean;
  readonly monitorSolo: boolean;
  /** The level reaching the speakers from this bus, beside the authored value (§7). */
  readonly effectiveGain: number;
  readonly duckGain: number;
  readonly activeVoices: number;
  readonly meter: StripMeter;
  readonly loudness: BusLoudness;
  /** A fader drag is in progress on this strip. */
  readonly dragging: boolean;
  /** While dragging, the previewed value (else equal to `volume`). */
  readonly shownVolume: number;
}

/** Where the model reads live buses from: `(name) => reading`, null when none is up (not playing, or no such bus). */
export type ReadBus = (name: string) => BusReading | null;
/** The meters' folded state per bus (`meterModel.ts`), when the view has it. */
export type MeterOf = (name: string) => StripMeter | undefined;

const REST: BusReading = { runtimeVolume: 1, runtimeMute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS };

const clamp = (v: number): number => Math.min(FADER_MAX, Math.max(FADER_MIN, v));

/** Buses in tree order (each after its parent) with their depth. */
function treeOrder(a: AudioSettings): { bus: BusSettings; depth: number }[] {
  const out: { bus: BusSettings; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number): void => {
    for (let i = 0; i < a.buses.length; i++) {
      const bus = a.buses[i]!;
      if (i === 0 ? parent === undefined : bus.parent === parent) {
        out.push({ bus, depth });
        walk(bus.name, depth + 1);
      }
    }
  };
  walk(undefined, 0);
  return out;
}

/**
 * One strip per bus, in tree order. `read` gives the live readings (null: not playing, strips are at rest), `meterOf` the
 * folded meter state, `drag` the strip being dragged and its previewed value. Pure: nothing is written anywhere.
 */
export function buildStrips(
  settings: AudioSettings,
  read: ReadBus = () => null,
  meterOf: MeterOf = () => undefined,
  drag: { bus: string; value: number } | null = null,
): Strip[] {
  const rootName = settings.buses[0]?.name;
  return treeOrder(settings).map(({ bus, depth }) => {
    const r = read(bus.name);
    const live = r !== null;
    const x = r ?? REST;
    const dragging = drag !== null && drag.bus === bus.name;
    return {
      name: bus.name,
      parent: bus.parent ?? null,
      depth,
      root: bus.name === rootName,
      volume: bus.volume,
      mute: bus.mute,
      sends: bus.effects.flatMap((e) => (e.type === "reverb" ? [e.send] : [])),
      metered: bus.name === rootName || bus.meter !== undefined,
      live,
      runtimeVolume: x.runtimeVolume,
      runtimeMute: x.runtimeMute,
      solo: x.solo,
      monitorMute: x.monitorMute ?? false,
      monitorSolo: x.monitorSolo ?? false,
      effectiveGain: x.effectiveGain,
      duckGain: x.duckGain,
      activeVoices: x.activeVoices,
      meter: meterOf(bus.name) ?? { peak: x.peak, hold: x.peak, clipLatched: false },
      loudness: x.loudness,
      dragging,
      shownVolume: dragging ? drag!.value : bus.volume,
    };
  });
}

/** What the model needs of the editor and the play Engine: injected, so tests need neither. */
export interface MixerHost {
  /** The audio section's current draft (the session's `draft`). */
  draft(): SettingsDraft;
  /** `mixer.apply`, or null when no play Engine is up (a preview then goes nowhere; the commit still saves). */
  apply(op: MixOp): ApplyResult;
  /** The backend's `flushNow` (post the staged batch now, coalesced by the backend). */
  flushNow(): void;
  /** One undo step named `label` (the session's `edit`). */
  commit(label: string, next: SettingsDraft): void | Promise<void>;
  /** The monitor lane (`mixer.setMonitor`): never saved, never through `apply`. */
  setMonitor?(bus: string, controls: { mute?: boolean; solo?: boolean }): void;
}

const audioOf = (d: SettingsDraft): AudioSettings => parseAudioSettings(d.audio).settings;
const volumeOp = (bus: string, value: number): MixOp => ({ op: "setBus", bus, key: "volume", value });

interface Drag {
  readonly bus: string;
  readonly start: number;
  value: number;
  /** Whether a preview reached the mixer (a cancel then puts the start value back). */
  previewed: boolean;
}

export interface MixerModel {
  /** The bus being dragged, its previewed value; null when idle. */
  readonly dragging: { readonly bus: string; readonly value: number } | null;
  /** Start a drag on `bus`'s fader. False for an unknown bus or while another drag is open. */
  beginDrag(bus: string): boolean;
  /** Move the open drag to `value` (clamped 0..2): one preview (`apply` + `flushNow`), no undo entry, no commit. */
  drag(value: number): void;
  /** Release: one committed edit (one undo step) when the value moved, none when it came back to the start. */
  endDrag(): boolean;
  /** Escape: the start value goes back through the preview path and nothing is committed. */
  cancelDrag(): void;
  /** A typed fader value: one commit, no preview. */
  setVolume(bus: string, value: number): boolean;
  /** The mute button: one commit. */
  toggleMute(bus: string): boolean;
  /** The solo button: a monitor control (never saved), so never a commit. */
  toggleSolo(bus: string, currentlyOn: boolean): void;
  /** The strips now. */
  strips(read?: ReadBus, meterOf?: MeterOf): Strip[];
}

export function createMixerModel(host: MixerHost): MixerModel {
  let open: Drag | null = null;

  /** Commit `op` as one section edit tagged with its ops and inverse, from the draft as it is now. False when it changes nothing. */
  function commitOp(label: string, op: MixOp): boolean {
    const d = host.draft();
    const before = audioOf(d);
    if (applyOpToSettings(before, op) === before) return false;
    const inverse = invert(op, before);
    const next = applyOpToDraft(d, op);
    if (next === d || typeof next.audio !== "object" || next.audio === null) return false;
    recordMixOps(next.audio as object, { ops: [op], inverse }, d.audio as object);
    void host.commit(label, next);
    return true;
  }

  return {
    get dragging() { return open ? { bus: open.bus, value: open.value } : null; },
    beginDrag(bus) {
      if (open) return false;
      const b = audioOf(host.draft()).buses.find((x) => x.name === bus);
      if (!b) return false;
      open = { bus, start: b.volume, value: b.volume, previewed: false };
      return true;
    },
    drag(value) {
      if (!open || !Number.isFinite(value)) return;
      open.value = clamp(value);
      open.previewed = true;
      host.apply(volumeOp(open.bus, open.value));
      host.flushNow();
    },
    endDrag() {
      const d = open;
      open = null;
      if (!d || !d.previewed || d.value === d.start) return false;
      return commitOp(`Set ${d.bus} volume`, volumeOp(d.bus, d.value));
    },
    cancelDrag() {
      const d = open;
      open = null;
      if (!d || !d.previewed) return;
      host.apply(volumeOp(d.bus, d.start));
      host.flushNow();
    },
    setVolume(bus, value) {
      if (!Number.isFinite(value)) return false;
      return commitOp(`Set ${bus} volume`, volumeOp(bus, clamp(value)));
    },
    toggleMute(bus) {
      const b = audioOf(host.draft()).buses.find((x) => x.name === bus);
      if (!b) return false;
      return commitOp(`${b.mute ? "Unmute" : "Mute"} ${bus}`, { op: "setBus", bus, key: "mute", value: !b.mute });
    },
    toggleSolo(bus, currentlyOn) {
      host.setMonitor?.(bus, { solo: !currentlyOn });
    },
    strips(read, meterOf) {
      return buildStrips(audioOf(host.draft()), read, meterOf, open ? { bus: open.bus, value: open.value } : null);
    },
  };
}

