#!/usr/bin/env node
/**
 * compare-grel.js — deep 1:1 validation of the converter against the hand-migrated EDS twins for a
 * whole site (default gr/el). For every page it flattens BOTH the converter output and the EDS twin
 * into an ordered block sequence and reports:
 *   • STRUCTURAL DRIFT  — block types the converter dropped (in twin, not in output) or invented
 *   • CLASS DIFFS       — per block type, classes_customDynamicClass the converter got wrong
 *   • KEY-PROP DIFFS    — content/props that differ (title, uri, link, variant, color, …)
 * Then aggregates precision/recall per block type across the site.
 *
 * Usage:  node compare-grel.js [site]        e.g. node compare-grel.js gr/el
 *         node compare-grel.js gr/el --page who-we-are     (detailed dump of one page)
 */
const fs = require('fs');
const cp = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');
const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

const SITE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'gr/el';
const ONE = (() => { const i = process.argv.indexOf('--page'); return i > 0 ? process.argv[i + 1] : null; })();

// which props matter per block type (content + identifying)
const KEY_PROPS = {
  'custom-title': ['title', 'titleType'], 'hero-container-item': ['backgroundVariant', 'image'],
  cta: ['link', 'linkText'], video: ['uri'], 'brightcove-video': ['videoId'],
  'custom-image': ['image', 'imageAlt'], breadcrumb: ['homePagePath'], linklist: ['variant', 'linkSource'],
  quote: ['quotation'], 'fact-card': ['contentFragment'], 'story-card': ['page'],
  accordion: ['blockHeading'], 'eyebrow-text': [],
};
const clsKey = t => (t === 'section' || t === 'grid-container' ? 'style_customDynamicClass' : 'classes_customDynamicClass');
const norm = s => String(s == null ? '' : s).replace(/^\{Boolean\}/, '').trim();
const clsSet = v => new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean));
const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const clsStr = v => [...clsSet(v)].sort().join(',') || '∅';

// flatten converter output → [{type, cls, props}]
function flattenConv(sections) {
  const out = [];
  const visit = b => {
    if (!b || !b.type) return;
    out.push({ type: b.type, cls: (b.props || {})[clsKey(b.type)], props: b.props || {} });
    for (const c of (b.children || b.blocks || [])) visit(c);
  };
  for (const s of Object.values(sections)) visit(s);
  return out;
}
// flatten EDS twin → [{type, cls, props}]
function flattenEds(root) {
  const jc = (root['jcr:root'] || root)['jcr:content'] || root;
  const r = jc.root || jc;
  const out = [];
  const visit = n => {
    if (!n || typeof n !== 'object') return;
    if (n['@model']) {
      const props = {}; for (const k of Object.keys(n)) if (k[0] === '@' && !k.startsWith('@jcr:') && !k.startsWith('@sling:') && !k.startsWith('@cq:')) props[k.slice(1)] = n[k];
      out.push({ type: n['@model'], cls: n['@' + clsKey(n['@model'])], props });
    }
    for (const k of Object.keys(n)) if (typeof n[k] === 'object') visit(n[k]);
  };
  visit(r);
  return out;
}
// multiset of types
const typeCounts = arr => arr.reduce((m, b) => (m[b.type] = (m[b.type] || 0) + 1, m), {});

const pages = cp.execSync(`find content-xml/${SITE} -name .content.xml`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  .map(f => f.replace(/^content-xml\//, '').replace(/\/\.content\.xml$/, ''))
  .filter(rel => fs.existsSync(`eds-xml/${rel}/.content.xml`));

const agg = {};            // type → {tp, convN, edsN}  (for precision/recall)
const classAgg = {};       // type → {match, total}
const drift = { dropped: {}, invented: {} };
const lines = [];

for (const rel of (ONE ? pages.filter(p => p.includes(ONE)) : pages)) {
  let conv, eds;
  try {
    const jc = P.parse(fs.readFileSync(`content-xml/${rel}/.content.xml`, 'utf8'))['jcr:root']['jcr:content'];
    conv = flattenConv(aemToCanvas(jc, { rel }));
    eds = flattenEds(P.parse(fs.readFileSync(`eds-xml/${rel}/.content.xml`, 'utf8')));
  } catch (e) { lines.push(`\n### ${rel}\n  ERROR: ${e.message}`); continue; }

  const cCounts = typeCounts(conv), eCounts = typeCounts(eds);
  const allTypes = new Set([...Object.keys(cCounts), ...Object.keys(eCounts)]);
  const pageDrift = [];
  for (const t of allTypes) {
    const c = cCounts[t] || 0, e = eCounts[t] || 0;
    agg[t] = agg[t] || { tp: 0, convN: 0, edsN: 0 };
    agg[t].convN += c; agg[t].edsN += e; agg[t].tp += Math.min(c, e);
    if (e > c) { drift.dropped[t] = (drift.dropped[t] || 0) + (e - c); pageDrift.push(`  ✗ dropped ${e - c}× ${t} (conv ${c}, eds ${e})`); }
    if (c > e) { drift.invented[t] = (drift.invented[t] || 0) + (c - e); pageDrift.push(`  ⚠ extra   ${c - e}× ${t} (conv ${c}, eds ${e})`); }
  }
  // class + prop diffs on positionally-aligned same-type blocks (per type queue)
  const byTypeEds = {}; eds.forEach(b => (byTypeEds[b.type] = byTypeEds[b.type] || []).push(b));
  const idx = {};
  const clsDiffs = [], propDiffs = [];
  for (const cb of conv) {
    const q = byTypeEds[cb.type]; if (!q) continue;
    const i = idx[cb.type] || 0; if (i >= q.length) continue; idx[cb.type] = i + 1;
    const eb = q[i];
    classAgg[cb.type] = classAgg[cb.type] || { match: 0, total: 0 };
    classAgg[cb.type].total++;
    if (setEq(clsSet(cb.cls), clsSet(eb.cls))) classAgg[cb.type].match++;
    else clsDiffs.push(`  ~ ${cb.type} class: conv[${clsStr(cb.cls)}] vs eds[${clsStr(eb.cls)}]`);
    for (const p of (KEY_PROPS[cb.type] || [])) {
      const cv = norm(cb.props[p]), ev = norm(eb.props[p]);
      if (cv !== ev && !(p === 'image' && cv && ev)) propDiffs.push(`  ≠ ${cb.type}.${p}: conv"${cv.slice(0, 45)}" vs eds"${ev.slice(0, 45)}"`);
    }
  }
  if (pageDrift.length || clsDiffs.length || propDiffs.length || ONE) {
    lines.push(`\n### ${rel}`);
    lines.push(`  conv types: ${JSON.stringify(cCounts)}`);
    lines.push(`  eds  types: ${JSON.stringify(eCounts)}`);
    pageDrift.forEach(l => lines.push(l));
    (ONE ? clsDiffs : clsDiffs.slice(0, 8)).forEach(l => lines.push(l));
    (ONE ? propDiffs : propDiffs.slice(0, 8)).forEach(l => lines.push(l));
  }
}

// ---- report ----
console.log(`\n${'='.repeat(80)}\nDEEP COMPARISON — ${SITE}  (${pages.length} pages with both AEM + EDS)\n${'='.repeat(80)}`);
console.log(lines.join('\n'));

console.log(`\n${'='.repeat(80)}\nAGGREGATE — block-type precision / recall\n${'='.repeat(80)}`);
console.log('  type'.padEnd(26) + 'conv  eds   matched  recall  precision');
for (const [t, a] of Object.entries(agg).sort((x, y) => y[1].edsN - x[1].edsN)) {
  const rec = a.edsN ? (100 * a.tp / a.edsN).toFixed(0) : '—';
  const prec = a.convN ? (100 * a.tp / a.convN).toFixed(0) : '—';
  console.log('  ' + t.padEnd(24) + String(a.convN).padEnd(6) + String(a.edsN).padEnd(6) + String(a.tp).padEnd(9) + (rec + '%').padEnd(8) + prec + '%');
}
console.log(`\n${'='.repeat(80)}\nAGGREGATE — classes_customDynamicClass exact-match per type\n${'='.repeat(80)}`);
for (const [t, a] of Object.entries(classAgg).sort((x, y) => y[1].total - x[1].total))
  console.log('  ' + t.padEnd(24) + `${a.match}/${a.total} = ${a.total ? (100 * a.match / a.total).toFixed(0) : '—'}%`);

console.log(`\n${'='.repeat(80)}\nSTRUCTURAL DRIFT TOTALS\n${'='.repeat(80)}`);
console.log('  DROPPED (in twin, missing from converter):', JSON.stringify(drift.dropped));
console.log('  EXTRA   (produced, not in twin):          ', JSON.stringify(drift.invented));
console.log('\nDone.\n');
