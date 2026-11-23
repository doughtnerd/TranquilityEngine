// A baked sample's provenance on the Samples inspector (ADR 0360 §6, §9): "Baked from coin.generator.json" (a link
// that opens the generator), "out of date" when the generator's patch changed since, and Rebake (off with why when it
// can't run). A view over the model's `ProvenanceView`.
import { readAsset } from "../../../../editor/assetDocuments";
import { sidecarPath, type ImportSettings } from "../../../../engine/scene/importSettings";
import { SIDECAR_KIND } from "../../samples/sampleSession";
import type { EditorProject } from "../../../../editor/projects";
import { Chip } from "../../../../editor/ui/Chip";
import { generatorIsEndless } from "../../../../engine/audio/generators/catalogue";
import type { GeneratedProvenance as GeneratedBlock } from "../../../../engine/audio/generators/provenance";
import type { GeneratorAsset, GeneratorBody } from "../../../../engine/audio/generators/types";
import { openRoute, toasts } from "../../../shell/studioServices";
import { BAKE, provenanceView, rebakeOptions, type ProvenanceView } from "./bakeModel";
import { GeneratorIcon } from "./GeneratorParts";
import "./generator.css";

export interface GeneratedProvenanceProps {
  readonly view: ProvenanceView;
  onOpenGenerator(path: string): void;
  onRebake(path: string): void;
}

export function GeneratedProvenance(props: GeneratedProvenanceProps) {
  const v = props.view;
  return (
    <div class="fld">
      <span>Generated</span>
      <span class="gen-provenance">
        <GeneratorIcon />
        <button class="smp-link" disabled={v.state === "missing"} title={v.generator} onClick={() => props.onOpenGenerator(v.generator)}>
          {v.text}
        </button>
        {v.note && <Chip tone={v.state === "missing" ? "danger" : "warning"}>{v.note}</Chip>}
        {v.state !== "current" && (
          <button class="smp-link" disabled={!v.rebake.enabled} title={v.rebake.reason ?? "Bake it again from the generator as it is now"} onClick={() => props.onRebake(v.generator)}>
            Rebake
          </button>
        )}
      </span>
    </div>
  );
}

/** A generator in `project` as it is saved now, or null when it isn't there. */
function savedGenerator(project: EditorProject, path: string): GeneratorBody | null {
  if (!project.files.includes(path)) return null;
  try {
    return readAsset<GeneratorAsset>(project, path, "generator").value;
  } catch {
    return null;
  }
}

/** A baked loop's length, seconds (its sidecar's first loop), or undefined. */
function loopSecondsOf(project: EditorProject, sample: string): number | undefined {
  try {
    const loop = readAsset<ImportSettings>(project, sidecarPath(sample), SIDECAR_KIND).value.sample?.loops[0];
    return loop && loop.end !== null && loop.end > loop.start ? loop.end - loop.start : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Samples inspector's provenance row for `sample`'s sidecar `generated` block (nothing without one). Rebake renders
 * the sample's variation again over the sample, from the generator as it is now.
 */
export function SampleProvenance(props: { readonly project: EditorProject; readonly sample: string; readonly generated: GeneratedBlock | null | undefined; readonly writable: boolean }) {
  const view = provenanceView(props.generated ?? null, (p) => savedGenerator(props.project, p), BAKE, props.writable);
  if (!view) return null;
  return (
    <GeneratedProvenance
      view={view}
      onOpenGenerator={(path) => openRoute({ screen: "playlists", asset: path })}
      onRebake={(path) => {
        const g = savedGenerator(props.project, path);
        const block = props.generated;
        if (!BAKE || !g || !block) return;
        BAKE(path, rebakeOptions(props.sample, block, generatorIsEndless(g.kind, g.params), loopSecondsOf(props.project, props.sample))).then(
          (r) => toasts.show({ text: `Rebaked ${view.name}: ${r.files.length === 1 ? r.files[0] : `${r.files.length} files`}.` }),
          (err) => toasts.show({ text: `Couldn't rebake ${view.name}: ${err instanceof Error ? err.message : String(err)}`, kind: "error" }),
        );
      }}
    />
  );
}
