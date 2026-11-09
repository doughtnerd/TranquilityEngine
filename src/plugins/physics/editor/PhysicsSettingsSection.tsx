// The Project panel's Physics category (ADR 0038, 0116, 0137): gravity, the 2D and 3D physics backend, the
// physics layers, and which layers collide as a triangle of checkboxes. Edits go through the panel's undo history.
import { defaultSettings } from "../../../engine/core/settings";
import { collides, addLayer, layersOf, MAX_LAYERS, removeLayer, setCollides, setGravity } from "../../../editor/projectSettingsModel";
import { renameLayerEdit } from "../../../editor/layerRenameEdit";
import { physicsBackends, type PhysicsDimension } from "../runtime";
import { backendOf, backendOptions, setBackend } from "./physicsEditorModel";
import { type ProjectSettingsSectionProps, type SettingsDraft, type SettingsProblem, NameList, ProblemList, Row, NumberField } from "../../../editor/sdk";
import "./physicsSettings.css";

export function PhysicsSettingsSection(props: ProjectSettingsSectionProps) {
  const { draft, set, fieldProblems } = props;
  const gravity = draft.physics?.gravity;
  const at = (field: string) => fieldProblems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
  return (
    <>
      <Row label="Gravity" problems={at("physics.gravity")}>
        <span class="project-settings-pair">
          <NumberField id="ps-gx" label="Gravity x" value={gravity?.[0]} placeholder={String(defaultSettings.physics.gravity[0])} suffix="x" onCommit={(v) => set("Set gravity", setGravity(draft, 0, v ?? defaultSettings.physics.gravity[0]))} />
          <NumberField id="ps-gy" label="Gravity y" value={gravity?.[1]} placeholder={String(defaultSettings.physics.gravity[1])} suffix="y" onCommit={(v) => set("Set gravity", setGravity(draft, 1, v ?? defaultSettings.physics.gravity[1]))} />
          <NumberField id="ps-gz" label="Gravity z" value={gravity?.[2]} placeholder="0" suffix="z" onCommit={(v) => set("Set gravity", setGravity(draft, 2, v ?? 0))} />
        </span>
      </Row>
      <BackendRow dimension="2d" draft={draft} set={set} problems={at("physics.backend2d")} />
      <BackendRow dimension="3d" draft={draft} set={set} problems={at("physics.backend3d")} />
      <Layers {...props} />
    </>
  );
}

/** A dimension's backend: a dropdown of the registered backends, "Default (only registered)" when unset. */
function BackendRow(props: { dimension: PhysicsDimension; draft: SettingsDraft; set(label: string, next: SettingsDraft): void; problems: readonly SettingsProblem[] }) {
  const { dimension, draft, set } = props;
  const current = backendOf(draft, dimension);
  const options = backendOptions(physicsBackends(dimension), current || undefined);
  const name = dimension.toUpperCase();
  return (
    <Row label={`${name} backend`} problems={props.problems}>
      <select
        class="physics-backend-select"
        aria-label={`${name} physics backend`}
        value={current}
        onChange={(e) => set(`Set ${name} physics backend`, setBackend(draft, dimension, (e.currentTarget as HTMLSelectElement).value))}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Physics layers, and which of them collide as a triangle of checkboxes. */
function Layers(props: ProjectSettingsSectionProps) {
  const { draft, project, set, fieldProblems } = props;
  const layers = layersOf(draft);
  const matrixProblems = fieldProblems.filter((p) => p.field === "physics.collisionMatrix");
  const ctx = { project, set, refresh: props.refresh };
  return (
    <>
      <NameList
        title="Layers"
        hint="renaming updates the colliders that use a layer"
        names={layers}
        field="physics.layers"
        problems={fieldProblems}
        item="layer"
        fixed={(i) => i === 0}
        addDisabled={layers.length >= MAX_LAYERS}
        onAdd={() => set("Add physics layer", addLayer(draft))}
        onRename={(i, v) => void renameLayerEdit(ctx, "physics", draft, i, v)}
        onRemove={(i) => set(`Remove physics layer ${layers[i]}`, removeLayer(draft, i))}
      />
      <div class="project-settings-list" role="group" aria-label="Collisions">
        <div class="project-settings-list-head">
          <span>Collisions</span>
          <span class="project-settings-hint">{draft.physics?.collisionMatrix ? "checked pairs collide" : "every layer collides with every layer"}</span>
        </div>
        {matrixProblems.length > 0 && <ProblemList list={matrixProblems.map((p) => p.message)} label="Collision problems" />}
        <table class="collision-matrix">
          <thead>
            <tr>
              <th />
              {[...layers].reverse().map((l) => (
                <th key={l} scope="col" class="collision-col">
                  <span>{l}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {layers.map((a, i) => (
              <tr key={a}>
                <th scope="row">{a}</th>
                {[...layers].reverse().map((b, k) => {
                  const j = layers.length - 1 - k;
                  if (j < i) return <td key={b} />;
                  const on = collides(draft, a, b);
                  return (
                    <td key={b}>
                      <input
                        type="checkbox"
                        aria-label={`${a} collides with ${b}`}
                        title={`${a} ↔ ${b}`}
                        checked={on}
                        onChange={(e) => {
                          const next = (e.currentTarget as HTMLInputElement).checked;
                          set(`${next ? "Collide" : "Don't collide"} ${a} with ${b}`, setCollides(draft, a, b, next));
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
