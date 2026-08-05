const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const migrationMap = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const styleMap = JSON.parse(fs.readFileSync('style-map.json', 'utf8'));
const componentMap = migrationMap.componentMap || {};

// Find linklist resourceTypes
const llTypes = Object.entries(componentMap).filter(([, v]) => v.edsType === 'linklist').map(([k]) => k);
console.log('Linklist resourceTypes:', llTypes);

// Show picklist config
const picklistFile = path.join('config', 'linklist-picklist-config', '.content.xml');
if (fs.existsSync(picklistFile)) {
  const xml = fs.readFileSync(picklistFile, 'utf8');
  const classes = Array.from(xml.matchAll(/Style_x0020_Class="([^"]+)"/g)).map(m => m[1]);
  console.log('Linklist picklist classes:', classes);
} else {
  console.log('No linklist picklist config found');
}

function RT(n) { return (n && n['@sling:resourceType'] || '').trim(); }
const childEntries = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

function findXmls(dir, out) {
  out = out || [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findXmls(full, out);
      else if (e.name === '.content.xml') out.push(full);
    }
  } catch (e) {}
  return out;
}

function findLinklists(n, out) {
  out = out || [];
  for (const entry of childEntries(n)) {
    const child = entry[1];
    const rt = RT(child);
    if (llTypes.includes(rt)) {
      const raw = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
      const ids = raw.split(',').filter(Boolean);
      const mapped = ids.map(function(id) {
        return styleMap[id] ? (styleMap[id].edsClass + '(' + id + ')') : 'UNMAPPED(' + id + ')';
      });
      out.push({ ids: ids, mapped: mapped, raw: raw });
    }
    findLinklists(child, out);
  }
  return out;
}

const xmls = findXmls('content-xml');
console.log('Total XML files:', xmls.length);

const styleFreq = {};
let withStyles = 0, withoutStyles = 0;

for (let i = 0; i < xmls.length; i++) {
  const x = xmls[i];
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    const lls = findLinklists(jcr);
    for (const ll of lls) {
      if (ll.ids.length) {
        withStyles++;
        const key = ll.mapped.join(',');
        styleFreq[key] = (styleFreq[key] || 0) + 1;
      } else {
        withoutStyles++;
      }
    }
  } catch (e) {}
}

console.log('Linklists WITH styleIds:', withStyles, '  WITHOUT styleIds:', withoutStyles);
console.log('AEM style ID combos on linklists:');
const sorted = Object.entries(styleFreq).sort(function(a, b) { return b[1] - a[1]; });
sorted.forEach(function(pair) {
  console.log('  ' + pair[1] + 'x  ' + pair[0]);
});

// Show sample AEM XML of a linklist WITH styleIds
let shown = 0;
for (let i = 0; i < xmls.length && shown < 2; i++) {
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(xmls[i], 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    function findWithStyle(n) {
      for (const entry of childEntries(n)) {
        const child = entry[1];
        const rt = RT(child);
        if (llTypes.includes(rt) && String(child['@cq:styleIds'] || '').trim()) {
          return child;
        }
        const found = findWithStyle(child);
        if (found) return found;
      }
      return null;
    }
    const node = findWithStyle(jcr);
    if (node) {
      console.log('\nSample linklist node attrs:');
      const rel = xmls[i].replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
      console.log('  page:', rel);
      Object.entries(node).filter(function(e) { return e[0].startsWith('@'); }).forEach(function(e) {
        console.log('  ' + e[0] + ' = ' + String(e[1]).slice(0, 80));
      });
      shown++;
    }
  } catch (e) {}
}
