# Shared-kit changes requested by wave 1 (for wave 2)

## From Spatial (ui/w1-spatial)
- MoveToDialog.tsx / kit.css (SC7): optional itemName/title prop, title "Move “name” to"; `.kit-move-dialog h2` no
  caps (same `.panel h2` override issue as SC10); `.kit-move-search` input-bg/border/3px radius; `.kit-move-matches li`
  not monospace, 12px, 28px rows; search results always list the root "Top level" (searchFolders drops ""); current
  folder disabled, "here now"; single click on an allowed row moves (Enter kept).
- Player bar (PB1), studioComponents.css: right column `minmax(min-content, 1fr)`; `.studio-player-status{flex:1 1 auto}`;
  `.studio-player-right > :not(.studio-player-status){flex:none}` so status text gives way and Hear as never clips.
- TypeBadge: accept a placeholder code ("—") for an empty sound chip (IN2, spec).
- General: `.panel h2` outranks screen dialog title classes (caps titles in dialogs); fix at the source.
