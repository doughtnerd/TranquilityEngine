// The Dialogue screen's CSV (RFC 4180, ADR 0340 §9) is the engine's shared exchange module (ADR 0342 §8, T6), which
// absorbed the copy that lived here.
export { csvField, csvRecords, formatCsv, parseCsv } from "../../../engine/localisation/exchange/csv";
