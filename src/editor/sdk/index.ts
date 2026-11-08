// The editor SDK (ADR 0133): what `myco/editor` will resolve to for plugin editor halves.
// Experimental until v1.
export * from "./registry";
export * from "./contributions";
export * from "./plugins";
export { openAssetDocument, type AssetDocument, type EditOptions } from "../assetDocuments";
export type { InspectorSectionProps, InspectorSectionOptions } from "../ui/inspectorSections";
