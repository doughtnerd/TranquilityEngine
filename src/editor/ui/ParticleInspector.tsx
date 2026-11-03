// The Inspector's particle effect editing (ADR 0057): a `*.particles.json` asset selected in the
// Assets panel, and the effect of a selected ParticleSystem (its asset, or the one stored in it).
import { useRef, useState } from "preact/hooks";
import { BUILTIN_MESHES } from "../../engine/scene/models";
import { defaultParticleEffect, parseParticleEffect, particleEffectJSON, type ParticleEffect } from "../../engine/scene/particles";
import { assetKind, fileName, listedFiles } from "../assetBrowser";
import { SetField, type NodePath } from "../document";
import { errorStatus } from "../messages";
import { createParticleEffect, readEffect, writeEffect } from "../particleAssets";
import { selectedAssets } from "../assetSelection";
import { currentProject, docVersion, status, type OpenScene } from "../state";
import { ParticleEffectEditor } from "./particles/ParticleEffectEditor";
import "./assetInspector.css";

/** Asset suggestions for the effect editor's material, texture and mesh fields. */
function assetList(kind: "material" | "texture" | "mesh"): string[] {
  const files = listedFiles(currentProject.value?.files ?? []);
  if (kind === "material") return files.filter((f) => assetKind(f) === "material" || assetKind(f) === "shadergraph").map((f) => `asset:${f}`);
  if (kind === "texture") return files.filter((f) => assetKind(f) === "image").map((f) => `asset:${f}`);
  return [...BUILTIN_MESHES.map((m) => `builtin:${m}`), ...files.filter((f) => assetKind(f) === "model").map((f) => `asset:${f}`)];
}

/**
 * Edits a particle effect asset in place. Each change is written to the file (one after another),
 * and the editor shows the latest change straight away rather than waiting for the write.
 */
function EffectAssetEditor(props: { path: string }) {
  docVersion.value; // rewritten by this editor, or on disk
  const project = currentProject.value;
  const [draft, setDraft] = useState<ParticleEffect | null>(null);
  const pending = useRef(0);
  if (!project) return null;
  const { effect, problems } = readEffect(project, props.path);
  const onChange = (next: ParticleEffect) => {
    setDraft(next);
    const n = ++pending.current;
    writeEffect(project, props.path, next)
      .then(() => {
        docVersion.value++;
        if (pending.current === n) setDraft(null);
      })
      .catch((err) => {
        status.value = errorStatus(`Couldn't save ${fileName(props.path)}`, err);
        if (pending.current === n) setDraft(null);
      });
  };
  return (
    <>
      {problems.length > 0 && (
        <ul class="material-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <ParticleEffectEditor effect={draft ?? effect} onChange={onChange} readOnly={!project.canSave} assetList={assetList} />
    </>
  );
}

/** A particle effect asset selected in the Assets panel. */
export function ParticleEffectInspector(props: { path: string }) {
  const project = currentProject.value;
  return (
    <div class="asset-inspector particle-inspector">
      <h3>{fileName(props.path)}</h3>
      <p class="hint">Particle effect. ParticleSystem components play it; edits show in the scene straight away.</p>
      {project && !project.canSave && <p class="hint">Read-only: open a project folder (or copy the sample) to edit.</p>}
      <EffectAssetEditor path={props.path} />
    </div>
  );
}

/**
 * Under a ParticleSystem's fields: its effect. A referenced asset is edited in place (every system
 * using it changes); an embedded effect is edited through undoable field changes, and can be saved
 * as an asset.
 */
export function ParticleSystemEffect(props: { scene: OpenScene; path: NodePath; index: number; effectPath: string; embedded: unknown }) {
  const { scene, path, index } = props;
  const [id, ...target] = path;
  const asset = props.effectPath.replace(/^asset:/, "");
  const project = currentProject.value;

  if (asset) {
    const missing = !project?.files.includes(asset);
    return (
      <div class="particle-system-effect">
        <div class="particle-effect-source">
          <span>Effect asset</span>
          <button disabled={missing} onClick={() => (selectedAssets.value = [asset])} title="Select the asset in the Assets panel">
            Select Asset
          </button>
        </div>
        {missing ? <p class="hint">"{asset}" isn't in the project.</p> : <EffectAssetEditor path={asset} />}
      </div>
    );
  }

  const set = (field: string, value: unknown) => scene.stack.execute(new SetField(id, "engine.ParticleSystem", field, value, { index, target }));
  if (props.embedded === null || props.embedded === undefined) {
    return (
      <div class="particle-system-effect">
        <p class="hint">No effect: pick a particle effect asset above, or store one in this component.</p>
        <button onClick={() => set("embeddedEffect", particleEffectJSON(defaultParticleEffect()))}>New Embedded Effect</button>
      </div>
    );
  }
  let parsed: { effect: ParticleEffect; problems: string[] };
  try {
    parsed = parseParticleEffect(props.embedded, "the embedded effect");
  } catch (err) {
    parsed = { effect: defaultParticleEffect(), problems: [(err as Error).message] };
  }
  const saveAsAsset = async () => {
    const node = scene.doc.node(id);
    const made = await createParticleEffect("", parsed.effect, node.name || "Particle Effect");
    if (!made) return;
    scene.stack.beginGroup("Save effect as asset");
    try {
      set("effect", `asset:${made}`);
      set("embeddedEffect", null);
    } finally {
      scene.stack.endGroup();
    }
  };
  return (
    <div class="particle-system-effect">
      <div class="particle-effect-source">
        <span>Embedded effect</span>
        <button disabled={!project?.canSave} onClick={() => void saveAsAsset()} title="Write this effect to a .particles.json asset and use that instead">
          Save as Asset
        </button>
      </div>
      {parsed.problems.length > 0 && (
        <ul class="material-problems">
          {parsed.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <ParticleEffectEditor effect={parsed.effect} onChange={(next) => set("embeddedEffect", particleEffectJSON(next))} assetList={assetList} />
    </div>
  );
}
