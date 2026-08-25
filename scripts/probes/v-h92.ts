import { planSweep } from '../../web/coach-sweep.js'
for (const [label, doc] of [
  ['break-heavy', 'Para one.\n\n---\n\nPara two.\n\n---\n\nPara three.'],
  ['lone trailing break', 'Para one.\n\nPara two.\n\n---'],
  ['break only', '---'],
] as [string,string][]) {
  const plan = planSweep(doc)
  const bad = plan.filter((p) => /\[CURSOR START\]\s*-{3,}\s*\[CURSOR END\]/.test(p.markedText) || /^\s*-{3,}\s*$/.test(p.markedText.replace(/\[CURSOR (START|END)\]/g, '').trim()))
  console.log(label.padEnd(20), 'windows:', plan.length, '| degenerate:', bad.length)
}
