// Spinning clock: epoch milliseconds (timeOrigin + now) into a SharedArrayBuffer.
onmessage = (e) => {
  const f = new Float64Array(e.data);
  postMessage('up');
  const o = performance.timeOrigin;
  for (;;) f[0] = o + performance.now();
};
