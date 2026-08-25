/**
 * S1-3: the STT worker must not outlive the server.
 *
 * Before the fix, `kill -TERM` on the server left four processes holding the
 * Parakeet weights resident; every npm start / Ctrl-C cycle leaked another.
 * Nothing ever called dispose(), because no signal handler existed.
 *
 * This POSTs one second of 16 kHz mono silence (above /transcribe's 0.1 s
 * floor, S3-7) so the worker actually spawns and loads the model. Then check
 * the process tree by hand:
 *
 *   BW_PORT=4599 npx tsx src/server.ts &
 *   node scripts/probes/orphan-test.mjs          # expect: transcribe: 200
 *   ps -eo pid,ppid,args | grep stt/worker.ts    # expect: four processes
 *   kill -TERM <the node pid running src/server.ts>
 *   ps -eo pid,ppid,args | grep stt/worker.ts    # expect: none
 *
 * Needs the Parakeet model present (BW_STT_MODEL_DIR, or the populated cache
 * at ~/.cache/better-writer/models/). Set BW_PORT to match the server.
 */
const PORT = process.env.BW_PORT ?? '4599';
const B = `http://127.0.0.1:${PORT}`
function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b}
// 1 second of 16k mono silence -> above the new 0.1s floor
const samples = 16000
const data = Buffer.alloc(samples*2)
const fmt = Buffer.alloc(16)
fmt.writeUInt16LE(1,0); fmt.writeUInt16LE(1,2); fmt.writeUInt32LE(16000,4)
fmt.writeUInt32LE(32000,8); fmt.writeUInt16LE(2,12); fmt.writeUInt16LE(16,14)
const body = Buffer.concat([Buffer.from('fmt '),u32(16),fmt,Buffer.from('data'),u32(data.length),data])
const w = Buffer.concat([Buffer.from('RIFF'),u32(4+body.length),Buffer.from('WAVE'),body])
const r = await fetch(B+'/transcribe',{method:'POST',headers:{'content-type':'audio/wav'},body:w})
console.log('transcribe:', r.status, (await r.text()).slice(0,150))
