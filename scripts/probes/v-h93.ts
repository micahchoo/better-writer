import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDraftIo } from '../../src/draft.js'
const dir = mkdtempSync(join(tmpdir(), 'bw-h93-'))
const io = createDraftIo(pathToFileURL(join(dir, 'current.md')), pathToFileURL(join(dir, 'notes.json')))
const A = 'a'.repeat(8 * 1024 * 1024), B = 'b'.repeat(8 * 1024 * 1024)
await io.saveDraft(A)
let full = 0, old = 0, partial = 0, empty = 0
const ops: Promise<unknown>[] = []
for (let i = 0; i < 400; i++) {
  ops.push(io.saveDraft(i % 2 ? A : B))
  ops.push(io.loadDraft().then((t) => {
    if (t.length === 0) empty++
    else if (t === A || t === B) full++
    else partial++
  }))
}
await Promise.all(ops)
console.log(`full=${full} partial=${partial} empty=${empty}  (partial/empty must be 0)`)
rmSync(dir, { recursive: true, force: true })
