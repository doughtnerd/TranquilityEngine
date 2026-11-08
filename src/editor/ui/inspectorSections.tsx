// Inspector sections (ADR 0131): extra UI under a component's fields in the Inspector, keyed by
// Component type (the particle effect editor under a ParticleSystem, Bake under a NavChunk…). Each
// section lives beside its feature's UI and is registered with a dynamic import, so its module loads
// the first time a component that has one is inspected (ADR 0083). The built-in registrations are in
// `inspectorSections.builtin.ts`.
import type { FunctionComponent } from "preact";
import type { ComponentInfo } from "../../engine/editor";
import type { NodePath } from "../document";
import type { OpenScene } from "../state";
import { lazyComponent, type LazyComponent } from "./lazy";

/** What a section is given: the open scene, every selected node with the component, and the active node's component. */
export interface InspectorSectionProps {
  scene: OpenScene;
  paths: NodePath[];
  info: ComponentInfo;
}

export interface InspectorSectionOptions {
  /** Show only when one node is selected. */
  single?: boolean;
  /** Show only for a top-level node of the scene (implies `single`). */
  rootOnly?: boolean;
}

interface Section extends InspectorSectionOptions {
  view: LazyComponent<InspectorSectionProps>;
}

const sections = new Map<string, Section[]>();

/** Add a section under every `type` component's fields, after the ones registered before it. Returns a function that removes it (a plugin's, ADR 0134). */
export function registerInspectorSection(type: string, load: () => Promise<FunctionComponent<InspectorSectionProps>>, options: InspectorSectionOptions = {}): () => void {
  const list = sections.get(type) ?? [];
  const section: Section = { ...options, view: lazyComponent(load) };
  list.push(section);
  sections.set(type, list);
  return () => {
    const now = sections.get(type);
    const at = now?.indexOf(section) ?? -1;
    if (at >= 0) now!.splice(at, 1);
  };
}

/** The sections a `type` component shows for this selection, in registration order (none loads until rendered). */
export function inspectorSectionsFor(type: string, paths: readonly NodePath[]): LazyComponent<InspectorSectionProps>[] {
  return (sections.get(type) ?? [])
    .filter((s) => (!s.single && !s.rootOnly) || (paths.length === 1 && (!s.rootOnly || paths[0].length === 1)))
    .map((s) => s.view);
}

/** Every section `inspectorSectionsFor(type, …)` could show, loaded or not (for tests and preloading). */
export function registeredInspectorSections(type: string): readonly LazyComponent<InspectorSectionProps>[] {
  return (sections.get(type) ?? []).map((s) => s.view);
}

/** The sections under a component's fields. */
export function InspectorSections(props: InspectorSectionProps) {
  const views = inspectorSectionsFor(props.info.type, props.paths);
  return (
    <>
      {views.map((View, i) => (
        <View key={i} {...props} />
      ))}
    </>
  );
}

/** A field's value on the section's component. */
export const sectionField = (info: ComponentInfo, name: string): unknown => info.fields.find((f) => f.name === name)?.value;
