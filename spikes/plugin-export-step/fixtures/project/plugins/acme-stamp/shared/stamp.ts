// Shared by the runtime half and the export step (a relative import out of export/).
export const STAMP_VERSION = 3;
export const stampText = (game: string, label: string) => `${label}: ${game} (stamp v${STAMP_VERSION})`;
