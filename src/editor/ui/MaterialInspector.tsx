import { Color } from "../../engine";
import { compileShaderGraph } from "../../engine/render/shaderGraph/compile";
import { colorHex, materialGraph, type MaterialInstancing, type MaterialSettings } from "../../engine/scene/material";
import { isShaderAssetPath } from "../../engine/scene/shaderAsset";
import type { GraphProperty, GraphValue } from "../../engine/scene/shaderGraph";
import type { ShaderKeyword } from "../../engine/scene/shaderKeywords";
import { assetKind, fileName } from "../assetBrowser";
import { editMaterial, readMaterial, readShaderAsset, withKeywordValue } from "../materialAssets";
import { errorStatus } from "../messages";
import { createMaterialForGraph, openShaderGraphAsset, readShaderGraph } from "../shaderGraphAssets";
import { currentProject, docVersion, status } from "../state";
import { PropertyValue } from "./ShaderPropertyValue";
import { LargePreview } from "./AssetPreview";
import "./assetInspector.css";

const withAlpha = (c: Color, a: number) => new Color(c.r, c.g, c.b, a);

/**
 * A material asset's settings (ADR 0043), edited in place: each change writes the file, and every
 * mesh drawing with the material shows it straight away.
 */
export function MaterialInspector(props: { path: string }) {
  docVersion.value; // rewritten by this inspector, or on disk
  const { path } = props;
  const project = currentProject.value;
  if (!project) return <p class="empty">Nothing selected</p>;
  const { settings, problems } = readMaterial(project, path);
  const readOnly = !project.canSave;
  const images = project.files.filter((f) => assetKind(f) === "image" || assetKind(f) === "rendertexture");
  const graphs = project.files.filter((f) => assetKind(f) === "shadergraph");
  const physical = settings.shader === "physical";
  const lit = settings.shader === "lit" || physical;
  const graphPath = materialGraph(settings);
  const graphFile = graphPath?.replace(/^asset:/, "") ?? null;
  const shaders = project.files.filter(isShaderAssetPath);
  const isShaderAsset = !!graphFile && isShaderAssetPath(graphFile);
  const shaderFile = graphFile && isShaderAsset && project.files.includes(graphFile) ? readShaderAsset(project, graphFile).shader : null;
  const graph = graphFile && !isShaderAsset && project.files.includes(graphFile) ? readShaderGraph(project, graphFile).graph : null;
  // The properties and keywords the material sets: the graph's, or the shader asset's.
  const source: { properties: GraphProperty[]; keywords: ShaderKeyword[]; what: string } | null = shaderFile
    ? { properties: shaderFile.properties, keywords: shaderFile.keywords, what: "shader" }
    : graph
      ? { properties: graph.properties, keywords: graph.keywords ?? [], what: "graph" }
      : null;
  const sourceExists = !!graphFile && (isShaderAsset ? shaders : graphs).includes(graphFile);

  // Edits queue up and each applies to the file as the one before left it (`editMaterial`).
  const set = async (patch: Partial<MaterialSettings> | ((current: MaterialSettings) => Partial<MaterialSettings>)) => {
    try {
      if (await editMaterial(project, path, patch)) docVersion.value++;
    } catch (err) {
      status.value = errorStatus(`Couldn't save ${fileName(path)}`, err);
    }
  };
  const number = (label: string, value: number, onValue: (v: number) => void, range?: [number, number]) => (
    <label class="import-row">
      <span>{label}</span>
      <span class="material-number">
        {range && (
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={0.01}
            aria-label={`${label} slider`}
            disabled={readOnly}
            value={value}
            onChange={(e) => onValue(Number((e.currentTarget as HTMLInputElement).value))}
          />
        )}
        <input
          type="number"
          step={0.05}
          min={range?.[0]}
          max={range?.[1]}
          aria-label={label}
          disabled={readOnly}
          value={value}
          onChange={(e) => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) onValue(range ? Math.min(range[1], Math.max(range[0], v)) : v);
          }}
        />
      </span>
    </label>
  );
  const texture = (label: string, value: string, onValue: (v: string) => void) => (
    <label class="import-row">
      <span>{label}</span>
      <select aria-label={label} disabled={readOnly} value={value.replace(/^asset:/, "")} onChange={(e) => onValue((e.currentTarget as HTMLSelectElement).value ? `asset:${(e.currentTarget as HTMLSelectElement).value}` : "")}>
        <option value="">None</option>
        {images.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        {value && !images.includes(value.replace(/^asset:/, "")) && <option value={value.replace(/^asset:/, "")}>{value.replace(/^asset:/, "")} (missing)</option>}
      </select>
    </label>
  );
  /** A colour row; `onValue` gets how to change the colour as it is when the edit is applied. */
  const color = (label: string, value: Color, onValue: (change: (current: Color) => Color) => void, alpha: boolean) => (
    <label class="import-row">
      <span>{label}</span>
      <span class="material-color">
        <input type="color" aria-label={label} disabled={readOnly} value={value.toHex()} onChange={(e) => {
          const picked = Color.from((e.currentTarget as HTMLInputElement).value);
          onValue((current) => withAlpha(picked, current.a));
        }} />
        <code>{colorHex(value)}</code>
        {alpha && (
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            aria-label={`${label} alpha`}
            title="Opacity: below 1 is see-through"
            disabled={readOnly}
            value={+value.a.toFixed(3)}
            onChange={(e) => {
              const a = Number((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(a)) onValue((current) => withAlpha(current, Math.min(1, Math.max(0, a))));
            }}
          />
        )}
      </span>
    </label>
  );

  return (
    <div class="inspector-body asset-inspector" aria-label="Material">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Material</span>
        <span class="asset-inspector-name" title={path}>
          {fileName(path)}
        </span>
      </div>
      <LargePreview path={path} />
      {problems.length > 0 && (
        <ul class="asset-inspector-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="component asset-import-card">
        <h3>Material</h3>
        <label class="import-row">
          <span>Shader</span>
          <select aria-label="Shader" disabled={readOnly} value={settings.shader} onChange={(e) => void set({ shader: (e.currentTarget as HTMLSelectElement).value as MaterialSettings["shader"] })}>
            <option value="lit">Lit (physically based)</option>
            <option value="physical">Physical (clearcoat, sheen, glass…)</option>
            <option value="unlit">Unlit</option>
            {graphs.map((f) => (
              <option key={f} value={`asset:${f}`}>
                Shader Graph: {fileName(f)}
              </option>
            ))}
            {shaders.map((f) => (
              <option key={f} value={`asset:${f}`}>
                Shader: {fileName(f)}
              </option>
            ))}
            {graphFile && !graphs.includes(graphFile) && !shaders.includes(graphFile) && <option value={settings.shader}>{graphFile} (missing)</option>}
          </select>
        </label>
        {graphPath && (
          <>
            {source?.properties.map((p) => {
              const own = settings.properties[p.name];
              const reset = () => void set((now) => ({ properties: Object.fromEntries(Object.entries(now.properties).filter(([k]) => k !== p.name)) }));
              return (
                <div key={p.name} class="import-row">
                  <span title={own === undefined ? `The ${source?.what}'s default` : "Set by this material"}>
                    {p.name}
                    {own !== undefined && "*"}
                  </span>
                  <span class="material-pair">
                    <PropertyValue
                      name={p.name}
                      type={p.type}
                      value={own ?? p.value}
                      images={images}
                      disabled={readOnly}
                      onValue={(v: GraphValue) => void set((now) => ({ properties: { ...now.properties, [p.name]: v } }))}
                    />
                    {own !== undefined && (
                      <button title={`Use the ${source?.what}'s default`} aria-label={`Reset ${p.name}`} disabled={readOnly} onClick={reset}>
                        Reset
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {source && source.properties.length === 0 && <p class="asset-inspector-note">The {source.what} has no properties to set.</p>}
            {shaderFile && (
              <p class="asset-inspector-note">
                {shaderFile.target === "lit" ? "Lit" : "Unlit"}, {shaderFile.surface}
                {shaderFile.doubleSided ? ", double-sided" : ""}; {shaderFile.properties.length} properties, {shaderFile.keywords.length} keywords.
              </p>
            )}
            {source && source.keywords.length > 0 && (
              <>
                <h4 class="material-group">Keywords</h4>
                {source.keywords.map((k) => {
                  const value = settings.keywords[k.name];
                  return k.values ? (
                    <label key={k.name} class="import-row" title={`Each value compiles its own shader variant (the first, ${k.values[0]}, is the default)`}>
                      <span>
                        {k.name}
                        {value !== undefined && "*"}
                      </span>
                      <select aria-label={`Keyword ${k.name}`} disabled={readOnly} value={typeof value === "string" && k.values.includes(value) ? value : k.values[0]} onChange={(e) => void set((now) => ({ keywords: withKeywordValue(now.keywords, k, (e.currentTarget as HTMLSelectElement).value) }))}>
                        {k.values.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label key={k.name} class="import-row" title="On compiles the variant with this keyword defined">
                      <span>{k.name}</span>
                      <input type="checkbox" aria-label={`Keyword ${k.name}`} disabled={readOnly} checked={value === true} onChange={(e) => void set((now) => ({ keywords: withKeywordValue(now.keywords, k, (e.currentTarget as HTMLInputElement).checked) }))} />
                    </label>
                  );
                })}
              </>
            )}
            {sourceExists && graphFile && !isShaderAsset && <button onClick={() => openShaderGraphAsset(graphFile)}>Edit Shader Graph</button>}
          </>
        )}
        {!graphPath && (
          <>
        {color("Color", settings.color, (change) => void set((now) => ({ color: change(now.color) })), true)}
        {texture("Texture", settings.texture, (v) => void set({ texture: v }))}
        <div class="import-row">
          <span>Tiling</span>
          <span class="material-pair">
            {([0, 1] as const).map((i) => (
              <input
                key={i}
                type="number"
                step={0.5}
                aria-label={`Tiling ${i === 0 ? "X" : "Y"}`}
                disabled={readOnly}
                value={settings.tiling[i]}
                onChange={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  if (!Number.isFinite(v) || v === 0) return;
                  void set((now) => ({ tiling: i === 0 ? [v, now.tiling[1]] : [now.tiling[0], v] }));
                }}
              />
            ))}
          </span>
        </div>
        {lit && (
          <>
            {number("Metalness", settings.metalness, (v) => void set({ metalness: v }), [0, 1])}
            {number("Roughness", settings.roughness, (v) => void set({ roughness: v }), [0, 1])}
            {texture("Normal Map", settings.normalMap, (v) => void set({ normalMap: v }))}
            {color("Emission", settings.emission, (change) => void set((now) => ({ emission: change(now.emission) })), false)}
          </>
        )}
        {physical && (
          <>
            <h4 class="material-group">Clearcoat</h4>
            {number("Clearcoat", settings.clearcoat, (v) => void set({ clearcoat: v }), [0, 1])}
            {number("Clearcoat Roughness", settings.clearcoatRoughness, (v) => void set({ clearcoatRoughness: v }), [0, 1])}
            <h4 class="material-group">Sheen</h4>
            {number("Sheen", settings.sheen, (v) => void set({ sheen: v }), [0, 1])}
            {color("Sheen Color", settings.sheenColor, (change) => void set((now) => ({ sheenColor: change(now.sheenColor) })), false)}
            {number("Sheen Roughness", settings.sheenRoughness, (v) => void set({ sheenRoughness: v }), [0, 1])}
            <h4 class="material-group">Transmission</h4>
            {number("Transmission", settings.transmission, (v) => void set({ transmission: v }), [0, 1])}
            {number("Thickness", settings.thickness, (v) => void set({ thickness: Math.max(0, v) }))}
            {number("IOR", settings.ior, (v) => void set({ ior: v }), [1, 2.333])}
            <h4 class="material-group">Iridescence</h4>
            {number("Iridescence", settings.iridescence, (v) => void set({ iridescence: v }), [0, 1])}
            {number("Iridescence IOR", settings.iridescenceIOR, (v) => void set({ iridescenceIOR: v }), [1, 2.333])}
            <h4 class="material-group">Anisotropy</h4>
            {number("Anisotropy", settings.anisotropy, (v) => void set({ anisotropy: v }), [0, 1])}
            {number("Anisotropy Rotation", settings.anisotropyRotation, (v) => void set({ anisotropyRotation: v }))}
            <h4 class="material-group">Specular</h4>
            {number("Specular Intensity", settings.specularIntensity, (v) => void set({ specularIntensity: v }), [0, 1])}
            {color("Specular Color", settings.specularColor, (change) => void set((now) => ({ specularColor: change(now.specularColor) })), false)}
          </>
        )}
        <label class="import-row">
          <span>Double Sided</span>
          <input type="checkbox" aria-label="Double Sided" disabled={readOnly} checked={settings.doubleSided} onChange={(e) => void set({ doubleSided: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
          </>
        )}
        <label class="import-row" title="Auto: renderers with the same mesh and material draw in one instanced call. Thin: one buffer per mesh, culled as a whole — for many small things that rarely move. Off: one mesh per renderer.">
          <span>Instancing</span>
          <select aria-label="Instancing" disabled={readOnly} value={settings.instancing} onChange={(e) => void set({ instancing: (e.currentTarget as HTMLSelectElement).value as MaterialInstancing })}>
            <option value="auto">Auto</option>
            <option value="thin">Thin instances</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label class="import-row" title="Take the World's Fog (off for glows and UI-like surfaces)">
          <span>Fog</span>
          <input type="checkbox" aria-label="Fog" disabled={readOnly} checked={settings.fog} onChange={(e) => void set({ fog: (e.currentTarget as HTMLInputElement).checked })} />
        </label>
      </div>
      <p class="asset-inspector-note">{readOnly ? "This project is read-only." : "Changes save to the file as you make them."}</p>
    </div>
  );
}

/** A shader graph asset in the Inspector (ADR 0047): what it is, its problems, and buttons to edit it or make a material. */
export function ShaderGraphInspector(props: { path: string }) {
  docVersion.value;
  const project = currentProject.value;
  if (!project) return <p class="empty">Nothing selected</p>;
  const { graph, problems } = readShaderGraph(project, props.path);
  const all = [...problems, ...compileShaderGraph(graph).problems];
  const sub = !!graph.subgraph;
  return (
    <div class="inspector-body asset-inspector" aria-label="Shader Graph">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">{sub ? "Sub Graph" : "Shader Graph"}</span>
        <span class="asset-inspector-name" title={props.path}>
          {fileName(props.path)}
        </span>
      </div>
      {!sub && <LargePreview path={props.path} />}
      {all.length > 0 && (
        <ul class="asset-inspector-problems">
          {all.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div class="component asset-import-card">
        <h3>{sub ? "Sub Graph" : "Shader Graph"}</h3>
        <p class="asset-inspector-note">
          {sub
            ? `${graph.properties.length} inputs, ${graph.subgraph!.outputs.length} outputs; ${graph.nodes.length} nodes. Use it in a graph with a Sub Graph node.`
            : `${graph.target === "lit" ? "Lit" : "Unlit"}, ${graph.surface}${graph.doubleSided ? ", double-sided" : ""}; ${graph.nodes.length} nodes, ${graph.properties.length} properties.`}
        </p>
        <div class="material-pair">
          <button class="primary" onClick={() => openShaderGraphAsset(props.path)}>Open in Shader Graph</button>
          {!sub && <button disabled={!project.canSave} onClick={() => void createMaterialForGraph(props.path)}>New Material</button>}
        </div>
      </div>
    </div>
  );
}
