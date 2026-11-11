// Tempo map arithmetic shared by the worklet (the "core") and the main-thread predictor (design A).
// map: [{ beat, bpm }] sorted, map[0].beat === 0. Frame of beat n of a segment that starts at context frame S.
export function beatFrame(map, S, n, sr) {
  let sec = 0;
  for (let i = 0; i < map.length; i++) {
    const b0 = map[i].beat;
    const b1 = i + 1 < map.length ? map[i + 1].beat : Infinity;
    const span = Math.min(n, b1) - b0;
    if (span <= 0) break;
    sec += (span * 60) / map[i].bpm;
    if (n <= b1) break;
  }
  return S + Math.round(sec * sr);
}
