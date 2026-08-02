#!/usr/bin/env node
/**
 * deep-style-compare.js — CONTENT-ALIGNED style validation for section & grid-container.
 * Positional comparison is unreliable (sectioning differs), so instead each converter section /
 * grid-container is matched to the twin node that holds the SAME content anchors (title texts, CTA
 * labels, image basenames), then the two style-class sets are diffed token-by-token. The tool
 * aggregates every MISSING token (twin has, converter doesn't → under-derivation) and EXTRA token
 * (converter emits, twin doesn't → over-emission), so systematic mapping errors surface.
 *
 * Usage:  node deep-style-compare.js [site|all]   (default cl/es)
 */
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');
const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const SITE = process.argv[2] || 'cl/es';

// approved defaults — flag separately so real derivation bugs stand out
const APPROVED = new Set(['regular-padding', 'no-bottom-margin', 'no-side-margin', 'content-wide', 'grid-container']);
const clsSet = v => new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean));

// anchor = stable content identifier found recursively under a node
const anchorOfBlock = b => {
  const p = b.props || {};
  if (b.type === 'custom-title' && p.title) return 'T:' + String(p.title).replace(/<[^>]+>/g, '').trim().slice(0, 30);
  if (b.type === 'cta' && p.linkText) return 'C:' + String(p.linkText).slice(0, 20);
  if ((b.type === 'custom-image' || b.type === 'hero-container-item') && p.image) return 'I:' + String(p.image).split('/').pop().slice(0, 20);
  if (b.type === 'eyebrow-text' && p.text) return 'E:' + String(p.text).replace(/<[^>]+>/g, '').trim().slice(0, 20);
  return null;
};
const anchorOfEds = n => {
  const m = n['@model'];
  if (m === 'custom-title' && n['@title']) return 'T:' + String(n['@title']).replace(/<[^>]+>/g, '').trim().slice(0, 30);
  if (m === 'cta' && n['@linkText']) return 'C:' + String(n['@linkText']).slice(0, 20);
  if ((m === 'custom-image' || m === 'hero-container-item') && n['@image']) return 'I:' + String(n['@image']).split('/').pop().slice(0, 20);
  if (m === 'eyebrow-text' && n['@text']) return 'E:' + String(n['@text']).replace(/<[^>]+>/g, '').trim().slice(0, 20);
  return null;
};

// collect converter section/grid-container nodes with {kind, cls, anchors}
function convNodes(sections) {
  const out = [];
  const anchorsUnder = b => { const a = []; (function w(x) { const an = anchorOfBlock(x); if (an) a.push(an); for (const c of (x.children || x.blocks || [])) w(c); })(b); return a; };
  const visit = b => {
    if (b.type === 'section' || b.type === 'grid-container')
      out.push({ kind: b.type, cls: clsSet(b.props && (b.props.style_customDynamicClass || b.props.classes_customDynamicClass)), anchors: new Set(anchorsUnder(b)) });
    for (const c of (b.blocks || b.children || [])) visit(c);
  };
  for (const s of Object.values(sections)) visit(s);
  return out;
}
function edsNodes(root) {
  const jc = (root['jcr:root'] || root)['jcr:content'] || root; const r = jc.root || jc;
  const out = [];
  const anchorsUnder = n => { const a = []; (function w(x) { if (x && typeof x === 'object') { const an = anchorOfEds(x); if (an) a.push(an); for (const k of Object.keys(x)) if (typeof x[k] === 'object') w(x[k]); } })(n); return a; };
  (function w(n) {
    if (!n || typeof n !== 'object') return;
    if (n['@model'] === 'section' || n['@model'] === 'grid-container')
      out.push({ kind: n['@model'], cls: clsSet(n['@style_customDynamicClass'] || n['@classes_customDynamicClass']), anchors: new Set(anchorsUnder(n)) });
    for (const k of Object.keys(n)) if (typeof n[k] === 'object') w(n[k]);
  })(r);
  return out;
}
const jac = (a, b) => { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

function pageFiles(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = `${root}/${entry.name}`;
    if (entry.isDirectory()) pageFiles(file, out);
    else if (entry.name === '.content.xml') out.push(file);
  }
  return out;
}
const sourceRoot = SITE === 'all' ? 'content-xml' : `content-xml/${SITE}`;
const pages = pageFiles(sourceRoot).map(f => f.replace(/^content-xml\//, '').replace(/\/\.content\.xml$/, ''))
  .filter(r => fs.existsSync(`eds-xml/${r}/.content.xml`));

const missing = {}, extra = {}, missingReal = {}, extraReal = {};
let aligned = 0, exact = 0, exactReal = 0;
const examples = [];

for (const rel of pages) {
  let cn, en;
  try { cn = convNodes(aemToCanvas(P.parse(fs.readFileSync(`content-xml/${rel}/.content.xml`, 'utf8'))['jcr:root']['jcr:content'], { rel })); en = edsNodes(P.parse(fs.readFileSync(`eds-xml/${rel}/.content.xml`, 'utf8'))); }
  catch (e) { continue; }
  const used = new Set();
  for (const c of cn) {
    if (!c.anchors.size) continue;                      // skip empty-content wrappers (can't align)
    let best = -1, bi = -1;
    en.forEach((e, i) => { if (used.has(i) || e.kind !== c.kind) return; const j = jac(c.anchors, e.anchors); if (j > best) { best = j; bi = i; } });
    if (bi < 0 || best < 0.5) continue;                 // require a solid content match
    used.add(bi); aligned++;
    const e = en[bi];
    const miss = [...e.cls].filter(x => !c.cls.has(x));
    const ext = [...c.cls].filter(x => !e.cls.has(x));
    if (!miss.length && !ext.length) exact++;
    const missR = miss.filter(x => !APPROVED.has(x)), extR = ext.filter(x => !APPROVED.has(x));
    if (!missR.length && !extR.length) exactReal++;
    for (const x of miss) missing[`${c.kind}:${x}`] = (missing[`${c.kind}:${x}`] || 0) + 1;
    for (const x of ext) extra[`${c.kind}:${x}`] = (extra[`${c.kind}:${x}`] || 0) + 1;
    for (const x of missR) missingReal[`${c.kind}:${x}`] = (missingReal[`${c.kind}:${x}`] || 0) + 1;
    for (const x of extR) extraReal[`${c.kind}:${x}`] = (extraReal[`${c.kind}:${x}`] || 0) + 1;
    if ((missR.length || extR.length) && examples.length < 25)
      examples.push(`  ${c.kind} [${rel}]  MISS{${missR.join(',')||'-'}}  EXTRA{${extR.join(',')||'-'}}`);
  }
}

const dump = o => Object.entries(o).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
console.log(`\nCONTENT-ALIGNED STYLE DIFF — ${SITE}  (${pages.length} pages, ${aligned} section/grid nodes aligned)`);
console.log(`  exact class match (incl. approved defaults): ${exact}/${aligned} = ${(100*exact/aligned).toFixed(0)}%`);
console.log(`  exact IGNORING approved defaults:            ${exactReal}/${aligned} = ${(100*exactReal/aligned).toFixed(0)}%`);
console.log(`\n=== MISSING tokens (twin has, converter does NOT — under-derivation) — REAL (excl approved) ===`); dump(missingReal);
console.log(`\n=== EXTRA tokens (converter emits, twin does NOT — over-emission) — REAL (excl approved) ===`); dump(extraReal);
console.log(`\n=== approved-default tokens still counted (context) ===`);
console.log('  MISSING:', JSON.stringify(Object.fromEntries(Object.entries(missing).filter(([k]) => APPROVED.has(k.split(':')[1])))));
console.log('  EXTRA:  ', JSON.stringify(Object.fromEntries(Object.entries(extra).filter(([k]) => APPROVED.has(k.split(':')[1])))));
console.log(`\n=== example real mismatches ===`); examples.forEach(e => console.log(e));
