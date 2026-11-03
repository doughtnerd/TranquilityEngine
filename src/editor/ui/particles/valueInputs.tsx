import { useEffect, useRef, useState } from "preact/hooks";
import { colorKind, hexColor, numberKind, parseHexColor, type CurveKey, type ParticleColor, type ParticleColorKind, type ParticleGradient, type ParticleNumber, type ParticleNumberKind } from "../../../engine/scene/particles";
import { convertColor, convertNumber } from "../../particles/curveEdit";
import { CurveEditor, CurvePreview } from "./CurveEditor";
import { GradientEditor, GradientPreview } from "./GradientEditor";
import "./particles.css";

const formatNumber = (n: number) => String(+n.toFixed(4));

/**
 * A number field that commits as it is typed whenever the text reads as a number (so a half-typed
 * "0." or "-" waits), and shows the committed value again on blur.
 */
export function NumField(props: { value: number; onCommit: (v: number) => void; label: string; integer?: boolean; min?: number; max?: number; disabled?: boolean }) {
  const shown = formatNumber(props.value);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);
  const clamp = (n: number) => {
    const v = props.integer ? Math.round(n) : n;
    return Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input pe-num"
      aria-label={props.label}
      disabled={props.disabled}
      value={draft}
      onFocus={() => (focused.current = true)}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLInputElement).value;
        setDraft(text);
        const n = text.trim() === "" ? NaN : Number(text);
        if (Number.isFinite(n) && clamp(n) !== props.value) props.onCommit(clamp(n));
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(shown);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(shown);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Three number fields, x y z. */
export function VecField(props: { value: [number, number, number]; onChange: (v: [number, number, number]) => void; label: string; disabled?: boolean }) {
  return (
    <span class="pe-vec">
      {(["x", "y", "z"] as const).map((axis, i) => (
        <label key={axis} class="pe-axis">
          <em>{axis}</em>
          <NumField
            value={props.value[i]}
            label={`${props.label} ${axis}`}
            disabled={props.disabled}
            onCommit={(n) => props.onChange(props.value.map((x, j) => (j === i ? n : x)) as [number, number, number])}
          />
        </label>
      ))}
    </span>
  );
}

const NUMBER_MODES: [ParticleNumberKind, string][] = [
  ["constant", "Constant"],
  ["random", "Random"],
  ["curve", "Curve"],
  ["randomCurves", "Random Curves"],
];
const COLOR_MODES: [ParticleColorKind, string][] = [
  ["constant", "Constant"],
  ["random", "Random"],
  ["gradient", "Gradient"],
  ["randomGradients", "Random Gradients"],
];

/** A row: the label, the value editor, and the mode dropdown. */
function ValueRow(props: { label: string; children: preact.ComponentChildren; mode: preact.ComponentChildren; expanded?: preact.ComponentChildren }) {
  return (
    <div class="pe-value-row">
      <div class="pe-row">
        <span class="pe-label" title={props.label}>
          {props.label}
        </span>
        <span class="pe-value">{props.children}</span>
        {props.mode}
      </div>
      {props.expanded}
    </div>
  );
}

/**
 * A number that can be a constant, a random range, a curve over life, or a random value between
 * two curves (ADR 0057). Curves show as a sparkline that opens the full editor when clicked.
 * `allowCurves` false offers just Constant and Random.
 */
export function ParticleNumberInput(props: { value: ParticleNumber; onChange: (v: ParticleNumber) => void; label: string; allowCurves?: boolean; readOnly?: boolean }) {
  const { value, onChange, label, readOnly } = props;
  const kind = numberKind(value);
  const [open, setOpen] = useState(false);
  const modes = props.allowCurves === false ? NUMBER_MODES.slice(0, 2) : NUMBER_MODES;
  const mode = (
    <select class="pe-mode" aria-label={`${label} mode`} title={`${label}: ${kind} (change how it varies)`} disabled={readOnly} value={kind} onChange={(e) => onChange(convertNumber(value, (e.currentTarget as HTMLSelectElement).value as ParticleNumberKind))}>
      {modes.map(([k, name]) => (
        <option key={k} value={k}>
          {name}
        </option>
      ))}
      {!modes.some(([k]) => k === kind) && <option value={kind}>{NUMBER_MODES.find(([k]) => k === kind)![1]}</option>}
    </select>
  );
  if (typeof value === "number") {
    return (
      <ValueRow label={label} mode={mode}>
        <NumField value={value} label={label} disabled={readOnly} onCommit={onChange} />
      </ValueRow>
    );
  }
  if ("random" in value) {
    const [a, b] = value.random;
    return (
      <ValueRow label={label} mode={mode}>
        <span class="pe-pair">
          <NumField value={a} label={`${label} min`} disabled={readOnly} onCommit={(n) => onChange({ random: [n, b] })} />
          <NumField value={b} label={`${label} max`} disabled={readOnly} onCommit={(n) => onChange({ random: [a, n] })} />
        </span>
      </ValueRow>
    );
  }
  const toggle = (previews: preact.ComponentChildren) => (
    <button type="button" class={`pe-expand${open ? " open" : ""}`} aria-label={`${label} ${open ? "collapse" : "expand"}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      {previews}
    </button>
  );
  if ("curve" in value) {
    const curve = value.curve;
    return (
      <ValueRow
        label={label}
        mode={mode}
        expanded={open && <CurveEditor keys={curve} label={label} readOnly={readOnly} onChange={(keys) => onChange({ curve: keys })} />}
      >
        {toggle(<CurvePreview keys={curve} />)}
      </ValueRow>
    );
  }
  const [ca, cb] = value.randomCurves;
  const set = (i: 0 | 1, keys: CurveKey[]) => onChange({ randomCurves: i === 0 ? [keys, cb] : [ca, keys] });
  return (
    <ValueRow
      label={label}
      mode={mode}
      expanded={
        open && (
          <>
            <CurveEditor keys={ca} label={`${label} min`} readOnly={readOnly} onChange={(k) => set(0, k)} />
            <CurveEditor keys={cb} label={`${label} max`} readOnly={readOnly} onChange={(k) => set(1, k)} />
          </>
        )
      }
    >
      {toggle(
        <>
          <CurvePreview keys={ca} />
          <CurvePreview keys={cb} />
        </>,
      )}
    </ValueRow>
  );
}

/** A colour with an opacity field (the constant colour's alpha lives in its `#rrggbbaa`). */
function ColorSwatch(props: { value: string; onChange: (hex: string) => void; label: string; disabled?: boolean }) {
  const [r, g, b, a] = parseHexColor(props.value);
  return (
    <span class="pe-color-field">
      <input
        type="color"
        class="pe-color"
        aria-label={props.label}
        disabled={props.disabled}
        value={hexColor(r, g, b)}
        onInput={(e) => {
          const [nr, ng, nb] = parseHexColor((e.currentTarget as HTMLInputElement).value);
          props.onChange(hexColor(nr, ng, nb, a));
        }}
      />
      <NumField value={+a.toFixed(3)} label={`${props.label} alpha`} min={0} max={1} disabled={props.disabled} onCommit={(n) => props.onChange(hexColor(r, g, b, n))} />
    </span>
  );
}

/**
 * A colour that can be constant (with opacity), a random pair, a gradient over life, or a random
 * value between two gradients (ADR 0057). `allowGradients` false offers just Constant and Random;
 * `gradientOnly` just the two gradient modes.
 */
export function ParticleColorInput(props: { value: ParticleColor; onChange: (v: ParticleColor) => void; label: string; allowGradients?: boolean; gradientOnly?: boolean; readOnly?: boolean }) {
  const { value, onChange, label, readOnly } = props;
  const kind = colorKind(value);
  const [open, setOpen] = useState(false);
  const modes = props.gradientOnly ? COLOR_MODES.slice(2) : props.allowGradients === false ? COLOR_MODES.slice(0, 2) : COLOR_MODES;
  const mode = (
    <select class="pe-mode" aria-label={`${label} mode`} title={`${label}: ${kind} (change how it varies)`} disabled={readOnly} value={kind} onChange={(e) => onChange(convertColor(value, (e.currentTarget as HTMLSelectElement).value as ParticleColorKind))}>
      {modes.map(([k, name]) => (
        <option key={k} value={k}>
          {name}
        </option>
      ))}
      {!modes.some(([k]) => k === kind) && <option value={kind}>{COLOR_MODES.find(([k]) => k === kind)![1]}</option>}
    </select>
  );
  if (typeof value === "string") {
    return (
      <ValueRow label={label} mode={mode}>
        <ColorSwatch value={value} label={label} disabled={readOnly} onChange={onChange} />
      </ValueRow>
    );
  }
  if ("random" in value) {
    const [a, b] = value.random;
    return (
      <ValueRow label={label} mode={mode}>
        <span class="pe-pair">
          <ColorSwatch value={a} label={`${label} min`} disabled={readOnly} onChange={(c) => onChange({ random: [c, b] })} />
          <ColorSwatch value={b} label={`${label} max`} disabled={readOnly} onChange={(c) => onChange({ random: [a, c] })} />
        </span>
      </ValueRow>
    );
  }
  const toggle = (previews: preact.ComponentChildren) => (
    <button type="button" class={`pe-expand${open ? " open" : ""}`} aria-label={`${label} ${open ? "collapse" : "expand"}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      {previews}
    </button>
  );
  if ("gradient" in value) {
    const g = value.gradient;
    return (
      <ValueRow label={label} mode={mode} expanded={open && <GradientEditor gradient={g} label={label} readOnly={readOnly} onChange={(n) => onChange({ gradient: n })} />}>
        {toggle(<GradientPreview gradient={g} />)}
      </ValueRow>
    );
  }
  const [ga, gb] = value.randomGradients;
  const set = (i: 0 | 1, g: ParticleGradient) => onChange({ randomGradients: i === 0 ? [g, gb] : [ga, g] });
  return (
    <ValueRow
      label={label}
      mode={mode}
      expanded={
        open && (
          <>
            <GradientEditor gradient={ga} label={`${label} min`} readOnly={readOnly} onChange={(g) => set(0, g)} />
            <GradientEditor gradient={gb} label={`${label} max`} readOnly={readOnly} onChange={(g) => set(1, g)} />
          </>
        )
      }
    >
      {toggle(
        <>
          <GradientPreview gradient={ga} />
          <GradientPreview gradient={gb} />
        </>,
      )}
    </ValueRow>
  );
}
