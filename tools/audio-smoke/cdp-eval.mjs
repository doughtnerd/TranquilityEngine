// Evaluates JS in the first page of a WebView2/Chromium started with --remote-debugging-port=PORT (default 9333).
// Usage: node cdp-eval.mjs "<expression>"
const port = process.env.CDP_PORT ?? "9333";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target: " + JSON.stringify(targets));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: process.argv[2], returnByValue: true, awaitPromise: true } }));
const msg = await new Promise((r) => (ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
console.log(JSON.stringify(msg.result?.result?.value ?? msg.result ?? msg));
ws.close();
