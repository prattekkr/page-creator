'use strict';
/**
 * Comprehensive AEM → EDS Style Mapping Audit
 * Scans every .content.xml in content-xml/, extracts every cq:styleIds,
 * resolves the component type via sling:resourceType + migration-map,
 * and checks style-map.json for each ID.
 */

const fs   = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const ROOT         = __dirname;
const CONTENT_XML  = path.join(ROOT, 'content-xml');
const STYLE_MAP    = JSON.parse(fs.readFileSync(path.join(ROOT, 'style-map.json'), 'utf8'));
const MIGRATION    = JSON.parse(fs.readFileSync(path.join(ROOT, 'migration-map.json'), 'utf8'));

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  trimValues: true,
  isArray: () => false,
});

// ── Same rtToComponentType logic as server.js ─────────────────────────────────
function rtToComponentType(rt) {
  if (!rt) return null;
  if (rt.includes('/grid/')) return 'grid';
  if (rt.includes('/header/') || rt.includes('/eyebrow-text') || rt.includes('/eyebrow/')) return 'eyebrow-text';
  if (rt.includes('/teaser/')) return 'teaser';
  if (rt.includes('/video/') || rt.includes('/brightcove')) return 'brightcove-video';
  if (rt.includes('/accordion/')) return 'accordion';
  if (rt.includes('/carousel/')) return 'carousel';
  if (rt.includes('/linklist/') || rt.includes('/link-list/')) return 'linklist';
  if (rt.includes('/newsfeed') || rt.includes('/news-feed')) return 'news-feed';
  if (rt.includes('/button/') || rt.includes('/cta')) return 'cta';
  if (rt.includes('/quote')) return 'quote';
  if (rt.includes('/cardpagestory') || rt.includes('/storyinfo')) return 'story-card';
  if (rt.includes('/image/') || rt.includes('/dynamicmedia')) return 'custom-image';
  if (rt.includes('/text/')) return 'text-container';
  if (rt.includes('/title/')) return 'custom-title';
  if (rt.includes('/separator/')) return 'separator';
  if (rt.includes('/dashboardcards') && rt.includes('/link')) return 'dashboard-card-link-list';
  if (rt.includes('/dashboardcards')) return 'fact-card';
  if (rt.includes('/stockticker')) return 'stock-ticker';
  if (rt.includes('/homepage-hero-controller')) return 'hero-container';
  if (rt.includes('/hero-container-item') || rt.includes('/herocontaineritem')) return 'hero-container-item';
  if (rt.includes('/grid-container')) return 'grid-container';
  if (rt.includes('/grid-section')) return 'grid-section';
  if (rt.includes('/inner-grid')) return 'inner-grid';
  if (rt.includes('/container/') || rt.includes('/responsivegrid')) return 'section';
  if (rt.includes('/section')) return 'section';
  return MIGRATION.componentMap?.[rt]?.edsType || null;
}

// ── Resolve styleId in style-map (same logic as server.js resolveStyleId) ─────
function resolveStyleId(id, compType) {
  if (!id) return null;
  if (compType && STYLE_MAP[compType] && STYLE_MAP[compType][id]) return STYLE_MAP[compType][id];
  if (STYLE_MAP._shared && STYLE_MAP._shared[id]) return STYLE_MAP._shared[id];
  const root = STYLE_MAP[id];
  if (root && typeof root === 'object' && 'edsClass' in root) return root;
  return null;
}

// ── Collect all .content.xml files recursively ───────────────────────────────
function findXmls(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return results; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) findXmls(fp, results);
    else if (e.name === '.content.xml') results.push(fp);
  }
  return results;
}

// ── Walk XML tree collecting {file, path, rt, styleIds[]} ────────────────────
function walkNode(node, filePath, nodePath, hits, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 30) return;
  for (const [key, child] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@')) continue;
    if (!child || typeof child !== 'object') continue;
    const rt       = (child['@sling:resourceType'] || '').trim();
    const rawIds   = child['@cq:styleIds'];
    if (rawIds) {
      const ids = String(rawIds).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
      hits.push({ file: filePath, nodePath: `${nodePath}/${key}`, rt, ids });
    }
    walkNode(child, filePath, `${nodePath}/${key}`, hits, depth + 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const xmlFiles = findXmls(CONTENT_XML);
console.log(`\nScanning ${xmlFiles.length} XML files in content-xml/...\n`);

// { styleId → { compType, entries: [{file, nodePath, rt}] } }
const unmapped  = {};  // styleId not found in style-map
const mapped    = {};  // styleId found
const errors    = [];

let totalHits = 0;

for (const fp of xmlFiles) {
  let tree;
  try {
    const xml = fs.readFileSync(fp, 'utf8');
    tree = PARSER.parse(xml);
  } catch (e) {
    errors.push(`PARSE ERROR ${fp}: ${e.message}`);
    continue;
  }
  const jcrContent = (tree['jcr:root'] || tree)['jcr:content'] || tree;
  const hits = [];
  walkNode(jcrContent, fp, '', hits);

  for (const { file, nodePath, rt, ids } of hits) {
    const compType = rtToComponentType(rt);
    const relFile  = path.relative(CONTENT_XML, file).split(path.sep).join('/');
    for (const id of ids) {
      totalHits++;
      const resolved = resolveStyleId(id, compType);
      const bucket   = resolved ? mapped : unmapped;
      if (!bucket[id]) bucket[id] = { compType, rt, edsClass: resolved?.edsClass || '', entries: [] };
      bucket[id].entries.push({ file: relFile, nodePath });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const unmappedIds  = Object.keys(unmapped).sort();
const mappedIds    = Object.keys(mapped).sort();
const totalUnique  = unmappedIds.length + mappedIds.length;

console.log('═'.repeat(70));
console.log('  AEM → EDS STYLE MAPPING AUDIT');
console.log('═'.repeat(70));
console.log(`  XML files scanned   : ${xmlFiles.length}`);
console.log(`  Total styleId hits  : ${totalHits}`);
console.log(`  Unique style IDs    : ${totalUnique}`);
console.log(`  ✅  Mapped           : ${mappedIds.length}`);
console.log(`  ❌  UNMAPPED         : ${unmappedIds.length}`);
if (errors.length) console.log(`  ⚠️  Parse errors    : ${errors.length}`);
console.log('═'.repeat(70));

if (unmappedIds.length === 0) {
  console.log('\n✅  ALL style IDs in every AEM XML page are mapped in style-map.json!\n');
} else {
  console.log(`\n❌  ${unmappedIds.length} UNMAPPED STYLE IDs (sorted by usage count):\n`);

  // Sort by usage count desc
  const sorted = unmappedIds
    .map(id => ({ id, ...unmapped[id] }))
    .sort((a, b) => b.entries.length - a.entries.length);

  for (const item of sorted) {
    const pages = [...new Set(item.entries.map(e => e.file))];
    console.log(`  ID: ${item.id}`);
    console.log(`    resourceType : ${item.rt || '(none)'}`);
    console.log(`    compType     : ${item.compType || '(unresolved)'}`);
    console.log(`    occurrences  : ${item.entries.length} (in ${pages.length} page(s))`);
    console.log(`    pages        : ${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ` ... +${pages.length - 5} more` : ''}`);
    console.log('');
  }

  // Summary by component type
  console.log('─'.repeat(70));
  console.log('  UNMAPPED IDs BY COMPONENT TYPE:\n');
  const byComp = {};
  for (const item of sorted) {
    const ct = item.compType || `(unresolved — rt: ${item.rt || 'none'})`;
    if (!byComp[ct]) byComp[ct] = [];
    byComp[ct].push(item.id);
  }
  for (const [ct, ids] of Object.entries(byComp).sort()) {
    console.log(`  ${ct} (${ids.length} IDs): ${ids.join(', ')}`);
  }
}

if (errors.length) {
  console.log('\n─'.repeat(70));
  console.log('PARSE ERRORS:');
  errors.forEach(e => console.log(' ', e));
}

// Write JSON report
const report = {
  scannedFiles: xmlFiles.length,
  totalHits,
  totalUniqueIds: totalUnique,
  mappedCount: mappedIds.length,
  unmappedCount: unmappedIds.length,
  unmapped: Object.fromEntries(
    unmappedIds.map(id => [id, {
      rt: unmapped[id].rt,
      compType: unmapped[id].compType,
      occurrences: unmapped[id].entries.length,
      pages: [...new Set(unmapped[id].entries.map(e => e.file))]
    }])
  ),
  mapped: Object.fromEntries(
    mappedIds.map(id => [id, {
      rt: mapped[id].rt,
      compType: mapped[id].compType,
      edsClass: mapped[id].edsClass,
      occurrences: mapped[id].entries.length
    }])
  )
};

const reportPath = path.join(ROOT, 'style-mapping-audit.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`\nFull JSON report written to: style-mapping-audit.json\n`);
