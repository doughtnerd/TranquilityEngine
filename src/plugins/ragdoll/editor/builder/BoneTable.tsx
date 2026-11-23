// The ragdoll builder's per-bone table (ADR 0373; T55): one row per body with its shape, size, mass, swing (y, z), twist (min,
// max), drive (stiffness, damping, maximum force) and pin. Clicking a bone selects its row, which the viewport gizmo shows.
// Each cell edit is a refused-or-next result of `ragdollLogic.ts` (the rules a body holds) handed to `onEdit`, which writes the
// list to the component as one undo step; a body that breaks a rule (hand-edited scene data) is marked with the rule.
import { useState } from "preact/hooks";
import type { EditResult } from "../../../../editor/sdk";
import type { RagdollShape } from "../../runtime/Ragdoll";
import { SHAPES, addBone, bonesWithoutBody, editBone, removeBone, setShape, sizeFields, tableProblems, type BonePatch, type Bones } from "./ragdollLogic";
import "./ragdollBuilder.css";

export interface BoneTableProps {
  readonly bones: Bones;
  /** The bone the gizmo shows, or null. */
  readonly selected: string | null;
  /** The skeleton's bone names, or null while unknown. */
  readonly skeletonBones: readonly string[] | null;
  readonly disabled: boolean;
  onSelect(bone: string | null): void;
  /** Applies a result to the component's `bones` as one labelled undo step; false when it was refused. */
  onEdit(result: EditResult<Bones>, label: string): boolean;
}

const num = (e: Event) => (e.currentTarget as HTMLInputElement).valueAsNumber;

/** One number cell. */
function Cell(props: { label: string; value: number; step: number; min?: number; max?: number; disabled: boolean; onCommit(n: number): void }) {
  return <input type="number" aria-label={props.label} step={props.step} min={props.min} max={props.max} disabled={props.disabled} value={Number(props.value.toFixed(4))} onChange={(e) => props.onCommit(num(e))} />;
}

export function BoneTable(props: BoneTableProps) {
  const { bones, selected, disabled, skeletonBones } = props;
  const [adding, setAdding] = useState("");
  const problems = tableProblems(bones, skeletonBones);
  const free = skeletonBones ? bonesWithoutBody(bones, skeletonBones) : [];
  const edit = (bone: string, patch: BonePatch, what: string) => props.onEdit(editBone(bones, bone, patch), `Set ${what} of ${bone}`);
  return (
    <div class="ragdoll-bodies">
      <div class="ragdoll-table-scroll">
        <table class="ragdoll-table" aria-label="Ragdoll bodies">
          <thead>
            <tr>
              <th scope="col">Bone</th>
              <th scope="col">Shape</th>
              <th scope="col" title="Metres: a capsule's radius and height, a box's sides, a sphere's radius">
                Size
              </th>
              <th scope="col" title="Kilograms">
                Mass
              </th>
              <th scope="col" title="Swing half-angle about the joint's y axis, degrees (0 to 180)">
                Swing Y
              </th>
              <th scope="col" title="Swing half-angle about the joint's z axis, degrees (0 to 180)">
                Swing Z
              </th>
              <th scope="col" title="Twist range about the body's x axis, degrees (-180 to 180)">
                Twist
              </th>
              <th scope="col" title="Powered mode: the joint drive's stiffness (N·m/rad)">
                Stiff.
              </th>
              <th scope="col" title="Powered mode: the joint drive's damping (N·m·s/rad)">
                Damp.
              </th>
              <th scope="col" title="Powered mode: the drive's torque limit (N·m)">
                Max force
              </th>
              <th scope="col" title="How strongly the body is pinned to the animation in powered mode (0 to 1)">
                Pin
              </th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {bones.map((b) => (
              <tr key={b.bone} class={`${selected === b.bone ? "selected" : ""}${problems.has(b.bone) ? " problem" : ""}`} aria-selected={selected === b.bone} title={problems.get(b.bone)}>
                <th scope="row">
                  <button class="ragdoll-bone" aria-label={`Select ${b.bone}`} aria-pressed={selected === b.bone} onClick={() => props.onSelect(selected === b.bone ? null : b.bone)}>
                    {b.bone}
                  </button>
                </th>
                <td>
                  <select aria-label={`Shape of ${b.bone}`} disabled={disabled} value={b.shape} onChange={(e) => props.onEdit(setShape(bones, b.bone, (e.currentTarget as HTMLSelectElement).value as RagdollShape), `Set the shape of ${b.bone}`)}>
                    {SHAPES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div class="ragdoll-size">
                    {sizeFields(b.shape).map((f) => (
                      <Cell key={f.key} label={`${f.label} of ${b.bone}`} value={b.size[f.key]} step={0.01} min={0.005} disabled={disabled} onCommit={(n) => edit(b.bone, { size: { [f.key]: n } }, `the ${f.label.toLowerCase()}`)} />
                    ))}
                  </div>
                </td>
                <td>
                  <Cell label={`Mass of ${b.bone}`} value={b.mass} step={0.1} min={0.01} disabled={disabled} onCommit={(n) => edit(b.bone, { mass: n }, "the mass")} />
                </td>
                <td>
                  <Cell label={`Swing Y of ${b.bone}`} value={b.swing.y} step={1} min={0} max={180} disabled={disabled} onCommit={(n) => edit(b.bone, { swing: { y: n } }, "the swing Y")} />
                </td>
                <td>
                  <Cell label={`Swing Z of ${b.bone}`} value={b.swing.z} step={1} min={0} max={180} disabled={disabled} onCommit={(n) => edit(b.bone, { swing: { z: n } }, "the swing Z")} />
                </td>
                <td>
                  <div class="ragdoll-size">
                    <Cell label={`Twist min of ${b.bone}`} value={b.twist.min} step={1} min={-180} max={180} disabled={disabled} onCommit={(n) => edit(b.bone, { twist: { min: n } }, "the twist minimum")} />
                    <Cell label={`Twist max of ${b.bone}`} value={b.twist.max} step={1} min={-180} max={180} disabled={disabled} onCommit={(n) => edit(b.bone, { twist: { max: n } }, "the twist maximum")} />
                  </div>
                </td>
                <td>
                  <Cell label={`Stiffness of ${b.bone}`} value={b.stiffness} step={10} min={0} disabled={disabled} onCommit={(n) => edit(b.bone, { stiffness: n }, "the stiffness")} />
                </td>
                <td>
                  <Cell label={`Damping of ${b.bone}`} value={b.damping} step={1} min={0} disabled={disabled} onCommit={(n) => edit(b.bone, { damping: n }, "the damping")} />
                </td>
                <td>
                  <Cell label={`Max force of ${b.bone}`} value={b.maxForce} step={10} min={0} disabled={disabled} onCommit={(n) => edit(b.bone, { maxForce: n }, "the maximum force")} />
                </td>
                <td>
                  <Cell label={`Pin of ${b.bone}`} value={b.pin} step={0.1} min={0} max={1} disabled={disabled} onCommit={(n) => edit(b.bone, { pin: n }, "the pin")} />
                </td>
                <td>
                  <button aria-label={`Remove the body of ${b.bone}`} title="Remove this body (its children follow the nearest body above)" disabled={disabled} onClick={() => props.onEdit(removeBone(bones, b.bone), `Remove the body of ${b.bone}`)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {problems.size > 0 && (
        <ul class="ragdoll-problems" aria-label="Body problems">
          {[...problems].map(([bone, why]) => (
            <li key={bone}>
              {bone}: {why}
            </li>
          ))}
        </ul>
      )}
      {skeletonBones && (
        <div class="ragdoll-actions">
          <select aria-label="Bone for a new body" disabled={disabled || free.length === 0} value={adding} onChange={(e) => setAdding((e.currentTarget as HTMLSelectElement).value)}>
            <option value="">{free.length === 0 ? "(every bone has a body)" : "Choose a bone…"}</option>
            {free.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <button
            disabled={disabled || adding === ""}
            onClick={() => {
              if (props.onEdit(addBone(bones, adding, skeletonBones), `Add a body to ${adding}`)) setAdding("");
            }}
          >
            Add Body
          </button>
        </div>
      )}
    </div>
  );
}
