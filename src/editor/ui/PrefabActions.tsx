// The Inspector's prefab buttons (ADR 0026, 0087, 0122): Apply and Revert All on an instance, Create
// Prefab from one node or several siblings, Apply for several instances, and Open Prefab.
import { RevertOverrides, type NodePath } from "../document";
import { errorStatus } from "../messages";
import { applyOverrides, applyOverridesTo, createPrefab, createPrefabFromNodes } from "../prefabs";
import { openPrefabFrom } from "../prefabTabs";
import type { EditorProject } from "../projects";
import { currentProject, docVersion, selection, status, type OpenScene } from "../state";

const READ_ONLY = "This project is read-only. Open a project folder to";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A button that writes project files: disabled with the read-only reason when the project can't
 * save, else runs `run` with the project and shows the message it returns (or its error).
 */
function SavingButton(props: { label: string; title: string; readOnly: string; disabled?: boolean; run: (project: EditorProject) => Promise<string> }) {
  const project = currentProject.value;
  const canSave = !!project?.canSave;
  return (
    <button
      disabled={!canSave || props.disabled}
      title={canSave ? props.title : `${READ_ONLY} ${props.readOnly}.`}
      onClick={async () => {
        try {
          status.value = { kind: "info", text: await props.run(project!) };
        } catch (err) {
          status.value = errorStatus(null, err);
        }
      }}
    >
      {props.label}
    </button>
  );
}

/** Apply or revert all of an instance's overrides. */
export function PrefabActions(props: { scene: OpenScene; id: string }) {
  docVersion.value; // its props don't change when overrides do, so read the document version
  const { scene, id } = props;
  const count = scene.doc.node(id).overrides?.length ?? 0;
  return (
    <div class="prefab-actions">
      <span class="override-count">{count === 0 ? "No overrides" : plural(count, "override")}</span>
      <SavingButton
        label="Apply"
        title="Write this instance's overrides into the prefab file (updates every instance)"
        readOnly="apply overrides"
        disabled={count === 0}
        run={async (project) => {
          const n = await applyOverrides(scene, project, id);
          return `Applied ${plural(n, "override")} to ${scene.doc.node(id).prefab}. Undo restores them here; the prefab file keeps the change.`;
        }}
      />
      <button disabled={count === 0} title="Remove all overrides: back to the prefab's values" onClick={() => scene.stack.execute(new RevertOverrides(id, "Revert all overrides"))}>
        Revert All
      </button>
      <OpenPrefabButton path={[id]} />
    </div>
  );
}

/** Open the prefab file in its own tab, with this node selected there (ADR 0122). */
export function OpenPrefabButton(props: { path: NodePath }) {
  return (
    <button title="Edit the prefab itself in its own tab (Back returns here)" onClick={() => void openPrefabFrom(props.path)}>
      Open Prefab
    </button>
  );
}

/** Create Prefab for several sibling nodes, and Apply for several instances (ADR 0087). */
export function MultiPrefabActions(props: { scene: OpenScene; paths: NodePath[] }) {
  docVersion.value;
  const { scene, paths } = props;
  if (paths.some((p) => p.length > 1)) return null;
  const ids = paths.map((p) => p[0]);
  const plain = ids.filter((id) => !scene.doc.node(id).prefab);
  const withOverrides = ids.filter((id) => scene.doc.node(id).prefab && (scene.doc.node(id).overrides?.length ?? 0) > 0);
  return (
    <div class="prefab-actions">
      {plain.length === ids.length && (
        <SavingButton
          label="Create Prefab"
          title="Save these nodes as one prefab (under a new Group root) and replace them with an instance"
          readOnly="create prefabs"
          run={async (project) => `Created ${await createPrefabFromNodes(scene, project, ids)}. Undo turns the nodes back; the file stays on disk.`}
        />
      )}
      {withOverrides.length > 0 && (
        <SavingButton
          label="Apply"
          title="Write the selected instances' overrides into their prefab files"
          readOnly="apply overrides"
          run={async (project) => `Applied ${plural(await applyOverridesTo(scene, project, withOverrides), "override")} from ${withOverrides.length} instances.`}
        />
      )}
    </div>
  );
}

/** Save a plain node and its children as a prefab file, making the node an instance of it. */
export function CreatePrefabButton(props: { scene: OpenScene; id: string }) {
  docVersion.value;
  const { scene, id } = props;
  return (
    <div class="prefab-actions">
      <SavingButton
        label="Create Prefab"
        title="Save this node and its children as a prefab file, and make this node an instance of it"
        readOnly="create prefabs"
        run={async (project) => {
          const path = await createPrefab(scene, project, id);
          selection.value = id;
          return `Created ${path}. Undo turns the node back; the file stays on disk.`;
        }}
      />
    </div>
  );
}
