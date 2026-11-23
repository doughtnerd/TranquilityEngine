// Medians per job of a results .jsonl (run-node.mjs, run-browser.mjs or the native command's stderr lines).
//   node spikes/audio-encode/summarize.mjs <file.jsonl>...
import { readFileSync } from "node:fs";

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((r) => r.codec);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.codec} q=${r.quality} ${r.outRate}${r.complexity !== undefined ? ` cx${r.complexity}` : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log(`\n${file}`);
  console.log("| job | runs | median ms | resample ms | x realtime | kbps | bytes | extra |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const [key, rs] of groups) {
    const extra = rs[0].snrDb !== undefined ? `SNR ${rs[0].snrDb} dB` : rs[0].preSkip !== undefined ? `pre-skip ${rs[0].preSkip}` : "";
    console.log(`| ${key} | ${rs.length} | ${median(rs.map((r) => r.ms))} | ${median(rs.map((r) => r.resampleMs))} | ${median(rs.map((r) => r.xRealtime))} | ${rs[0].kbps} | ${rs[0].bytes} | ${extra} |`);
  }
}
