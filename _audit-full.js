/**
 * Full AEM → EDS property + style gap audit across all components.
 * READ-ONLY — reports gaps only, makes no changes.
 */
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

const migrationMap = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const styleMap = JSON.parse(fs.readFileSync('style-map.json', 'utf8'));
const componentMap = migrationMap.componentMap || {};
const JCR_SYS = new Set(migrationMap.jcrSystemProps || []);
const WRITEBACK_SKIP = new Set(['cq:styleIds', 'textIsRich', 'cq:lastModified', 'cq:lastModifiedBy',
  'cq:template', 'cq:designPath', 'cq:tags']);

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

const RT = n => (n && n['@sling:resourceType'] || '').trim();
const ce = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

const allXmls = findXmls('content-xml');

// For each component: collect all AEM attr names seen in corpus
// and all cq:styleIds seen
const compAttrFreq = {};   // rt → { attrName → count }
const compStyleIds = {};   // rt → { styleId → count }
let totalPages = 0;

for (const x of allXmls) {
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    totalPages++;
    (function scan(n) {
      for (const [, child] of ce(n)) {
        const rt = RT(child);
        if (rt && componentMap[rt]) {
          compAttrFreq[rt] = compAttrFreq[rt] || {};
          compStyleIds[rt] = compStyleIds[rt] || {};
          for (const [k, v] of Object.entries(child)) {
            if (!k.startsWith('@')) continue;
            const name = k.slice(1);
            if (!JCR_SYS.has(name) && !WRITEBACK_SKIP.has(name)) {
              compAttrFreq[rt][name] = (compAttrFreq[rt][name] || 0) + 1;
            }
          }
          // style IDs
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          for (const id of ids) compStyleIds[rt][id] = (compStyleIds[rt][id] || 0) + 1;
        }
        scan(child);
      }
    })(jcr);
  } catch (e) {}
}

console.log('Total pages scanned:', totalPages);
console.log('Components with corpus data:', Object.keys(compAttrFreq).length);
console.log('');

// Load picklist classes for each component
function loadPicklists() {
  const out = {};
  const root = path.join(__dirname, 'config');
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const m = e.isDirectory() && e.name.match(/^(.*)-picklist-config$/);
      if (!m) continue;
      const file = path.join(root, e.name, '.content.xml');
      try {
        const xml = fs.readFileSync(file, 'utf8');
        out[m[1]] = new Set(Array.from(xml.matchAll(/Style_x0020_Class="([^"]+)"/g)).map(x => x[1]));
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}
const PICKLISTS = loadPicklists();

// EDS type → picklist name mapping
const PICKLIST_KEY = {
  'custom-title': 'title', 'text-container': 'text', 'custom-image': 'image',
  'brightcove-video': 'video', 'accordion': 'accordion', 'teaser': 'teaser',
  'quote': 'quote', 'cta': 'cta', 'separator': 'separator', 'eyebrow-text': 'eyebrow-text',
  'linklist': 'linklist', 'carousel': 'carousel', 'hero-container': 'hero-container',
  'story-card': 'story-card', 'fact-card': 'fact-card',
};
const picklistFor = edsType => PICKLISTS[PICKLIST_KEY[edsType] || edsType] || null;

const DIVIDER = '─'.repeat(80);

for (const [rt, mapping] of Object.entries(componentMap)) {
  const attrFreq = compAttrFreq[rt];
  if (!attrFreq) continue; // component not seen in corpus

  const renames = mapping.propRenames || {};
  const skipProps = new Set(mapping.skipProps || []);
  const edsType = mapping.edsType;
  const picklist = picklistFor(edsType);

  const allAemAttrs = Object.entries(attrFreq).sort((a, b) => b[1] - a[1]);

  // Classify each AEM attr
  const mapped = [], skipped = [], unmapped = [], sysSkipped = [];
  for (const [name, count] of allAemAttrs) {
    if (JCR_SYS.has(name) || WRITEBACK_SKIP.has(name)) { sysSkipped.push({ name, count }); continue; }
    if (skipProps.has(name)) { skipped.push({ name, count }); continue; }
    if (renames[name]) { mapped.push({ name, count, to: renames[name] }); continue; }
    unmapped.push({ name, count });
  }

  // Style gap: IDs in corpus not in style-map
  const styleIds = compStyleIds[rt] || {};
  const unmappedStyles = [], mappedStyles = [];
  for (const [id, count] of Object.entries(styleIds).sort((a, b) => b[1] - a[1])) {
    if (styleMap[id]) mappedStyles.push({ id, count, edsClass: styleMap[id].edsClass });
    else unmappedStyles.push({ id, count });
  }

  // Style classes that exist in style-map but NOT in picklist (wrong-component bleed risk)
  const bleedRisk = mappedStyles.filter(({ edsClass }) => picklist && !picklist.has(edsClass));

  const hasGap = unmapped.length > 0 || unmappedStyles.length > 0 || bleedRisk.length > 0;

  console.log(DIVIDER);
  console.log('COMPONENT: ' + rt);
  console.log('EDS type : ' + edsType + (hasGap ? '  ⚠ GAPS FOUND' : '  ✓ clean'));
  console.log(DIVIDER);

  // Mapped props
  console.log('\n  MAPPED PROPS (' + mapped.length + '):');
  if (mapped.length) {
    mapped.forEach(m => console.log('    @' + m.name.padEnd(36) + '→  ' + m.to.padEnd(32) + '  (' + m.count + 'x)'));
  } else console.log('    (none)');

  // Unmapped props (potential gaps)
  if (unmapped.length) {
    console.log('\n  ⚠ UNMAPPED PROPS (in corpus, NOT in propRenames/skipProps):');
    unmapped.forEach(m => console.log('    @' + m.name.padEnd(36) + '  ' + m.count + 'x  ← NEEDS DECISION: map or skip?'));
  }

  // Skipped props
  console.log('\n  SKIPPED PROPS (' + skipped.length + '):');
  if (skipped.length) {
    skipped.forEach(m => console.log('    @' + m.name.padEnd(36) + '  ' + m.count + 'x'));
  } else console.log('    (none)');

  // Style IDs: mapped
  console.log('\n  STYLE IDs MAPPED (' + mappedStyles.length + '):');
  if (mappedStyles.length) {
    mappedStyles.slice(0, 10).forEach(m => console.log('    ' + m.id.padEnd(20) + '→  ' + m.edsClass.padEnd(36) + '  (' + m.count + 'x)' + (picklist && !picklist.has(m.edsClass) ? '  ⚠ NOT in picklist' : '')));
    if (mappedStyles.length > 10) console.log('    … and ' + (mappedStyles.length - 10) + ' more');
  } else console.log('    (none)');

  // Style IDs: unmapped
  if (unmappedStyles.length) {
    console.log('\n  ⚠ UNMAPPED STYLE IDs (in corpus, NOT in style-map.json):');
    unmappedStyles.forEach(m => console.log('    ' + m.id.padEnd(20) + '  ' + m.count + 'x  ← NEEDS entry in style-map.json'));
  }

  // Bleed risk: mapped style class not in this component's picklist
  if (bleedRisk.length) {
    console.log('\n  ⚠ STYLE CLASS BLEED RISK (mapped class NOT in this component\'s picklist):');
    bleedRisk.forEach(m => console.log('    styleId ' + m.id.padEnd(20) + '→  ' + m.edsClass.padEnd(30) + '  (' + m.count + 'x)  ← class belongs to another component\'s policy'));
  }

  console.log('');
}

// Summary of all unmapped style IDs across all components
console.log('═'.repeat(80));
console.log('GLOBAL STYLE MAP GAPS (IDs seen in corpus but missing from style-map.json)');
console.log('═'.repeat(80));
const globalUnmapped = {};
for (const [rt, ids] of Object.entries(compStyleIds)) {
  for (const [id, count] of Object.entries(ids)) {
    if (!styleMap[id]) {
      globalUnmapped[id] = globalUnmapped[id] || { count: 0, rts: [] };
      globalUnmapped[id].count += count;
      globalUnmapped[id].rts.push(rt.split('/').pop());
    }
  }
}
const sorted = Object.entries(globalUnmapped).sort((a, b) => b[1].count - a[1].count);
if (sorted.length) {
  sorted.forEach(([id, info]) => console.log('  ' + id.padEnd(22) + '  ' + info.count + 'x  on: ' + info.rts.join(', ')));
} else {
  console.log('  None — all style IDs in corpus are mapped in style-map.json ✓');
}
console.log('');
