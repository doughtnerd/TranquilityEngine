// node show2.js file.json : compact table dump
const o=JSON.parse(require('fs').readFileSync(process.argv[2]));
const dec=(t,n,d)=>{for(const [k,v] of Object.entries(d??{})) console.log(' ',n,k,v.supported===false?'unsupported':`${v.medianMs}ms ${v.xRealtime}x`)};
const st=(n,d)=>{for(const [k,v] of Object.entries(d??{})) if(v.supported) console.log(' ',n,k,`chunk p50 ${v.p50Ms} p99 ${v.p99Ms} max ${v.maxMs} | seek coarse ${v.seek_coarse.medianMs} acc ${v.seek_accurate.medianMs} first ${v.seek_coarse.firstChunkMedianMs}`)};
if(o.nodeFormats){console.log('node');dec(0,'wasm',o.nodeFormats);st('stream',o.nodeStream)}
for(const b of ['chromium','webkit','firefox']) if(o[b]?.formats){const f=o[b].formats;console.log(b);dec(0,'wasm',f.wasmDecode);st('stream',f.wasmStream);if(process.argv[3]!=='nodad')for(const [k,v] of Object.entries(f.decodeAudioData)) console.log('  dAD',k,v.supported?`${v.medianMs}ms ${v.xRealtime}x`:'UNSUPPORTED '+v.error)}
