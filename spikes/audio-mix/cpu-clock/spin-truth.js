// Truth clock: spins, publishing performance.now() (ms) to a SharedArrayBuffer.
onmessage = (e) => { const f = new Float64Array(e.data); postMessage('up'); for (;;) f[0] = performance.now(); };
