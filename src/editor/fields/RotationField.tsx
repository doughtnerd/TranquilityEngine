// A rotation field (ADR 0165): a quaternion shown through a rotation codec, as Euler angles in radians or
// degrees or as raw x, y, z, w, one box per axis. Axes that differ across the selection show a dash.
import { signal } from "@preact/signals";
import { Quaternion } from "../../engine";
import { NumberInput } from "./NumberInput";
import { nextRotationView, rotationAxes, rotationCodec, withRotationAxis, type RotationView } from "./rotationCodec";
import "./rotation-field.css";

/** Views a row was switched to with its toggle, by row key; kept while the editor runs. */
const sessionViews = signal<ReadonlyMap<string, RotationView>>(new Map());

/** The view a row shows: the one its toggle picked this session, else `fallback`. */
export const rowRotationView = (key: string | undefined, fallback: RotationView): RotationView => (key !== undefined ? sessionViews.value.get(key) : undefined) ?? fallback;

/** Switch a row to `view` for the rest of the session. */
export function setRowRotationView(key: string, view: RotationView): void {
  sessionViews.value = new Map(sessionViews.value).set(key, view);
}

const DECIMALS: Record<RotationView, number> = { radians: 4, degrees: 3, quaternion: 4 };
const SHORT: Record<RotationView, string> = { radians: "rad", degrees: "deg", quaternion: "xyzw" };
const LONG: Record<RotationView, string> = { radians: "Euler angles in radians", degrees: "Euler angles in degrees", quaternion: "a raw quaternion (x, y, z, w)" };

/** Each shown axis shared by every row of `shown`, or null where they differ. */
export function sharedAxes(shown: readonly (readonly number[])[]): (number | null)[] {
  return (shown[0] ?? []).map((n, i) => (shown.every((s) => s[i] === n) ? n : null));
}

export interface RotationFieldProps {
  /** Each selected node's rotation (unset: the identity). */
  values: readonly (Quaternion | null | undefined)[];
  /** How the row shows the rotation unless its toggle changed it (default radians). */
  view?: RotationView;
  label: string;
  /** Names the row for its view toggle; without one the row has no toggle. */
  toggleKey?: string;
  /** Each node's new rotation, in `values` order, after an axis edit. */
  onCommit: (next: Quaternion[]) => void;
}

export function RotationField(props: RotationFieldProps) {
  const { toggleKey, label } = props;
  const view = rowRotationView(toggleKey, props.view ?? "radians");
  const codec = rotationCodec(view);
  const rotations = props.values.map((q) => (q instanceof Quaternion ? q : Quaternion.identity));
  const shown = sharedAxes(rotations.map((q) => codec.read(q)));
  const axes = rotationAxes(view);
  const commitAxis = (axis: number, n: number) => props.onCommit(rotations.map((q) => withRotationAxis(q, view, axis, n)));
  const next = nextRotationView(view);
  return (
    <span class="rotation-field">
      <span class={`vec rotation-axes rotation-${view}`}>
        {axes.map((a, i) => (
          <label key={`${view}-${a}`} class="axis">
            <em>{a}</em>
            <NumberInput value={shown[i] ?? null} decimals={DECIMALS[view]} label={`${label} ${a}`} onCommit={(n) => commitAxis(i, n)} />
          </label>
        ))}
      </span>
      {toggleKey !== undefined && (
        <button
          class="rotation-view"
          title={`Shown as ${LONG[view]}. Click to show ${LONG[next]} (this row, this session).`}
          aria-label={`${label}: show ${LONG[next]}`}
          onClick={() => setRowRotationView(toggleKey, next)}
        >
          {SHORT[view]}
        </button>
      )}
    </span>
  );
}
