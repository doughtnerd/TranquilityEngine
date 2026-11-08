// Fallback for a tileset when the Tilemaps plugin is off (ADR 0133 "a disabled plugin's asset files show as generic
// files"). The tileset editor itself is the plugin's (`src/plugins/tilemaps/editor/TilesetInspector.tsx`); a
// registered kind's inspector wins in `AssetInspector`, so this only exists until its `tileset` line is removed there.
export function TilesetInspector(_props: { path: string }) {
  return <p class="empty">Enable the Tilemaps plugin to edit tilesets.</p>;
}
