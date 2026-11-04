// The Inspector's particle effect parts (ADR 0060): a `*.particles.json` graph asset selected in the
// Assets panel (a summary), and under a ParticleSystem component the effect's exposed properties as
// per-instance overrides. Effects are edited in the Particle Graph panel, not here.
import type { ComponentChildren } from "preact";
import type { GraphProperty, ParticleGraph } from "../../engine/scene/particleGraph";
import { compileParticleGraph } from "../../engine/scene/particleCompile";
import type { CurveKey, ParticleColor, ParticleGradient } from "../../engine/scene/particles";
import { assetKind, fileName, listedFiles } from "../assetBrowser";
import { SetField, type NodePath } from "../document";
import { createParticleEffect, openParticleGraphAsset, readEffect } from "../particleAssets";
import { selectedAssets } from "../assetSelection";
import { currentProject, docVersion, type OpenScene } from "../state";
import { CurveEditor } from "./particles/CurveEditor";
import { GradientEditor } from "./particles/GradientEditor";
import { NumField, ParticleColorInput, VecField } from "./particles/valueInputs";
import "./assetInspector.css";

/** Problems of a graph: its parse problems plus what compiling it reports. */
function allProblems(graph: ParticleGraph, parse: { message: string }[]): string[] {
  const compiled = compileParticleGraph(graph).problems.map((p) => p.message);
  return [...new Set([...parse.map((p) => p.message), ...compiled])];
}

/** A particle effect asset selected in the Assets panel: what it holds, and a way into the graph. */
export function ParticleEffectInspector(props: { path: string }) {
  docVersion.value; // rewritten by the graph panel, or on disk
  const project = currentProject.value;
  if (!project) return null;
  const { graph, problems, migrated } = readEffect(project, props.path);
  const all = allProblems(graph, problems);
  const exposed = graph.properties.filter((p) => p.exposed);
  return (
    <div class="asset-inspector particle-inspector">
      <h3>{fileName(props.path)}</h3>
      <p class="hint">Particle effect. ParticleSystem components play it; edit it in the Particle Graph.</p>
      <button onClick={() => openParticleGraphAsset(props.path)}>Open in Particle Graph</button>
      {migrated && <p class="hint">An older particle effect file. It's converted to a graph the first time it's edited.</p>}
      {!project.canSave && <p class="hint">Read-only: open a project folder (or copy the sample) to edit.</p>}
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
      {all.length > 0 && (
        <ul class="material-problems">
          {all.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const imageAssets = (): string[] => listedFiles(currentProject.value?.files ?? []).filter((f) => assetKind(f) === "image").map((f) => `asset:${f}`);

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
export function ParticleSystemEffect(props: { scene: OpenScene; path: NodePath; index: number; effectPath: string; embedded?: unknown; overrides?: unknown }) {
  docVersion.value;
  const { scene, path, index } = props;
  const [id, ...target] = path;
  const asset = props.effectPath.replace(/^asset:/, "");
  const project = currentProject.value;
  const set = (field: string, value: unknown) => scene.stack.execute(new SetField(id, "engine.ParticleSystem", field, value, { index, target }));
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
              void createParticleEffect("", undefined, scene.doc.node(id).name || "Particle Effect").then((made) => {
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
  const { graph, problems } = readEffect(project, asset);
  const overrides = (props.overrides && typeof props.overrides === "object" ? props.overrides : {}) as Record<string, Override>;
  const exposed = graph.properties.filter((p) => p.exposed);
  const issues = allProblems(graph, problems);
  const setOverride = (name: string, value: Override) => set("overrides", { ...overrides, [name]: value });
  const revert = (name: string) => {
    const { [name]: _removed, ...rest } = overrides;
    set("overrides", rest);
  };
  return (
    <div class="particle-system-effect">
      <div class="particle-effect-source">
        <button onClick={() => openParticleGraphAsset(asset)}>Open in Particle Graph</button>
        <button onClick={() => (selectedAssets.value = [asset])} title="Select the asset in the Assets panel">
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
  scene.stack.beginGroup("Edit particle property");
  const end = () => {
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    scene.stack.endGroup();
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}
