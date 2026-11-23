// The Generator editor's small parts (ADR 0360 §9, 0349 kit): the kind badge with the generator icon, the one-octave
// keyboard (held keys gate notes, transposed from the generator's pitch; each key names its computer key), and the
// waveform preview (the kit's `Waveform` over the reference render's peaks, with the amplitude envelope and the key-off
// drawn over it). Views over props.
import { useRef } from "preact/hooks";
import type { GeneratorKind } from "../../../../engine/audio/generators/types";
import { Waveform } from "../../../components/Waveform";
import { keyPitchText, noteSource, octaveKeys } from "./auditionGate";
import { GENERATOR_ICON_PATH, generatorBadge } from "./generatorKinds";
import type { PreviewPicture } from "./previewClient";
import "./generator.css";

/** The generator icon (the asset kind's square-over-sine), sized by the font. */
export function GeneratorIcon(props: { readonly title?: string }) {
  return (
    <svg class="gen-icon" viewBox="0 0 24 24" aria-hidden={props.title ? undefined : "true"} role={props.title ? "img" : undefined} aria-label={props.title}>
      <path d={GENERATOR_ICON_PATH} />
    </svg>
  );
}

/** A padlock, shut or open. */
export function LockIcon(props: { readonly locked: boolean }) {
  return (
    <svg class="gen-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={props.locked ? "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" : "M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z"} />
    </svg>
  );
}

/** A generator's kind: the icon and its code (OSC, SYN, BLP, SIL) in the kind's series colour; "GEN" when unknown. */
export function GeneratorBadge(props: { readonly kind: GeneratorKind | null }) {
  const info = props.kind ? generatorBadge(props.kind) : { code: "GEN", name: "Generator (unreadable)", series: 8 };
  return (
    <span class={`studio-badge gen-badge studio-series-${info.series}`} title={info.name} aria-label={info.name} role="img">
      <GeneratorIcon />
      {info.code}
    </span>
  );
}

export interface GeneratorKeyboardProps {
  /** The generator's pitch, for the keys' tooltips (null: it has none to show). */
  readonly hz: number | null;
  /** Semitones held now (lit). */
  readonly held: readonly number[];
  readonly disabled?: boolean;
  readonly title?: string;
  onPress(source: string, semitones: number): void;
  onRelease(source: string): void;
}

/** One octave, C to C: press and hold a key to gate a note; let go (or slide off) to key it off. */
export function GeneratorKeyboard(props: GeneratorKeyboardProps) {
  const down = useRef(new Set<number>());
  const up = (st: number) => {
    if (!down.current.delete(st)) return;
    props.onRelease(noteSource(st));
  };
  return (
    <div class={`gen-keys${props.disabled ? " disabled" : ""}`} role="group" aria-label="Keyboard" title={props.title}>
      {octaveKeys().map((k) => (
        <button
          key={k.semitones}
          type="button"
          class={`gen-key${k.black ? " black" : ""}${props.held.includes(k.semitones) ? " on" : ""}`}
          aria-label={`${k.name} (${keyPitchText(k.semitones, props.hz)})`}
          aria-pressed={props.held.includes(k.semitones)}
          title={`${k.name}: ${keyPitchText(k.semitones, props.hz)} · key ${k.key}`}
          disabled={props.disabled}
          onPointerDown={(e) => {
            if (e.button !== 0 || props.disabled) return;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            down.current.add(k.semitones);
            props.onPress(noteSource(k.semitones), k.semitones);
          }}
          onPointerUp={() => up(k.semitones)}
          onPointerCancel={() => up(k.semitones)}
          onLostPointerCapture={() => up(k.semitones)}
        >
          <span class="gen-key-label">{k.key}</span>
        </button>
      ))}
    </div>
  );
}

export interface GeneratorPreviewProps {
  readonly picture: PreviewPicture | null;
  /** Rendering a newer patch (the old picture stays, dimmed). */
  readonly busy?: boolean;
  /** Why there is no picture (the offline render didn't load), or null. */
  readonly error?: string | null;
}

/** The first 2 s (or to the end) of the generator, with its amplitude envelope and key-off. */
export function GeneratorPreview(props: GeneratorPreviewProps) {
  const pic = props.picture;
  const length = Math.max(pic?.seconds ?? 1, 0.001);
  const env = pic ? pic.envelope.map(([t, v]) => `${((t / length) * 100).toFixed(3)},${((1 - v) * 50).toFixed(3)}`).join(" ") : "";
  const none = props.error ? `No preview: ${props.error}` : "Rendering the preview…";
  const caption = !pic ? none : `${pic.endless ? "First" : "Whole sound:"} ${pic.seconds.toFixed(2)} s${pic.endless ? " (it plays until released)" : ""}${pic.keyOff !== null ? ` · key-off at ${pic.keyOff.toFixed(2)} s` : ""}`;
  return (
    <figure class={`gen-preview${props.busy ? " busy" : ""}`} aria-busy={props.busy || (!pic && !props.error)}>
      <Waveform mips={pic?.mips ?? null} view={{ start: 0, end: length }} length={length} height={96} placeholder={props.error ? "No preview" : "Rendering the preview…"} label="Generator preview">
        {pic && (
          <svg class="gen-envelope" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={env} />
            {pic.keyOff !== null && <line class="gen-keyoff" x1={(pic.keyOff / length) * 100} x2={(pic.keyOff / length) * 100} y1={0} y2={100} />}
          </svg>
        )}
      </Waveform>
      <figcaption class="pl-faint">{caption}</figcaption>
    </figure>
  );
}
