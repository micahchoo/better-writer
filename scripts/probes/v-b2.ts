import { createCadence } from '../../web/cadence.js'
const doc = ['# Heading','','## Sub','','- one','- two','- three','- four','- five','- six','- seven','- eight','- nine','- ten','- eleven','','```','code here','```','','---','','**bold** and `tick`'].join('\n')
console.log('raw whitespace tokens:', doc.split(/\s+/).filter(Boolean).length)
const c = createCadence()
console.log('arm on empty  :', c.observe('', 0))
console.log('observe doc   :', c.observe(doc, 1000))
console.log('after 30s idle:', c.observe(doc, 40_000), '  <- "ready" would fire a question on no new prose')
