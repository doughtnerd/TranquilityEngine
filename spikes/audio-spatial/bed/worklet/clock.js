// Spins, publishing performance.now() (ms) into a SharedArrayBuffer for the worklet to read.
onmessage = (e) => {
  const f = new Float64Array(e.data);
  postMessage('up');
  for (;;) f[0] = performance.now();
};
