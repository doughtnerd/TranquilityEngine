// The third-party plugin SDK's runtime half (ADR 0139), which `myco` re-exports whole: the plugin types and the SDK
// version a `plugin.json` `sdk` range is checked against. Contribution points a first-party plugin owns (the Physics
// plugin's backends) are in that plugin's `runtime/public.ts`. Editor halves import `myco/editor` (the editor SDK).
export type { PluginManifest } from "./manifest";
export type { RuntimePlugin, RuntimePluginContext, ContributionPoint } from "./runtimeContext";
export { SDK_VERSION, type ThirdPartyManifest, type PluginAssetKind } from "./thirdParty";
