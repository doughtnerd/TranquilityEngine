// Method b: a tick counter. No clock call in the loop; the worklet calibrates ticks per ms against Date.now.
onmessage = (e) => { const f = new Float64Array(e.data); postMessage('up'); let i = 0; for (;;) f[0] = ++i; };
