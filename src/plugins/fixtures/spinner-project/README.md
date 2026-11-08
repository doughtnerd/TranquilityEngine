# Spinner fixture project (ADR 0139)

A tiny project with one third-party plugin, used by `src/plugins/thirdParty.test.ts` and the export
and server tests. It is also the guide's worked example ([docs/guide/plugins.md](../../../../docs/guide/plugins.md)).

- `plugins/spinner/plugin.json`: the manifest (a runtime half, an editor half and a static asset kind, `*.spin.json`).
- `plugins/spinner/runtime/index.ts`: the `Spinner` Component, which turns its node, claimed in `activate`.
- `plugins/spinner/editor/index.ts`: the editor half; it adds a note to `Spinner` in the Add Component menu (the `spin` kind comes from plugin.json alone).
- `scripts/useSpinner.ts`: a project script importing the plugin's runtime half.
