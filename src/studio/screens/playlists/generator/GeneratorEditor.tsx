// The Generator editor (ADR 0360 §9, 0349 kit): a generator's name, kind badge and kind switch (asking first when set
// parameters would be lost), its preset menu, for blips Randomise, Mutate, the seed and `vary`, the waveform preview,
// the parameters as rows generated from the catalogue in their groups (sliders with log scales and real-unit readouts,
// menus for choices, a lock on each parameter presets keep), the audition (hold Play or Space; a one-octave keyboard
// and the computer keys A–K transpose from the generator's pitch) and Bake…. Every change is reported as one labelled
// edit (`onEdit`; a drag coalesces) that the screen applies to the asset document. A view over props.
import { useState } from "preact/hooks";
import { generatorSpec, type GeneratorParamSpec } from "../../../../engine/audio/generators/catalogue";
import { GENERATOR_KINDS, type GeneratorBody, type GeneratorKind } from "../../../../engine/audio/generators/types";
import { ParameterRow } from "../../../components/ParameterRow";
import { formatParam } from "../../../components/parameterRowModel";
import type { Availability } from "./bakeModel";
import {
  applyPreset, generatorRows, hasPresets, kindSwitchQuestion, mutate, parseSeed, presetsOf, randomise, setGeneratorParam, setNote, setSeed, setVary, switchKind, type GeneratorEdit, type GeneratorParamRow,
} from "./generatorModel";
import { GeneratorBadge, GeneratorKeyboard, GeneratorPreview, LockIcon } from "./GeneratorParts";
import type { PreviewPicture } from "./previewClient";
import "../../../components/audioParts.css";
import "./generator.css";

export interface GeneratorAudition {
  /** It can play now (else `reason` says why). */
  readonly available: boolean;
  readonly reason: string | null;
  /** Held gate sources and the semitones each plays. */
  readonly held: ReadonlyMap<string, number>;
}

export interface GeneratorEditorProps {
  readonly body: GeneratorBody;
  readonly title: string;
  /** Where it lives ("audio/ui/coin.generator.json", "Embedded in ui › Clip 2"). */
  readonly where: string;
  readonly writable: boolean;
  readonly locks: readonly string[];
  readonly preview: PreviewPicture | null;
  readonly previewBusy?: boolean;
  readonly audition: GeneratorAudition;
  readonly bake: Availability;
  onEdit(label: string, edit: GeneratorEdit, drag?: boolean): void;
  onToggleLock(name: string): void;
  onGatePress(source: string, semitones: number): void;
  onGateRelease(source: string): void;
  onBake(): void;
}

const VARY_SPEC = { label: "Vary", min: 0, max: 1, step: 0.01, unit: "", default: 0 } as const;

/** A choice parameter's menu (its value is the option's index), as the kit's effect cards draw one. */
function ChoiceRow(props: { spec: GeneratorParamSpec; value: number; disabled: boolean; onValue(v: number): void }) {
  const { spec } = props;
  return (
    <label class="studio-param studio-fx-choice" title={`${spec.label}: ${spec.choices?.[props.value] ?? ""}`}>
      <span>{spec.label}</span>
      <select aria-label={spec.label} value={String(props.value)} disabled={props.disabled} onChange={(e) => props.onValue(Number((e.currentTarget as HTMLSelectElement).value))}>
        {(spec.choices ?? []).map((label, i) => (
          <option key={label} value={String(i)}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ParamLine(props: { row: GeneratorParamRow; writable: boolean; showLocks: boolean; onEdit: GeneratorEditorProps["onEdit"]; onToggleLock(name: string): void }) {
  const { row } = props;
  const set = (v: number, drag = false) => props.onEdit(`Set ${row.spec.label}`, (g) => setGeneratorParam(g, row.name, v), drag);
  return (
    <div class={`gen-row${props.showLocks ? "" : " no-lock"}`} data-param={row.name}>
      {props.showLocks &&
        (row.lockable ? (
          <button
            type="button"
            class={`gen-lock${row.locked ? " on" : ""}`}
            aria-pressed={row.locked}
            aria-label={`Lock ${row.spec.label}`}
            title={row.locked ? `${row.spec.label} is locked: presets, Randomise and Mutate keep it` : `Lock ${row.spec.label} so presets, Randomise and Mutate keep it`}
            disabled={!props.writable}
            onClick={() => props.onToggleLock(row.name)}
          >
            <LockIcon locked={row.locked} />
          </button>
        ) : (
          <span />
        ))}
      {row.choice ? (
        <ChoiceRow spec={row.spec} value={row.value} disabled={!props.writable} onValue={(v) => set(v)} />
      ) : (
        <ParameterRow spec={row.spec} value={row.value} disabled={!props.writable} title={`${row.spec.label}: ${formatParam(row.spec, row.value)}`} onValue={(v, drag) => set(v, drag)} />
      )}
      <span class="gen-readout" aria-label={row.readout ? `${row.spec.label} in real units` : undefined}>{row.readout ?? ""}</span>
    </div>
  );
}

export function GeneratorEditor(props: GeneratorEditorProps) {
  const { body, writable } = props;
  const spec = generatorSpec(body.kind);
  const [asking, setAsking] = useState<{ kind: GeneratorKind; question: string } | null>(null);
  const [seedText, setSeedText] = useState<string | null>(null);
  const groups = generatorRows(spec, body, props.locks);
  const presets = presetsOf(body.kind);
  const blip = body.kind === "blip";
  const hz = body.kind === "oscillator" || body.kind === "synth" ? (body.params.frequency ?? null) : null;
  const held = [...props.audition.held.values()];
  const gateOn = props.audition.held.has("button") || props.audition.held.has("space");
  const seedValid = seedText === null || parseSeed(seedText) !== undefined;
  const chooseKind = (kind: GeneratorKind) => {
    if (kind === body.kind) return;
    const question = kindSwitchQuestion(body, kind);
    if (question) setAsking({ kind, question });
    else props.onEdit(`Switch to ${generatorSpec(kind).label}`, (g) => switchKind(g, kind));
  };
  return (
    <div class="gen-editor" aria-label={`Generator ${props.title}`}>
      <div class="gen-head">
        <GeneratorBadge kind={body.kind} />
        <h2 class="gen-title" title={props.where}>{props.title}</h2>
        <label class="gen-tools">
          Kind
          <select aria-label="Kind" value={body.kind} disabled={!writable} onChange={(e) => chooseKind((e.currentTarget as HTMLSelectElement).value as GeneratorKind)}>
            {GENERATOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {generatorSpec(k).label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" class="gen-bake-btn" disabled={!props.bake.enabled} title={props.bake.reason ?? "Render it to a sample (or several variations)"} onClick={props.onBake}>
          Bake…
        </button>
      </div>
      <p class="gen-where pl-faint">{props.where}</p>

      {(presets.length > 0 || blip) && (
        <div class="gen-tools" role="toolbar" aria-label="Presets">
          {presets.length > 0 && (
            <label>
              Preset
              <select
                aria-label="Preset"
                value={body.preset ?? ""}
                disabled={!writable}
                onChange={(e) => {
                  const id = (e.currentTarget as HTMLSelectElement).value;
                  const label = presets.find((p) => p.id === id)?.label ?? id;
                  if (id) props.onEdit(`Preset ${label}`, (g) => applyPreset(g, id, props.locks));
                }}
              >
                <option value="" disabled>{body.preset ? "" : "Choose…"}</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {blip && (
            <>
              <button type="button" disabled={!writable} title="A new seed drawn from this one, then the preset again (locked parameters stay)" onClick={() => props.onEdit("Randomise", (g) => randomise(g, props.locks))}>
                Randomise
              </button>
              <button type="button" disabled={!writable} title="Nudge every unlocked parameter a little, drawn from the seed" onClick={() => props.onEdit("Mutate", (g) => mutate(g, props.locks))}>
                Mutate
              </button>
              <label title="Presets, Randomise and Mutate draw from it, so the same seed gives the same sound; blank draws the noise afresh each play">
                Seed
                <input
                  type="text"
                  inputMode="numeric"
                  class={`gen-seed${seedValid ? "" : " invalid"}`}
                  aria-label="Seed"
                  aria-invalid={!seedValid}
                  value={seedText ?? (body.seed === null ? "" : String(body.seed))}
                  placeholder="per play"
                  disabled={!writable}
                  onInput={(e) => setSeedText((e.currentTarget as HTMLInputElement).value)}
                  onBlur={() => setSeedText(null)}
                  onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
                  onChange={(e) => {
                    const seed = parseSeed((e.currentTarget as HTMLInputElement).value);
                    if (seed !== undefined) props.onEdit("Set seed", (g) => setSeed(g, seed));
                    setSeedText(null);
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}
      {blip && (
        <div class="gen-vary">
          <ParameterRow spec={VARY_SPEC} value={body.vary} disabled={!writable} title="Per play, each parameter moves by up to this × 5 % of its range" onValue={(v, drag) => props.onEdit("Set vary", (g) => setVary(g, v), drag)} />
        </div>
      )}

      <GeneratorPreview picture={props.preview} busy={props.previewBusy} />

      <div class="gen-audition">
        <button
          type="button"
          class={`gen-play${gateOn ? " on" : ""}`}
          aria-pressed={gateOn}
          disabled={!props.audition.available}
          title={props.audition.reason ?? "Hold to play, let go to release (or hold Space)"}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            props.onGatePress("button", 0);
          }}
          onPointerUp={() => props.onGateRelease("button")}
          onPointerCancel={() => props.onGateRelease("button")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.repeat) props.onGatePress("button", 0);
          }}
          onKeyUp={(e) => e.key === "Enter" && props.onGateRelease("button")}
        >
          {gateOn ? "■ Playing" : "▶ Hold to play"}
        </button>
        {body.kind !== "silence" && (
          <GeneratorKeyboard
            hz={hz}
            held={held}
            disabled={!props.audition.available}
            title={props.audition.reason ?? "Hold a key, or A W S E D F T G Y H U J K, to play a note from the generator's pitch"}
            onPress={props.onGatePress}
            onRelease={props.onGateRelease}
          />
        )}
        {!props.audition.available && props.audition.reason && <span class="pl-faint">{props.audition.reason}</span>}
      </div>

      <div class="gen-groups">
        {groups.map((g) => (
          <fieldset key={g.title} class="gen-group">
            <legend>{g.title}</legend>
            {g.rows.map((r) => (
              <ParamLine key={r.name} row={r} writable={writable} showLocks={hasPresets(body.kind)} onEdit={props.onEdit} onToggleLock={props.onToggleLock} />
            ))}
          </fieldset>
        ))}
      </div>

      <label class="gen-tools">
        Note
        <input type="text" aria-label="Note" value={body.note ?? ""} placeholder="What it's for" disabled={!writable} onChange={(e) => props.onEdit("Edit note", (g) => setNote(g, (e.currentTarget as HTMLInputElement).value))} />
      </label>

      {asking && (
        <div class="pl-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && setAsking(null)}>
          <div class="pl-dialog" role="alertdialog" aria-modal="true" aria-label={`Switch to ${generatorSpec(asking.kind).label}?`} onKeyDown={(e) => e.key === "Escape" && setAsking(null)}>
            <h2 class="pl-dialog-title">Switch to {generatorSpec(asking.kind).label}?</h2>
            <p class="pl-note">{asking.question}</p>
            <div class="pl-dialog-foot">
              <button type="button" onClick={() => setAsking(null)}>Cancel</button>
              <button
                type="button"
                class="pl-danger-btn"
                ref={(el) => el?.focus()}
                onClick={() => {
                  const kind = asking.kind;
                  setAsking(null);
                  props.onEdit(`Switch to ${generatorSpec(kind).label}`, (g) => switchKind(g, kind));
                }}
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
