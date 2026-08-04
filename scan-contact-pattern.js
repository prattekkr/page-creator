const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const parser = new xml2js.Parser();

// Width style IDs: container-small, medium, large, x-large, xx-large
const WIDTH_STYLE_IDS = ['1653545825688', '1653545825687', '1653545825686', '1653545825685', '1653545825689'];

function hasWidthStyle(styleIds) {
  return WIDTH_STYLE_IDS.some(id => styleIds.includes(id));
}

function getVal(node, key) {
  if (!node || !node.$) return '';
  return node.$[key] || '';
}

function findPattern(node, depth, results, pagePath) {
  if (!node || typeof node !== 'object') return;

  const rt = getVal(node, 'sling:resourceType');

  // Check if this is a container with a width style
  if (rt.includes('container') && !rt.includes('responsivegrid')) {
    const styleIds = String(getVal(node, 'cq:styleIds'));
    if (hasWidthStyle(styleIds)) {
      // Check ALL direct children for a grid component
      for (const key in node) {
        if (key === '$') continue;
        const child = node[key];
        if (!child || typeof child !== 'object') continue;
        const childArray = Array.isArray(child) ? child : [child];
        for (const c of childArray) {
          if (!c || !c.$) continue;
          const crt = c.$['sling:resourceType'] || '';
          if (crt.includes('grid/v2/grid') || crt.includes('components/grid')) {
            // Get grid column info
            const columns = c.columns || null;
            let columnWidths = [];
            if (columns) {
              const cols = Array.isArray(columns) ? columns[0] : columns;
              for (const ck in cols) {
                if (ck.startsWith('item')) {
                  const item = Array.isArray(cols[ck]) ? cols[ck][0] : cols[ck];
                  if (item && item.$) {
                    columnWidths.push(item.$['columnWidth'] || '?');
                  }
                }
              }
            }
            results.push({
              page: pagePath,
              container: key,
              styleIds: styleIds,
              depth: depth,
              gridName: key,
              gridColumns: columnWidths.join('-') || 'unknown'
            });
          }
        }
      }
    }
  }

  // Traverse children
  for (const key in node) {
    if (key === '$') continue;
    const child = node[key];
    if (!child || typeof child !== 'object') continue;
    const childArray = Array.isArray(child) ? child : [child];
    for (const c of childArray) {
      findPattern(c, depth + 1, results, pagePath);
    }
  }
}

function walk(dir, rel, callback) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('.') || item.name.startsWith('_')) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = rel ? rel + '/' + item.name : item.name;
      const xmlPath = path.join(fullPath, '.content.xml');
      if (fs.existsSync(xmlPath)) {
        callback(xmlPath, relPath);
      }
      walk(fullPath, relPath, callback);
    }
  } catch (e) {
    // skip
  }
}

const results = [];
let total = 0;

walk('content-xml', '', (xmlPath, relPath) => {
  total++;
  try {
    const content = fs.readFileSync(xmlPath, 'utf8');
    parser.parseString(content, (err, data) => {
      if (!err && data) {
        const jcrRoot = data['jcr:root'];
        if (!jcrRoot) return;
        const jcrContentArr = jcrRoot['jcr:content'];
        const jcrContent = Array.isArray(jcrContentArr) ? jcrContentArr[0] : jcrContentArr;
        if (jcrContent) {
          findPattern(jcrContent, 0, results, relPath);
        }
      }
    });
  } catch (e) {
    // skip
  }
});

console.log('\nTotal AEM pages scanned: ' + total);
console.log('Pages matching contact-us pattern (container with width style + nested grid): ' + results.length);

// Group by page
const byPage = {};
for (const r of results) {
  if (!byPage[r.page]) byPage[r.page] = [];
  byPage[r.page].push(r);
}

console.log('\nUnique pages with this pattern: ' + Object.keys(byPage).length);
console.log('\nAll matching pages:');
for (const pg of Object.keys(byPage)) {
  const entries = byPage[pg];
  console.log('  ' + pg);
  for (const e of entries) {
    console.log('    container: ' + e.container + ' | grid columns: ' + e.gridColumns + ' | depth: ' + e.depth);
  }
}

fs.writeFileSync('contact-us-pattern-matches.json', JSON.stringify({ total_scanned: total, matches: results, by_page: byPage }, null, 2));
console.log('\nFull results saved to contact-us-pattern-matches.json');
