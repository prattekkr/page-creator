'use strict';
const fs = require('fs');
const {aemToCanvas} = require('./aem-canvas');
const styleMap = JSON.parse(fs.readFileSync('./style-map.json', 'utf8'));

// Minimal XML-to-object parser (same attribute-prefix-@ approach as server.js)
const {XMLParser} = require('fast-xml-parser');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

const xmlPath = './content-xml/ch/de/science/.content.xml';
const xml = fs.readFileSync(xmlPath, 'utf8');

// Find all prebuilt template style IDs in the XML
const PREBUILT = new Set(['3','4','5','165354545645741','165354545645742','165354545645743','165354545645744','165354545645745','165354545645746','165354545645747']);
const styleIdMatches = [...xml.matchAll(/cq:styleIds="([^"]+)"/g)];
console.log('=== PreBuilt Template style IDs found in XML ===');
let found = 0;
for (const m of styleIdMatches) {
  const ids = m[1].replace(/[\[\]\s]/g, '').split(',');
  const hit = ids.filter(id => PREBUILT.has(id));
  if (hit.length) {
    found++;
    console.log('  styleIds:', m[1], '-> IDs:', hit, '->', hit.map(id => styleMap[id] && styleMap[id].edsClass));
  }
}
if (!found) console.log('  (none found — the page may use a different style ID set)');

// Parse XML and run conversion
const parsed = parser.parse(xml);
const jcrContent = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
if (!jcrContent) { console.log('No jcr:content found'); process.exit(1); }

const sections = aemToCanvas(jcrContent, {rel: 'ch/de/science'});
console.log('\n=== Grid containers in migrated canvas ===');
sections.filter(s => s.type === 'grid-container').forEach((s, i) => {
  const cls = s.props.style_customDynamicClass || '(none)';
  const tpl = s.props.style_gridTemplate || '(none)';
  console.log('GC #' + i + ': cls=' + cls + ' | gridTemplate=' + tpl);
});

console.log('\n=== All cq:styleIds on containers in XML (looking for prebuilt) ===');
// Grep for containers with prebuilt IDs
const containerMatches = [...xml.matchAll(/<(?:container|responsivegrid)\d*\s[^>]*cq:styleIds="([^"]+)"[^>]*>/g)];
for (const m of containerMatches) {
  const ids = m[1].replace(/[\[\]\s]/g, '').split(',');
  const hit = ids.filter(id => PREBUILT.has(id));
  if (hit.length) console.log('  Container match:', m[1]);
}
