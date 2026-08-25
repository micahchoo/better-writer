// SaveCoordinator with a null store: does it claim "saved" and drop the payload?
import { SaveCoordinator } from '../../web/save-coordinator.js'

const events: string[] = []
const c = new SaveCoordinator({
  getStore: () => null,           // exactly EditorApp's state while mode === 'detecting'
  onError: (e) => events.push('error:' + String(e)),
  onSaveState: (p) => events.push('state:' + p),
})

await c.persistNow('the writer typed this before detection finished', [])
console.log('events:', events)
console.log('pending after null-store save:', (c as any).pending)
console.log('=> payload discarded and reported as saved?', (c as any).pending === null && events.includes('state:saved'))
