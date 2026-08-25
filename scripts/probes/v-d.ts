import { SaveCoordinator } from '../../web/save-coordinator.js'
let timers = 0
const g = globalThis as any
g.window = { setTimeout: (fn: any, ms: number) => { timers++; return setTimeout(() => { timers--; fn() }, ms) as any }, clearTimeout: (h: any) => { timers--; clearTimeout(h) } }
const saves: string[] = []
let release!: () => void
const gate = new Promise<void>((r) => { release = r })
const store = { async load() { return '' }, async save(d: string) { saves.push(d); if (saves.length === 1) await gate }, async loadAnnotations() { return [] } }
const c = new SaveCoordinator({ getStore: () => store as any, onError: () => {} })
c.persistNow('A', [])
await new Promise((r) => setTimeout(r, 5))
c.edit('B', [])                 // newer payload arrives while A is in flight
c.dispose()                     // unmount
console.log('timers after dispose        :', timers)
release()
await new Promise((r) => setTimeout(r, 60))
console.log('saves received              :', JSON.stringify(saves))
console.log('post-unmount save leaked?   :', saves.includes('B'))
