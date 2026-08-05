const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

function findXmls(dir, out) {
  out = out || [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findXmls(full, out);
      else if (e.name === '.content.xml') out.push(full);
    }
  } catch (e) {}
  return out;
}

function collectLinklists(sections, out) {
  out = out || [];
  for (const s of sections || []) {
    for (const b of s.blocks || []) {
      visitBlock(b, out);
    }
    for (const gs of s.blocks || []) {
      for (const c of gs.children || []) visitBlock(c, out);
    }
  }
  return out;
}
function visitBlock(b, out) {
  if (!b) return;
  if (b.type === 'linklist') out.push({ dc: b.props && b.props.classes_customDynamicClass || '', cc: b.props && b.props.classes_commonCustomClass || '' });
  for (const c of b.children || []) visitBlock(c, out);
}

const xmls = findXmls('content-xml');
const dcFreq = {};
let total = 0, errors = 0;

for (const x of xmls) {
  const rel = x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    const sections = aemToCanvas(jcr, { rel: rel });
    const lls = collectLinklists(sections);
    for (const ll of lls) {
      total++;
      const key = ll.dc || '(none)';
      dcFreq[key] = (dcFreq[key] || 0) + 1;
    }
  } catch (e) { errors++; }
}

console.log('Total linklist blocks in EDS output:', total, '  Errors:', errors);
console.log('EDS dynamic class distribution:');
Object.entries(dcFreq).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(pair) {
  console.log('  ' + pair[1] + 'x  [' + pair[0] + ']');
});

// Check for any bad classes that should have been remapped
const bad = Object.entries(dcFreq).filter(function(pair) {
  return /quote-standard|carousel-default|card-/.test(pair[0]);
});
if (bad.length) {
  console.log('\nBad classes still present:');
  bad.forEach(function(pair) { console.log('  ' + pair[1] + 'x  ' + pair[0]); });
} else {
  console.log('\nNo bad cross-policy classes in linklist output.');
}
