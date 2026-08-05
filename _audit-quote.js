const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');
const migrationMap = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const styleMap = JSON.parse(fs.readFileSync('style-map.json', 'utf8'));
const componentMap = migrationMap.componentMap || {};

const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const RT = n => (n && n['@sling:resourceType'] || '').trim();
const ce = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

// Find quote resourceTypes
const quoteTypes = Object.entries(componentMap).filter(([, v]) => v.edsType === 'quote').map(([k]) => k);
console.log('Quote resourceTypes:', quoteTypes);

// Show picklist config
const picklistFile = path.join('config', 'quote-picklist-config', '.content.xml');
if (fs.existsSync(picklistFile)) {
  const xml = fs.readFileSync(picklistFile, 'utf8');
  const classes = Array.from(xml.matchAll(/Style_x0020_Class="([^"]+)"/g)).map(m => m[1]);
  console.log('Quote picklist classes:', [...new Set(classes)]);
} else {
  console.log('No quote picklist config');
}

// Find migration-map props for quote
const quoteMappings = quoteTypes.map(rt => ({ rt, mapping: componentMap[rt] }));
console.log('\nQuote migration-map:');
quoteMappings.forEach(m => {
  console.log(' ', m.rt);
  console.log('  propRenames:', JSON.stringify(m.mapping.propRenames || {}));
  console.log('  skipProps:', JSON.stringify(m.mapping.skipProps || []));
  console.log('  childType:', m.mapping.childType, 'childProp:', m.mapping.childProp);
});

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

// Scan AEM source to find quote nodes with their raw attrs
const aemXmls = findXmls('content-xml');
let aemQuotes = [];
for (const x of aemXmls) {
  if (aemQuotes.length >= 5) break;
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    const page = x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
    (function scan(n) {
      for (const [k, child] of ce(n)) {
        if (quoteTypes.includes(RT(child))) {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
          const mappedIds = ids.split(',').filter(Boolean).map(id => styleMap[id] ? (styleMap[id].edsClass + '(' + id + ')') : 'UNMAPPED(' + id + ')');
          aemQuotes.push({
            page,
            key: k,
            styleIds: ids,
            mappedIds,
            attrs: Object.entries(child).filter(([k2]) => k2.startsWith('@')).reduce((o, [k2, v]) => { o[k2.slice(1)] = String(v).slice(0, 80); return o; }, {}),
          });
        }
        scan(child);
      }
    })(jcr);
  } catch (e) {}
}

console.log('\n--- Sample AEM quote nodes:');
aemQuotes.slice(0, 3).forEach(q => {
  console.log('Page:', q.page, ' key:', q.key);
  console.log('  styleIds:', q.styleIds, ' mapped:', q.mappedIds.join(','));
  Object.entries(q.attrs).forEach(([k, v]) => console.log('  ' + k + ' = ' + v));
  console.log();
});

// Now check EDS canvas output
function collectBlocks(sections, out) {
  out = out || [];
  for (const s of sections || []) {
    for (const b of s.blocks || []) visitBlock(b, out);
    for (const gs of s.blocks || []) {
      for (const c of gs.children || []) visitBlock(c, out);
    }
  }
  return out;
}
function visitBlock(b, out) {
  if (!b) return;
  if (b.type === 'quote') out.push(b);
  for (const c of b.children || []) visitBlock(c, out);
}

const dcFreq = {};
const propKeys = {};
let total = 0, errors = 0;
let edsSamples = [];

for (const x of aemXmls) {
  const rel = x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    const sections = aemToCanvas(jcr, { rel });
    const quotes = collectBlocks(sections);
    for (const q of quotes) {
      total++;
      const dc = q.props && q.props.classes_customDynamicClass || '(none)';
      dcFreq[dc] = (dcFreq[dc] || 0) + 1;
      for (const k of Object.keys(q.props || {})) propKeys[k] = (propKeys[k] || 0) + 1;
      if (edsSamples.length < 3) edsSamples.push({ page: rel, dc, props: q.props });
    }
  } catch (e) { errors++; }
}

console.log('\n--- EDS canvas quote output:');
console.log('Total quote blocks:', total, '  Errors:', errors);
console.log('Dynamic class distribution:');
Object.entries(dcFreq).sort((a, b) => b[1] - a[1]).forEach(p => console.log('  ' + p[1] + 'x  [' + p[0] + ']'));
console.log('\nProp keys (frequency):');
Object.entries(propKeys).sort((a, b) => b[1] - a[1]).forEach(p => console.log('  ' + p[1] + 'x  ' + p[0]));
console.log('\nSample EDS quote blocks:');
edsSamples.forEach(s => {
  console.log('  page:', s.page, ' dc:', s.dc);
  Object.entries(s.props || {}).forEach(([k, v]) => console.log('    ' + k + ' = ' + String(v).slice(0, 80)));
  console.log();
});
