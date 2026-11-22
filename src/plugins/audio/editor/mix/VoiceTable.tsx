// ADR 0171 amended by 0172 (M5a, task Pf5; api-and-models §7), and 0326: the profiler's voice table at the cursor, as its
// columns and cells (`ProfilerTableSection.tsx` draws it; the rows are the kit's, `profilerTablesModel.ts`). Every voice
// of the replay, filtered by clip or bus name and ordered as the live debug table orders them (most audible first), in a
// windowed grid: 1,024 voices scroll with at most 64 rows rendered. Columns carry the state, the reason text and the thief
// of a steal; a field a voice born after the keyframe doesn't have yet reads "-".
import type { GridCell } from "./WindowedGrid";
import type { TableColumns } from "./ProfilerTableSection";
import { voiceCells } from "./profilerTablesModel";
import type { VoiceRow } from "./voiceTableModel";

export const VOICE_TABLE: TableColumns<VoiceRow> = {
  title: "Voices",
  columns: [
    { key: "id", title: "Voice", width: "52px", align: "end" },
    { key: "clip", title: "Clip", width: "minmax(80px, 1.4fr)" },
    { key: "bus", title: "Bus", width: "minmax(56px, 0.8fr)" },
    { key: "state", title: "State", width: "96px" },
    { key: "reason", title: "Reason", width: "minmax(100px, 1.6fr)" },
    { key: "priority", title: "Pri", width: "36px", align: "end" },
    { key: "gain", title: "Gain", width: "64px", align: "end" },
    { key: "pitch", title: "Pitch", width: "48px", align: "end" },
    { key: "audibility", title: "Audible", width: "56px", align: "end" },
    { key: "playhead", title: "Playhead", width: "76px", align: "end" },
  ],
  rowKey: (r) => r.id,
  /** The state cell is flagged by state name so a stolen or virtual voice reads differently from a playing one; the thief is named from every voice, filtered or not. */
  cells(table) {
    const byId = new Map(table.all.map((r) => [r.id, r]));
    return (row): GridCell[] => {
      const c = voiceCells(row, byId);
      return [c.id, c.clip, c.bus, { text: c.state, flag: row.state }, c.reason, c.priority, c.gain, c.pitch, c.audibility, c.playhead];
    };
  },
  rowState: (r) => r.state,
};
