// Compact value fields for blocks, nodes and the Blackboard (ADR 0060): 0057's number and colour
// forms (constant, random, curve, random curves; colour, random, gradient, random gradients),
// vectors, flags, choices and asset pickers. Curves and gradients show as a small preview that
// opens the curve or gradient editor in a popover, so blocks stay one line per input.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { GraphInputValue } from "../../../engine/scene/particleGraph";
import { colorKind, hexColor, numberKind, parseHexColor, type CurveKey, type ParticleColor, type ParticleColorKind, type ParticleGradient, type ParticleNumber, type ParticleNumberKind } from "../../../engine/scene/particles";
import { fileName } from "../../assetBrowser";
import { NO_DRAG, NO_PAN, NO_WHEEL } from "../../graph";
import { convertColor, convertNumber } from "../../particles/curveEdit";
import { CurveEditor, CurvePreview } from "../particles/CurveEditor";
import { GradientEditor, GradientPreview } from "../particles/GradientEditor";
import { NumField } from "../particles/valueInputs";

const CTRL = `${NO_DRAG} ${NO_WHEEL}`;

const NUMBER_MODES: Record<ParticleNumberKind, string> = { constant: "Constant", random: "Random", curve: "Curve", randomCurves: "Random Curves" };
const COLOR_MODES: Record<ParticleColorKind, string> = { constant: "Constant", random: "Random", gradient: "Gradient", randomGradients: "Random Gradients" };
const DEFAULT_GRADIENT: ParticleGradient = { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** `v[key]` when `v` is an object (`{ curve: keys }` → keys), else `v` itself. */
export const fieldOf = (v: unknown, key: string): unknown => (isObj(v) ? (v as Record<string, unknown>)[key] : v);

/** A value read as a ParticleNumber (anything else reads as `fallback`). */
export function asNumber(v: unknown, fallback: ParticleNumber = 0): ParticleNumber {
  if (typeof v === "number") return v;
  if (isObj(v) && (Array.isArray(v.random) || Array.isArray(v.curve) || Array.isArray(v.randomCurves))) return v as unknown as ParticleNumber;
  return fallback;
}
/** A value read as a ParticleColor. */
export function asColor(v: unknown, fallback: ParticleColor = "#ffffff"): ParticleColor {
  if (typeof v === "string" && v.startsWith("#")) return v;
  if (isObj(v) && (Array.isArray(v.random) || isObj(v.gradient) || Array.isArray(v.randomGradients))) return v as unknown as ParticleColor;
  return fallback;
}
/** A value read as a vector of `n` numbers. */
export const asVector = (v: unknown, n: number): number[] => Array.from({ length: n }, (_, i) => (Array.isArray(v) && typeof v[i] === "number" ? v[i] : 0));
export const asKeys = (v: unknown): CurveKey[] => (Array.isArray(v) && v.every((k) => Array.isArray(k) && typeof k[0] === "number") ? (v as CurveKey[]) : [[0, 0], [1, 1]]);
export const asGradient = (v: unknown): ParticleGradient => (isObj(v) && Array.isArray(v.colors) ? { colors: v.colors as ParticleGradient["colors"], alphas: Array.isArray(v.alphas) ? (v.alphas as ParticleGradient["alphas"]) : [] } : DEFAULT_GRADIENT);

// --- popover -----------------------------------------------------------------------------------------

/** A button showing `preview` that opens `children` in a popover below it; a click outside or Escape closes it. */
export function PopoverButton(props: { label: string; preview: ComponentChildren; children: ComponentChildren; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <span class="pg-pop-anchor" ref={box}>
      <button type="button" class={`pg-pop-button ${CTRL}${open ? " open" : ""}`} aria-label={`Edit ${props.label}`} aria-expanded={open} title={`Edit ${props.label}`} onClick={() => setOpen(!open)}>
        {props.preview}
      </button>
      {open && (
        <div class={`pg-popover ${NO_DRAG} ${NO_PAN} ${NO_WHEEL}${props.wide ? " wide" : ""}`} role="dialog" aria-label={props.label} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {props.children}
        </div>
      )}
    </span>
  );
}

// --- fields ------------------------------------------------------------------------------------------

function ModeSelect<K extends string>(props: { label: string; kind: K; modes: Record<K, string>; forms: readonly string[]; readOnly?: boolean; onPick(k: K): void }) {
  const offered = (Object.keys(props.modes) as K[]).filter((k) => props.forms.includes(k) || k === props.kind);
  if (offered.length < 2) return null;
  return (
    <span class="pg-mode-wrap">
      <select class={`pg-mode ${CTRL}`} aria-label={`${props.label} mode`} title={`${props.modes[props.kind]} (change how it varies)`} disabled={props.readOnly} value={props.kind} onChange={(e) => props.onPick((e.currentTarget as HTMLSelectElement).value as K)}>
        {offered.map((k) => (
          <option key={k} value={k}>
            {props.modes[k]}
          </option>
        ))}
      </select>
    </span>
  );
}

const Unit = (props: { unit?: string }) => (props.unit ? <span class="pg-unit">{props.unit}</span> : null);

/** A number in the forms its input allows. */
export function NumberValue(props: { value: unknown; fallback?: ParticleNumber; forms?: readonly string[]; label: string; min?: number; max?: number; integer?: boolean; unit?: string; readOnly?: boolean; onChange(v: ParticleNumber): void }) {
  const { label, readOnly, onChange } = props;
  const value = asNumber(props.value, props.fallback);
  const kind = numberKind(value);
  const forms = props.forms ?? ["constant"];
  const num = (v: number, l: string, set: (n: number) => void) => <NumField value={v} label={l} min={props.min} max={props.max} integer={props.integer} disabled={readOnly} onCommit={set} />;
  let body: ComponentChildren;
  if (typeof value === "number") body = num(value, label, onChange);
  else if ("random" in value) {
    const [a, b] = value.random;
    body = (
      <span class="pg-pair">
        {num(a, `${label} min`, (n) => onChange({ random: [n, b] }))}
        {num(b, `${label} max`, (n) => onChange({ random: [a, n] }))}
      </span>
    );
  } else if ("curve" in value) {
    body = (
      <PopoverButton label={`${label} curve`} preview={<CurvePreview keys={value.curve} />}>
        <CurveEditor keys={value.curve} label={label} readOnly={readOnly} onChange={(keys) => onChange({ curve: keys })} />
      </PopoverButton>
    );
  } else {
    const [ca, cb] = value.randomCurves;
    body = (
      <PopoverButton label={`${label} curves`} preview={<><CurvePreview keys={ca} /><CurvePreview keys={cb} /></>}>
        <CurveEditor keys={ca} label={`${label} min`} readOnly={readOnly} onChange={(k) => onChange({ randomCurves: [k, cb] })} />
        <CurveEditor keys={cb} label={`${label} max`} readOnly={readOnly} onChange={(k) => onChange({ randomCurves: [ca, k] })} />
      </PopoverButton>
    );
  }
  return (
    <span class="pg-value">
      {body}
      <Unit unit={props.unit} />
      <ModeSelect label={label} kind={kind} modes={NUMBER_MODES} forms={forms} readOnly={readOnly} onPick={(k) => onChange(convertNumber(value, k))} />
    </span>
  );
}

/** A colour swatch with an opacity field (a constant colour keeps its alpha in `#rrggbbaa`). */
export function ColorSwatch(props: { value: string; label: string; readOnly?: boolean; alpha?: boolean; onChange(hex: string): void }) {
  const [r, g, b, a] = parseHexColor(props.value);
  return (
    <span class="pg-swatch">
      <input
        type="color"
        class={CTRL}
        aria-label={props.label}
        disabled={props.readOnly}
        value={hexColor(r, g, b)}
        onInput={(e) => {
          const [nr, ng, nb] = parseHexColor((e.currentTarget as HTMLInputElement).value);
          props.onChange(hexColor(nr, ng, nb, a));
        }}
      />
      {props.alpha !== false && <NumField value={+a.toFixed(3)} label={`${props.label} alpha`} min={0} max={1} disabled={props.readOnly} onCommit={(n) => props.onChange(hexColor(r, g, b, n))} />}
    </span>
  );
}

/** A colour in the forms its input allows. */
export function ColorValue(props: { value: unknown; fallback?: ParticleColor; forms?: readonly string[]; label: string; readOnly?: boolean; onChange(v: ParticleColor): void }) {
  const { label, readOnly, onChange } = props;
  const value = asColor(props.value, props.fallback);
  const kind = colorKind(value);
  let body: ComponentChildren;
  if (typeof value === "string") body = <ColorSwatch value={value} label={label} readOnly={readOnly} onChange={onChange} />;
  else if ("random" in value) {
    const [a, b] = value.random;
    body = (
      <span class="pg-pair">
        <ColorSwatch value={a} label={`${label} min`} readOnly={readOnly} alpha={false} onChange={(c) => onChange({ random: [c, b] })} />
        <ColorSwatch value={b} label={`${label} max`} readOnly={readOnly} alpha={false} onChange={(c) => onChange({ random: [a, c] })} />
      </span>
    );
  } else if ("gradient" in value) {
    body = (
      <PopoverButton label={`${label} gradient`} preview={<GradientPreview gradient={value.gradient} />} wide>
        <GradientEditor gradient={value.gradient} label={label} readOnly={readOnly} onChange={(g) => onChange({ gradient: g })} />
      </PopoverButton>
    );
  } else {
    const [ga, gb] = value.randomGradients;
    body = (
      <PopoverButton label={`${label} gradients`} preview={<><GradientPreview gradient={ga} /><GradientPreview gradient={gb} /></>} wide>
        <GradientEditor gradient={ga} label={`${label} min`} readOnly={readOnly} onChange={(g) => onChange({ randomGradients: [g, gb] })} />
        <GradientEditor gradient={gb} label={`${label} max`} readOnly={readOnly} onChange={(g) => onChange({ randomGradients: [ga, g] })} />
      </PopoverButton>
    );
  }
  return (
    <span class="pg-value">
      {body}
      <ModeSelect label={label} kind={kind} modes={COLOR_MODES} forms={props.forms ?? ["constant"]} readOnly={readOnly} onPick={(k) => onChange(convertColor(value, k))} />
    </span>
  );
}

/** A vector of 2 or 3 numbers. */
export function VectorValue(props: { value: unknown; size: number; label: string; min?: number; integer?: boolean; unit?: string; readOnly?: boolean; onChange(v: number[]): void }) {
  const v = asVector(props.value, props.size);
  return (
    <span class="pg-value pg-vector">
      {v.map((x, i) => (
        <label key={i} class="pg-axis">
          <em>{"xyz"[i]}</em>
          <NumField value={x} label={`${props.label} ${"xyz"[i]}`} min={props.min} integer={props.integer} disabled={props.readOnly} onCommit={(n) => props.onChange(v.map((o, j) => (j === i ? n : o)))} />
        </label>
      ))}
      <Unit unit={props.unit} />
    </span>
  );
}

/** A curve (a list of keys) behind a preview. */
export function CurveValue(props: { keys: CurveKey[]; label: string; readOnly?: boolean; onChange(keys: CurveKey[]): void }) {
  return (
    <span class="pg-value">
      <PopoverButton label={`${props.label} curve`} preview={<CurvePreview keys={props.keys} />}>
        <CurveEditor keys={props.keys} label={props.label} readOnly={props.readOnly} onChange={props.onChange} />
      </PopoverButton>
    </span>
  );
}

/** A gradient behind a preview. */
export function GradientValue(props: { gradient: ParticleGradient; label: string; readOnly?: boolean; onChange(g: ParticleGradient): void }) {
  return (
    <span class="pg-value">
      <PopoverButton label={`${props.label} gradient`} preview={<GradientPreview gradient={props.gradient} />} wide>
        <GradientEditor gradient={props.gradient} label={props.label} readOnly={props.readOnly} onChange={props.onChange} />
      </PopoverButton>
    </span>
  );
}

const choiceLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();

/** One of a list of choices. */
export function ChoiceValue(props: { value: string; choices: readonly string[]; labels?: Record<string, string>; label: string; readOnly?: boolean; onChange(v: string): void }) {
  return (
    <select class={`pg-select ${CTRL}`} aria-label={props.label} disabled={props.readOnly} value={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)}>
      {props.choices.map((c) => (
        <option key={c} value={c}>
          {props.labels?.[c] ?? choiceLabel(c)}
        </option>
      ))}
      {!props.choices.includes(props.value) && <option value={props.value}>{props.value}</option>}
    </select>
  );
}

/** A flag. */
export function BoolValue(props: { value: boolean; label: string; readOnly?: boolean; onChange(v: boolean): void }) {
  return <input type="checkbox" class={CTRL} aria-label={props.label} disabled={props.readOnly} checked={props.value} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />;
}

/**
 * An asset reference picked from the project's assets (`asset:<path>`), or none. `builtins` are
 * offered first (`builtin:cube`…). A reference to a missing file is kept and marked.
 */
export function AssetValue(props: { value: string; assets: readonly string[]; builtins?: readonly string[]; none: string; label: string; readOnly?: boolean; onChange(v: string): void }) {
  const { value } = props;
  const known = new Set([...(props.builtins ?? []), ...props.assets]);
  const label = (ref: string) => (ref.startsWith("builtin:") ? choiceLabel(ref.slice(8)) : fileName(ref.replace(/^asset:/, "")));
  return (
    <select class={`pg-select ${CTRL}`} aria-label={props.label} title={value ? value.replace(/^asset:/, "") : props.none} disabled={props.readOnly} value={value} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value)}>
      <option value="">{props.none}</option>
      {[...(props.builtins ?? []), ...props.assets].map((ref) => (
        <option key={ref} value={ref}>
          {label(ref)}
        </option>
      ))}
      {value && !known.has(value) && <option value={value}>{`${label(value)} (missing)`}</option>}
    </select>
  );
}

/** A block or node input's inline value by type. */
export function InlineValue(props: {
  type: string;
  value: GraphInputValue | undefined;
  fallback?: GraphInputValue;
  forms?: readonly string[];
  choices?: readonly string[];
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  assets?: readonly string[];
  readOnly?: boolean;
  onChange(v: GraphInputValue): void;
}) {
  const { type, label, readOnly, onChange } = props;
  const value = props.value ?? props.fallback;
  const integer = props.step === 1;
  switch (type) {
    case "number":
      return <NumberValue value={value} fallback={asNumber(props.fallback)} forms={props.forms} label={label} min={props.min} max={props.max} integer={integer} unit={props.unit} readOnly={readOnly} onChange={onChange} />;
    case "color":
      return <ColorValue value={value} fallback={asColor(props.fallback)} forms={props.forms} label={label} readOnly={readOnly} onChange={onChange} />;
    case "vector2":
    case "vector3":
      return <VectorValue value={value} size={type === "vector2" ? 2 : 3} label={label} min={props.min} integer={integer} unit={props.unit} readOnly={readOnly} onChange={onChange} />;
    case "bool":
      return <BoolValue value={value === true} label={label} readOnly={readOnly} onChange={onChange} />;
    case "enum":
      return <ChoiceValue value={String(value ?? "")} choices={props.choices ?? []} label={label} readOnly={readOnly} onChange={onChange} />;
    case "curve":
      return <CurveValue keys={asKeys(fieldOf(value, "curve"))} label={label} readOnly={readOnly} onChange={(keys) => onChange({ curve: keys })} />;
    case "gradient":
      return <GradientValue gradient={asGradient(fieldOf(value, "gradient"))} label={label} readOnly={readOnly} onChange={(g) => onChange({ gradient: g })} />;
    case "asset":
      return <AssetValue value={String(value ?? "")} assets={props.assets ?? []} none="(none)" label={label} readOnly={readOnly} onChange={onChange} />;
    default:
      return <span class="pg-faint">{JSON.stringify(value)}</span>;
  }
}
