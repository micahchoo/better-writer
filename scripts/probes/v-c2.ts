import { pickSeed } from '../../web/coach.js'
import type { ClientSeed, Genre } from '../../src/types.js'
const mk = (id: string, g: string[]): ClientSeed => ({ id, question: id + '?', verb: 'cut', genre: g } as ClientSeed)
function ratio(nSpecific: number, nAgnostic: number, genre: Genre) {
  const seeds = [...Array.from({length:nSpecific},(_,i)=>mk('s'+i,[genre])), ...Array.from({length:nAgnostic},(_,i)=>mk('a'+i,['genre-agnostic']))]
  const N = 200_000; let spec = 0
  for (let i=0;i<N;i++) if (pickSeed(seeds, genre).id.startsWith('s')) spec++
  const perSpecific = (spec/N)/nSpecific, perAgnostic = ((N-spec)/N)/nAgnostic
  return { pileShare: (spec/N*100).toFixed(1)+'%', perSeedRatio: (perSpecific/perAgnostic).toFixed(2) }
}
console.log('fiction  898 specific / 563 agnostic ->', JSON.stringify(ratio(898,563,'fiction' as Genre)))
console.log('memoir   497 specific / 580 agnostic ->', JSON.stringify(ratio(497,580,'memoir' as Genre)))
console.log('poetry     8 specific / 580 agnostic ->', JSON.stringify(ratio(8,580,'poetry' as Genre)))
