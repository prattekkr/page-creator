#!/usr/bin/env node
// Read-only AEM → EDS style ledger for one paired page.
// Usage: node style-ledger.js country/lang/path
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const styleMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'style-map.json'), 'utf8'));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const ROOT = path.resolve(__dirname);

const rel = String(process.argv[2] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
if (!/^[a-z]{2}\/[a-z-]{2,}(?:\/[a-z0-9-]+)*$/i.test(rel)) {
  console.error('Usage: node style-ledger.js country/lang/page-path');
  process.exitCode = 1;
  return;
}
function pairedFile(kind) {
  const file = path.resolve(ROOT, kind, rel, '.content.xml');
  const base = path.resolve(ROOT, kind) + path.sep;
  if (!file.startsWith(base)) throw new Error('Invalid page path');
  return file;
}
const aemFile = pairedFile('content-xml');
const edsFile = pairedFile('eds-xml');
if (!fs.existsSync(aemFile) || !fs.existsSync(edsFile)) {
  console.error('Both content-xml and eds-xml files must exist for this page.');
  process.exitCode = 1;
  return;
}

const attrs = n => Object.fromEntries(Object.entries(n || {}).filter(([k]) => k.startsWith('@')));
const children = n => Object.entries(n || {}).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');
const rt = n => n?.['@sling:resourceType'] || '';
const layout = n => /\/(?:container|grid)\//.test(rt(n));
const anchor = n => {
  const a = attrs(n), r = rt(n);
  if (/\/title\//.test(r) && a['@jcr:title']) return 'title:' + String(a['@jcr:title']).replace(/<[^>]+>/g, '').trim().slice(0, 48);
  if (/\/button\//.test(r) && a['@text']) return 'cta:' + String(a['@text']).slice(0, 48);
  if (/\/image\//.test(r) && a['@fileReference']) return 'image:' + path.basename(a['@fileReference']);
  return '';
};
function aemStyles(node) {
  const a = attrs(node); const ids = String(a['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  const styles = ids.map(id => ({ id, label: styleMap[id]?.aemLabel || 'UNMAPPED', group: styleMap[id]?.groupLabel || 'UNMAPPED', edsClass: styleMap[id]?.edsClass || '' }));
  if (a['@backgroundColor']) styles.push({ id: 'backgroundColor', label: a['@backgroundColor'], group: 'Background', edsClass: a['@backgroundColor'].toLowerCase() === '#ffffff' ? '' : 'bg-' + a['@backgroundColor'].replace('#', '').toLowerCase() });
  return styles;
}
function aemLedger(content) {
  const out = [];
  function walk(node, names, ancestors) {
    for (const [name, child] of children(node)) {
      const next = names.concat(name); const parent = ancestors[ancestors.length - 1] || null;
      const entry = layout(child) ? { path: next.join('/'), type: rt(child).split('/').pop(), parent, styles: aemStyles(child), anchors: [] } : null;
      if (entry) out.push(entry);
      const nextAncestors = entry ? ancestors.concat(entry.path) : ancestors;
      const a = anchor(child); if (a) for (const scope of nextAncestors) out.find(x => x.path === scope)?.anchors.push(a);
      walk(child, next, nextAncestors);
    }
  }
  walk(content, [], []); return out;
}
function edsLedger(content) {
  const out = [];
  function walk(node, names, scopes = []) {
    for (const [name, child] of children(node)) {
      const next = names.concat(name); const a = attrs(child); const model = a['@model'];
      let scopePath = null;
      if (model === 'section' || model === 'grid-container') {
        scopePath = next.join('/');
        out.push({ path: scopePath, model, styles: Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('@style_')).map(([k, v]) => [k.slice(1), v])), anchors: [] });
      }
      const title = model === 'custom-title' && a['@title'] ? 'title:' + String(a['@title']).replace(/<[^>]+>/g, '').trim().slice(0, 48) : '';
      const cta = model === 'cta' && a['@linkText'] ? 'cta:' + String(a['@linkText']).slice(0, 48) : '';
      const image = /(?:custom-image|hero-container-item)/.test(model || '') && a['@image'] ? 'image:' + path.basename(a['@image']) : '';
      if (title || cta || image) for (const scope of scopes) out.find(x => x.path === scope)?.anchors.push(title || cta || image);
      walk(child, next, scopePath ? scopes.concat(scopePath) : scopes);
    }
  }
  walk(content, []); return out;
}
const aem = parser.parse(fs.readFileSync(aemFile, 'utf8'))['jcr:root']?.['jcr:content'];
const eds = parser.parse(fs.readFileSync(edsFile, 'utf8'))['jcr:root']?.['jcr:content'];
const source = aemLedger(aem), target = edsLedger(eds);
console.log(`STYLE LEDGER — ${rel}`);
console.log('\nAEM visual scopes (parent → child):');
for (const item of source) console.log(JSON.stringify(item));
console.log('\nEDS visual scopes:');
for (const item of target) console.log(JSON.stringify(item));
