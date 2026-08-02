// Data-driven style-map completion: for each UNMAPPED cq:styleId, find the EDS class it
// co-occurs with on value-aligned component pairs, using known mappings to explain-away
// the classes already accounted for. Falls back to page-level co-occurrence.
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const styleMap = JSON.parse(fs.readFileSync('./style-map.json', 'utf8'));
const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true, preserveOrder: true, isArray: () => false });

const tag = n => { for (const k of Object.keys(n)) if (k !== ':@') return k; };
const at = n => n[':@'] || {};
const kids = n => { const t = tag(n); return Array.isArray(n[t]) ? n[t] : []; };
const RT = n => at(n)['@sling:resourceType'] || '';
const lastSeg = s => (s || '').split('/').filter(Boolean).pop() || '';
const STRUCT = new Set(['section', 'grid-container', 'grid-section', 'root', 'page']);
const ITEMISH = m => /-item$|-text$|item$/.test(m);
const AEM_SKIP = new Set(['responsivegrid', 'parsys', 'iparsys', 'root', 'page', 'remotepage', 'columns']);
const SYS = k => k.startsWith('@jcr:') || k.startsWith('@cq:') || k === '@sling:resourceType' || k === '@model' || k === '@aueComponentId' || k === '@modelFields' || k === '@filter' || k === '@name' || k === '@language' || k.startsWith('@xmlns');
// classes NOT derived from styleIds (they come from grid columnWidth / layout) — never a target
const LAYOUT_CLASS = c => /^grid-cols-\d+$/.test(c) || c === 'grid-container' || c === 'grid-section';

function norm(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/^\{[A-Za-z]+\}/, '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim();
  if (!s) return null;
  const ytm = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{6,})/.exec(s);
  if (ytm) return 'yt:' + ytm[1];
  if (/[/]/.test(s) && (s.startsWith('/content') || s.startsWith('http') || s.includes('/dam/') || s.includes('urn:'))) {
    let base = s.split('?')[0].replace(/\/$/, '').split('/').pop() || s;
    base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
    return base.length >= 3 ? 'p:' + base.toLowerCase() : null;
  }
  s = s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.length >= 3 ? s : null;
}
const styleIdsOf = n => { const raw = at(n)['@cq:styleIds']; return raw ? String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean) : []; };
const classesOf = a => { const out = []; for (const key of ['@classes_customDynamicClass', '@classes', '@style_customDynamicClass']) { const v = a[key]; if (v) String(v).replace(/[\[\]]/g, '').split(',').forEach(c => { const t = c.trim(); if (t && !LAYOUT_CLASS(t)) out.push(t); }); } return out; };

function aemComps(f) {
  const doc = P.parse(fs.readFileSync(f, 'utf8')); const out = [];
  (function w(ns) { for (const n of ns) { const rt = RT(n), l = lastSeg(rt);
    const isLeaf = rt && !rt.includes('/container/') && !rt.includes('/grid/') && !AEM_SKIP.has(l) && !rt.startsWith('wcm/foundation/') && !rt.startsWith('foundation/components/') && l !== 'experiencefragment';
    if (isLeaf) { const vals = new Set(); (function sub(m) { for (const [k, v] of Object.entries(at(m))) if (!SYS(k)) { const nv = norm(v); if (nv) vals.add(nv); } for (const c of kids(m)) sub(c); })(n); out.push({ vs: vals, styleIds: styleIdsOf(n) }); }
    w(kids(n)); } })(doc);
  return out;
}
function edsBlocks(f) {
  const doc = P.parse(fs.readFileSync(f, 'utf8')); const out = [];
  (function w(ns) { for (const n of ns) { const m = at(n)['@model'];
    if (m && !STRUCT.has(m) && !ITEMISH(m)) { const vals = new Set(); const cls = new Set(); (function sub(x) { const a = at(x); for (const [k, v] of Object.entries(a)) if (!SYS(k)) { const nv = norm(v); if (nv) vals.add(nv); } classesOf(a).forEach(c => cls.add(c)); for (const c of kids(x)) sub(c); })(n); out.push({ vs: vals, classes: [...cls] }); }
    w(kids(n)); } })(doc);
  return out;
}
function walk(root) { const o = []; (function r(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) r(p); else if (e.name === '.content.xml') o.push(p); } })(root); return o; }
const toAem = rel => { const p = rel.split('/'); if (p[1] && p[1].includes('-')) p[1] = p[1].split('-')[0]; return p.join('/'); };

const pairs = [];
for (const ef of walk('eds-xml')) { const rel = ef.slice('eds-xml/'.length); const af = 'content-xml/' + toAem(rel); if (fs.existsSync(af)) pairs.push({ af, ef }); }

// pass 1: value df for idf
const df = {}; const cache = [];
for (const pr of pairs) { let A, E; try { A = aemComps(pr.af); E = edsBlocks(pr.ef); } catch { continue; } if (!A.length || !E.length) continue; for (const c of [...A, ...E]) for (const v of c.vs) df[v] = (df[v] || 0) + 1; cache.push({ A, E }); }
const N = cache.length; const idf = v => Math.log((N + 1) / (1 + (df[v] || 0)));

const known = id => styleMap[id] && styleMap[id].edsClass;
const vote = {};       // unmappedId → { edsClass → weighted }
const idSeen = {};     // id → # aligned blocks carrying it
const classSeen = {};  // class → # aligned blocks carrying it
let alignedBlocks = 0;
const bump = (id, c, w) => { (vote[id] = vote[id] || {})[c] = (vote[id][c] || 0) + w; };

for (const { A, E } of cache) {
  const cand = [];
  for (let i = 0; i < A.length; i++) for (let j = 0; j < E.length; j++) { let s = 0; for (const v of A[i].vs) if (E[j].vs.has(v)) s += idf(v); if (s > 0) cand.push([s, i, j]); }
  cand.sort((a, b) => b[0] - a[0]);
  const uA = new Set(), uE = new Set();
  for (const [s, i, j] of cand) {
    if (uA.has(i) || uE.has(j) || s < 2.0) continue; uA.add(i); uE.add(j);
    const S = A[i].styleIds, C = E[j].classes;
    if (!S.length) continue;
    alignedBlocks++;
    for (const id of S) idSeen[id] = (idSeen[id] || 0) + 1;
    for (const c of C) classSeen[c] = (classSeen[c] || 0) + 1;
    // explain-away: remove classes already accounted for by KNOWN ids on this block
    const explained = new Set(); for (const id of S) { const ec = known(id); if (ec) explained.add(ec); }
    const residual = C.filter(c => !explained.has(c));
    const unmapped = S.filter(id => !known(id));
    if (!unmapped.length || !residual.length) continue;
    const w = 1 / unmapped.length;                 // ambiguity discount
    for (const id of unmapped) for (const c of residual) bump(id, c, w);
  }
}

// score & propose
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const proposals = [];
for (const id of Object.keys(styleMap)) {
  if (known(id)) continue;
  const v = vote[id]; if (!v) continue;
  const ranked = Object.entries(v).sort((a, b) => b[1] - a[1]);
  const [c, w] = ranked[0];
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  const share = w / total;
  const support = w;                                 // weighted co-occurrence
  // lift: P(class|id) vs P(class) — specificity
  const pci = (v[c]) / (idSeen[id] || 1);
  const pc = (classSeen[c] || 1) / alignedBlocks;
  const lift = pci / pc;
  proposals.push({ id, label: styleMap[id].aemLabel, aemClass: styleMap[id].aemClass, c, support: +support.toFixed(1), share: pct(share, 1), lift: +lift.toFixed(1), seen: idSeen[id] || 0, alt: ranked.slice(1, 3).map(([cc, ww]) => `${cc}:${ww.toFixed(1)}`).join(' ') });
}
proposals.sort((a, b) => b.support - a.support);
console.log('Aligned blocks with styleIds:', alignedBlocks, '| unmapped with a candidate:', proposals.length, 'of 76\n');
console.log('CONFIDENT (support>=3, share>=50%, lift>=3):');
for (const p of proposals.filter(p => p.support >= 3 && p.share >= 50 && p.lift >= 3))
  console.log(`  ${p.id.padEnd(15)} "${p.label}" (${p.aemClass}) → ${p.c}   sup=${p.support} share=${p.share}% lift=${p.lift} seen=${p.seen}${p.alt ? '  alt:' + p.alt : ''}`);
console.log('\nWEAK / ambiguous (review):');
for (const p of proposals.filter(p => !(p.support >= 3 && p.share >= 50 && p.lift >= 3)))
  console.log(`  ${p.id.padEnd(15)} "${p.label}" (${p.aemClass}) → ${p.c}?   sup=${p.support} share=${p.share}% lift=${p.lift}${p.alt ? '  alt:' + p.alt : ''}`);
