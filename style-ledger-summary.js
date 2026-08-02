#!/usr/bin/env node
// Read-only corpus summary for parent/child AEM style relocation.
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const styleMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'style-map.json'), 'utf8'));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true, isArray: () => false });
const attrs = n => Object.fromEntries(Object.entries(n || {}).filter(([k]) => k.startsWith('@')));
const children = n => Object.entries(n || {}).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');
const walkFiles = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); e.isDirectory() ? walkFiles(p, out) : e.name === '.content.xml' && out.push(p); } return out; };
const score = (a, b) => { if (!a.size || !b.size) return 0; let same = 0; for (const x of a) if (b.has(x)) same++; return same / (a.size + b.size - same); };
const addAnchor = (n, isEds) => {
  const a = attrs(n); const r = a['@sling:resourceType'] || ''; const m = a['@model'] || '';
  if ((!isEds && /\/title\//.test(r) && a['@jcr:title']) || (isEds && m === 'custom-title' && a['@title'])) return 'T:' + String(a['@jcr:title'] || a['@title']).replace(/<[^>]+>/g, '').trim().slice(0, 40);
  if ((!isEds && /\/button\//.test(r) && a['@text']) || (isEds && m === 'cta' && a['@linkText'])) return 'C:' + String(a['@text'] || a['@linkText']).slice(0, 40);
  return '';
};
const sourceClasses = node => {
  const a = attrs(node); const ids = String(a['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  const classes = ids.map(id => styleMap[id]?.edsClass).filter(Boolean);
  const bg = String(a['@backgroundColor'] || '').replace('#', '').toLowerCase();
  if ((bg && bg !== 'ffffff') || a['@backgroundImageReference']) classes.push('background');
  return classes;
};
function scopes(content, isEds) {
  const out = [];
  function visit(n, parent = null) {
    const siblings = children(n);
    for (let index = 0; index < siblings.length; index++) {
      const [, child] = siblings[index];
      const a = attrs(child); const r = a['@sling:resourceType'] || ''; const m = a['@model'] || '';
      const sourceScope = !isEds && /\/(?:container|grid)\//.test(r);
      const targetScope = isEds && (m === 'section' || m === 'grid-container');
      const nextNode = !isEds && siblings.slice(index + 1).map(([, sibling]) => sibling)
        .find(sibling => /\/(?:container|grid)\//.test(attrs(sibling)['@sling:resourceType'] || ''));
      const nextLayout = nextNode ? attrs(nextNode)['@sling:resourceType'] || '' : '';
      const nextClasses = nextNode ? sourceClasses(nextNode) : [];
      const scope = sourceScope || targetScope ? { parent, kind: sourceScope ? r.split('/').pop() : m, anchors: new Set(), styles: [], hasGrid: false, hasBackground: false,
        nextSibling: nextLayout ? nextLayout.split('/').pop() : 'end', nextBackground: nextClasses.includes('background'),
        nextWide: nextClasses.includes('content-wide'), nextOverlap: nextClasses.includes('overlap-predecessor') } : null;
      if (scope) out.push(scope);
      const current = scope || parent;
      if (scope && sourceScope) {
        const ids = String(a['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
        scope.styles = ids.map(id => styleMap[id]?.edsClass).filter(Boolean);
        const bg = String(a['@backgroundColor'] || '').replace('#', '').toLowerCase();
        if (bg && bg !== 'ffffff') { scope.styles.push('bg-' + bg); scope.hasBackground = true; }
        if (a['@backgroundImageReference']) scope.hasBackground = true;
        if (/\/grid\//.test(r) && parent) parent.hasGrid = true;
      }
      if (scope && targetScope) {
        scope.styles = [
          ...String(a['@style_customDynamicClass'] || '').split(',').map(v => v.trim()).filter(Boolean),
          ...Object.entries(a).filter(([k]) => k.startsWith('@style_')).map(([, v]) => String(v)),
        ];
      }
      const anchor = addAnchor(child, isEds); if (anchor && current) current.anchors.add(anchor);
      if (!isEds && /\/separator\//.test(r) && current) current.hasSeparator = true;
      visit(child, current);
      if (current && parent) for (const x of current.anchors) parent.anchors.add(x);
    }
  }
  visit(content); return out;
}
const counts = {}; let sourceScopes = 0, aligned = 0;
const bottomMargin = {};
const plainRootTransitions = {};
for (const file of walkFiles(path.join(__dirname, 'content-xml'))) {
  const rel = path.relative(path.join(__dirname, 'content-xml'), path.dirname(file)).split(path.sep).join('/');
  const twin = path.join(__dirname, 'eds-xml', rel, '.content.xml'); if (!fs.existsSync(twin)) continue;
  try {
    const aem = parser.parse(fs.readFileSync(file, 'utf8'))['jcr:root']?.['jcr:content'];
    const eds = parser.parse(fs.readFileSync(twin, 'utf8'))['jcr:root']?.['jcr:content'];
    const source = scopes(aem, false), target = scopes(eds, true);
    for (const s of source) {
      if (!s.styles.length || !s.anchors.size) continue; sourceScopes++;
      let best = null, value = 0; for (const t of target) { const v = score(s.anchors, t.anchors); if (v > value) { value = v; best = t; } }
      if (!best || value < 0.5) continue; aligned++;
      const key = `${s.parent ? 'child' : 'root'}-aem → ${best.kind}`;
      const stat = counts[key] = counts[key] || { n: 0, styles: {} }; stat.n++;
      const targetStyles = new Set(best.styles);
      for (const cls of s.styles) {
        const entry = stat.styles[cls] = stat.styles[cls] || { source: 0, hit: 0 };
        entry.source++; if (targetStyles.has(cls)) entry.hit++;
      }
      if (s.styles.includes('no-bottom-margin') && best.kind === 'section') {
        const key = [s.parent ? 'child' : 'root', s.hasGrid ? 'contains-grid' : 'no-grid', s.hasBackground ? 'background' : 'plain',
          s.styles.includes('content-wide') ? 'wide' : 'not-wide'].join(' | ');
        const stat = bottomMargin[key] = bottomMargin[key] || { retained: 0, omitted: 0 };
        if (targetStyles.has('no-bottom-margin')) stat.retained++; else stat.omitted++;
        if (!s.parent && !s.hasGrid && !s.hasBackground && !s.styles.includes('content-wide')) {
        const transition = [s.nextSibling, s.hasSeparator ? 'has-separator' : 'no-separator',
          s.nextBackground ? 'next-background' : 'next-plain', s.nextWide ? 'next-wide' : 'next-not-wide',
          s.nextOverlap ? 'next-overlap' : 'next-no-overlap'].join(' | ');
          const t = plainRootTransitions[transition] = plainRootTransitions[transition] || { retained: 0, omitted: 0 };
          if (targetStyles.has('no-bottom-margin')) t.retained++; else t.omitted++;
        }
      }
    }
  } catch { /* malformed or intentionally incomplete page: skip */ }
}
console.log(`STYLE RELOCATION SUMMARY — ${aligned}/${sourceScopes} styled AEM scopes content-aligned`);
for (const [key, stat] of Object.entries(counts).sort((a, b) => b[1].n - a[1].n)) {
  const top = Object.entries(stat.styles).sort((a, b) => b[1].source - a[1].source).slice(0, 8)
    .map(([v, n]) => `${v}:${n.hit}/${n.source}`).join(', ');
  console.log(`${String(stat.n).padStart(5)}  ${key}  [${top}]`);
}
console.log('\nNO-BOTTOM-MARGIN — retained vs omitted after AEM → EDS section alignment');
for (const [key, stat] of Object.entries(bottomMargin).sort((a, b) => (b[1].retained + b[1].omitted) - (a[1].retained + a[1].omitted))) {
  const total = stat.retained + stat.omitted;
  console.log(`${String(stat.retained).padStart(4)}/${String(total).padEnd(4)} retained  ${key}`);
}
console.log('\nPLAIN ROOT TRANSITIONS — no-bottom-margin retained vs omitted');
for (const [key, stat] of Object.entries(plainRootTransitions).sort((a, b) => (b[1].retained + b[1].omitted) - (a[1].retained + a[1].omitted))) {
  const total = stat.retained + stat.omitted;
  console.log(`${String(stat.retained).padStart(4)}/${String(total).padEnd(4)} retained  ${key}`);
}
