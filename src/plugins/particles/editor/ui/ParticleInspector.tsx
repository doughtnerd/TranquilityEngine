// The Inspector's particle effect parts (ADR 0060): a `*.particles.json` graph asset selected in the
// Assets panel (a summary), and under a ParticleSystem component the effect's exposed properties as
// per-instance overrides. Effects are edited in the Particle Graph panel, not here.
import type { ComponentChildren } from "preact";
import { expandParticleGraph, projectAssets } from "../../../../engine/scene/particleSubgraphs";
import type { GraphProperty, ParticleGraph } from "../../../../engine/scene/particleGraph";
import { compileParticleGraph } from "../../../../engine/scene/particleCompile";
import type { CurveKey, ParticleColor, ParticleGradient } from "../../../../engine/scene/particles";
import { effectFileMigrated, particleDocument } from "../particleAssets";
import { parseBlockAsset, parseSubgraphAsset, type AssetPort } from "../../../../engine/scene/particleSubgraphs";
import { assetDocKind, docToAsset } from "../particleGraph/assetDocs";
import { CurveEditor } from "./particles/ParticleCurve";
import { GradientEditor } from "./particles/GradientEditor";
import { NumField, ParticleColorInput, VecField } from "./particles/valueInputs";
import { AssetDocumentFrame, editor, type NodePath, type OpenScene, LargePreview, sectionField, type InspectorSectionProps } from "../../../../editor/sdk";

/** What compiling a graph reports (its parse problems are the document's). */
const compileProblems = (graph: ParticleGraph): string[] => compileParticleGraph(expandParticleGraph(graph, projectAssets).graph).problems.map((p) => p.message);

/**
 * A particle effect asset selected in the Assets panel: what it holds, and a way into the graph. It shows the asset
 * document the Particle Graph edits, in the asset document frame (ADR 0265): the current value with unwritten edits,
 * its problems and the compiler's, Undo / Redo of its history and the read-only notice. It makes no edits itself.
 */
export function ParticleEffectInspector(props: { path: string }) {
  editor.project.version; // rewritten on disk
  const project = editor.project.current;
  if (!project) return null;
  const doc = particleDocument(project, props.path);
  const graph = doc.value.value;
  const migrated = effectFileMigrated(project, props.path);
  const exposed = graph.properties.filter((p) => p.exposed);
  return (
    <AssetDocumentFrame doc={doc} kind="Particle effect" class="asset-inspector particle-inspector" problems={compileProblems(graph)}>
      <p class="hint">ParticleSystem components play it; edit it in the Particle Graph.</p>
      <button onClick={() => editor.assets.open(props.path)}>Open in Particle Graph</button>
      {/* The shared thumbnail renderer's live preview (ADR 0061): no WebGL context of its own, and it
          restarts only when the effect's file (or what it uses) changes. */}
      <div class="particle-inspector-preview" aria-label="Particle effect preview">
        <LargePreview path={props.path} />
      </div>
      {migrated && <p class="hint">An older particle effect file. It's converted to a graph the first time it's edited.</p>}
      <dl class="particle-summary">
        <dt>Systems</dt>
        <dd>
          {graph.systems.length === 0 ? (
            "none"
          ) : (
            <ul>
              {graph.systems.map((s) => (
                <li key={s.id}>
                  {s.name}
                  {s.enabled === false ? " (off)" : ""}: {s.spawn.blocks.length} spawn, {s.initialize.blocks.length} initialize, {s.update.blocks.length} update, {s.output.blocks.length} output
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Nodes</dt>
        <dd>{graph.nodes.length}</dd>
        <dt>Exposed properties</dt>
        <dd>{exposed.length === 0 ? "none" : exposed.map((p) => `${p.name} (${p.type})`).join(", ")}</dd>
      </dl>
    </AssetDocumentFrame>
  );
}

const portList = (ports: readonly AssetPort[]) => (ports.length === 0 ? "none" : ports.map((p) => `${p.name} (${p.type})`).join(", "));

/** A particle sub-graph or custom block asset selected in the Assets panel (ADR 0095, 0126): its ports, and a way into the graph. */
export function ParticleAssetInspector(props: { path: string }) {
  editor.project.version;
  const project = editor.project.current;
  if (!project) return null;
  const kind = assetDocKind(props.path);
  // The asset document the Particle Graph edits (ADR 0265): its current value, unwritten edits included, read by the
  // kind's format; a file that isn't one reads with that as its problem, which the frame lists.
  const doc = particleDocument(project, props.path);
  const raw = doc.problems.value.length > 0 ? null : docToAsset(doc.value.value);
  const sub = kind === "subgraph" ? parseSubgraphAsset(raw) : null;
  const block = kind === "block" ? parseBlockAsset(raw) : null;
  const asset = sub ?? block;
  return (
    <AssetDocumentFrame doc={doc} kind={kind === "block" ? "Particle block asset" : "Particle sub-graph asset"} class="asset-inspector particle-inspector">
      <p class="hint">
        {kind === "block"
          ? "Particle block: a stack of blocks and nodes that a Custom block runs in the contexts below. Edit it in the Particle Graph."
          : "Particle sub-graph: a group of nodes used as one Sub-graph node. Edit it in the Particle Graph."}
      </p>
      <button onClick={() => editor.assets.open(props.path)}>Open in Particle Graph</button>
      {asset && (
        <dl class="particle-summary">
          {block && (
            <>
              <dt>Label</dt>
              <dd>{block.label}</dd>
              <dt>Contexts</dt>
              <dd>{block.contexts.join(", ") || "none"}</dd>
            </>
          )}
          <dt>Inputs</dt>
          <dd>{portList(asset.inputs)}</dd>
          {sub && (
            <>
              <dt>Outputs</dt>
              <dd>{portList(sub.outputs)}</dd>
            </>
          )}
          <dt>Nodes</dt>
          <dd>{asset.nodes.length}</dd>
          {block && (
            <>
              <dt>Blocks</dt>
              <dd>{block.blocks.length}</dd>
            </>
          )}
        </dl>
      )}
    </AssetDocumentFrame>
  );
}

const imageAssets = (): string[] => editor.assets.listed(editor.project.current?.files ?? []).filter((f) => editor.assets.kindOf(f) === "image").map((f) => `asset:${f}`);

type Override = number | readonly number[] | string | boolean | Record<string, unknown>;

/** The input for one property's value, by type. */
function PropertyInput(props: { prop: GraphProperty; value: unknown; onChange: (v: Override) => void; onGesture: () => void }) {
  const { prop, value, onChange } = props;
  const label = prop.name;
  switch (prop.type) {
    case "number":
      return <NumField label={label} value={typeof value === "number" ? value : 0} onCommit={onChange} />;
    case "vector2": {
      const v = Array.isArray(value) ? value : [0, 0];
      return (
        <span class="pe-vec">
          {[0, 1].map((i) => (
            <NumField key={i} label={`${label} ${"xy"[i]}`} value={Number(v[i] ?? 0)} onCommit={(n) => onChange(i === 0 ? [n, Number(v[1] ?? 0)] : [Number(v[0] ?? 0), n])} />
          ))}
        </span>
      );
    }
    case "vector3": {
      const v = Array.isArray(value) ? value : [0, 0, 0];
      return <VecField label={label} value={[Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)]} onChange={onChange} />;
    }
    case "color": {
      const color: ParticleColor = typeof value === "string" ? value : "#ffffff";
      return <ParticleColorInput label={label} value={color} allowGradients={false} onChange={(c) => onChange(c as string)} />;
    }
    case "curve": {
      const keys: CurveKey[] = value && typeof value === "object" && "curve" in value ? (value as { curve: CurveKey[] }).curve : [[0, 1], [1, 1]];
      return (
        <div onPointerDownCapture={props.onGesture}>
          <CurveEditor label={label} keys={keys} onChange={(k) => onChange({ curve: k })} />
        </div>
      );
    }
    case "gradient": {
      const gradient: ParticleGradient = value && typeof value === "object" && "gradient" in value ? (value as { gradient: ParticleGradient }).gradient : { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 1]] };
      return (
        <div onPointerDownCapture={props.onGesture}>
          <GradientEditor label={label} gradient={gradient} onChange={(g) => onChange({ gradient: g })} />
        </div>
      );
    }
    case "texture":
      return (
        <>
          <input type="text" class="pe-text" aria-label={label} list="particle-property-textures" value={typeof value === "string" ? value : ""} placeholder="(none)" onChange={(e) => onChange((e.currentTarget as HTMLInputElement).value)} />
          <datalist id="particle-property-textures">
            {imageAssets().map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </>
      );
  }
}

/**
 * Under a ParticleSystem's fields: open its effect in the Particle Graph (or make a new one), and
 * set its exposed properties for this instance. Overrides are undoable field changes.
 */
function ParticleSystemEffect(props: { scene: OpenScene; path: NodePath; index: number; effectPath: string; embedded?: unknown; overrides?: unknown }) {
  editor.project.version;
  const { scene, path, index } = props;
  const [id] = path;
  const asset = props.effectPath.replace(/^asset:/, "");
  const project = editor.project.current;
  const set = (field: string, value: unknown) => editor.scene.writeField({ scene, path, type: "engine.ParticleSystem", index }, field, value);
  const hasEmbedded = props.embedded !== null && props.embedded !== undefined;

  if (!asset) {
    return (
      <div class="particle-system-effect">
        <p class="hint">{hasEmbedded ? "This system still holds its effect inside the component. Open the scene in a project folder to move it into an asset." : "No effect: make a new particle effect asset, or pick one above."}</p>
        <div class="particle-effect-source">
          <button
            disabled={!project?.canSave}
            title={project?.canSave ? "Create a particle effect asset and use it here" : "Read-only project"}
            onClick={() =>
              void editor.assets.create("particles", { name: scene.doc.node(id).name || "Particle Effect" }).then((made) => {
                if (made) set("effect", `asset:${made}`);
              })
            }
          >
            New Effect
          </button>
          <button disabled title="Pick or create an effect first">
            Open in Particle Graph
          </button>
        </div>
      </div>
    );
  }

  if (!project || !project.files.includes(asset)) {
    return (
      <div class="particle-system-effect">
        <p class="hint">"{asset}" isn't in the project.</p>
      </div>
    );
  }
  const { value: graph, problems } = editor.assets.read<ParticleGraph>(project, asset);
  const overrides = (props.overrides && typeof props.overrides === "object" ? props.overrides : {}) as Record<string, Override>;
  const exposed = graph.properties.filter((p) => p.exposed);
  const issues = [...new Set([...problems.map((p) => p.message), ...compileProblems(graph)])];
  const setOverride = (name: string, value: Override) => set("overrides", { ...overrides, [name]: value });
  const revert = (name: string) => {
    const { [name]: _removed, ...rest } = overrides;
    set("overrides", rest);
  };
  return (
    <div class="particle-system-effect">
      <div class="particle-effect-source">
        <button onClick={() => editor.assets.open(asset)}>Open in Particle Graph</button>
        <button onClick={() => editor.assets.reveal(asset)} title="Select the asset in the Assets panel">
          Select Asset
        </button>
      </div>
      {issues.length > 0 && <p class="hint">{issues.length === 1 ? "1 problem" : `${issues.length} problems`} in this effect; see the Particle Graph.</p>}
      {exposed.length > 0 && (
        <div class="particle-effect-editor">
          {exposed.map((p) => {
            const overridden = Object.prototype.hasOwnProperty.call(overrides, p.name);
            return (
              <PropertyRow key={p.name} name={p.name} overridden={overridden} onRevert={() => revert(p.name)}>
                <PropertyInput prop={p} value={overridden ? overrides[p.name] : p.value} onChange={(v) => setOverride(p.name, v)} onGesture={() => groupGesture(scene)} />
              </PropertyRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PropertyRow(props: { name: string; overridden: boolean; onRevert: () => void; children: ComponentChildren }) {
  return (
    <div class={`particle-property${props.overridden ? " overridden" : ""}`}>
      <label class="particle-property-name">{props.name}</label>
      <div class="particle-property-value">{props.children}</div>
      <button class="pe-mini" disabled={!props.overridden} title="Revert to the effect's value" aria-label={`Revert ${props.name}`} onClick={props.onRevert}>
        ↺
      </button>
    </div>
  );
}

/**
 * Make one pointer gesture in a curve or gradient editor (dragging a key or stop) one undo step: a
 * group opens on pointer down and closes on the pointer's release.
 */
function groupGesture(scene: OpenScene): void {
  const step = editor.scene.beginEdit("Edit particle property", scene);
  if (!step) return;
  const end = () => {
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    step.end();
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

/** The Inspector section under a ParticleSystem (ADR 0057, 0131). */
export function ParticleSystemSection({ scene, paths, info }: InspectorSectionProps) {
  return (
    <ParticleSystemEffect
      scene={scene}
      path={paths[0]}
      index={info.index}
      effectPath={String(sectionField(info, "effect") ?? "")}
      embedded={sectionField(info, "embeddedEffect")}
      overrides={sectionField(info, "overrides")}
    />
  );
}
