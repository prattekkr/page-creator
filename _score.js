// Score the aem-canvas converter: regenerate each page from AEM only, compare to real EDS.
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');
const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const Pord = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true, preserveOrder: true, isArray: () => false });

const STRUCT = new Set(['section', 'grid-container', 'grid-section', 'root', 'page']);
const ITEMISH = t => /-item$|-text$/.test(t);

function convCanvasStats(aemFile) {
  const doc = P.parse(fs.readFileSync(aemFile, 'utf8'));
  const jc = (doc['jcr:root'] || doc)['jcr:content'];
  if (!jc) return null;
  const secs = aemToCanvas(jc);
  const gcols = [], blocks = [];
  const pushBlk = b => { if (!STRUCT.has(b.type) && !ITEMISH(b.type)) blocks.push(b.type); };
  for (const s of secs) {
    if (s.type === 'grid-container') for (const gs of s.blocks) {
      const m = /grid-cols-(\d+)/.exec(gs.props.style_customDynamicClass || ''); gcols.push(m ? m[1] : '?');
      for (const b of gs.children) pushBlk(b);
    } else for (const b of (s.blocks || [])) pushBlk(b);
  }
  return { gcols, blocks };
}

// EDS truth via preserveOrder walk
const tag = n => { for (const k of Object.keys(n)) if (k !== ':@') return k; };
const at = n => n[':@'] || {};
const kids = n => { const t = tag(n); return Array.isArray(n[t]) ? n[t] : []; };
function findC(ns) { for (const n of ns) { if (tag(n) === 'jcr:content') return n; const f = findC(kids(n)); if (f) return f; } return null; }
function edsStats(edsFile) {
  const d = Pord.parse(fs.readFileSync(edsFile, 'utf8'));
  const c = findC(d); const gcols = [], blocks = [];
  (function w(ns) { for (const n of ns) { const a = at(n); const m = a['@model']; const dyn = a['@style_customDynamicClass'] || '';
    if (m === 'grid-section') { const x = /grid-cols-(\d+)/.exec(dyn); gcols.push(x ? x[1] : '?'); }
    if (m && !STRUCT.has(m) && !ITEMISH(m)) blocks.push(m);
    w(kids(n)); } })(kids(c));
  return { gcols, blocks };
}

const SPACER = new Set(['1', '11', '12']);
const content = s => s.filter(x => !SPACER.has(x));
function multiset(a) { const m = {}; for (const x of a) m[x] = (m[x] || 0) + 1; return m; }
function overlap(a, b) { const ma = multiset(a), mb = multiset(b); let o = 0; for (const k in ma) o += Math.min(ma[k], mb[k] || 0); return o; }

function walk(root) { const o = []; (function r(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) r(p); else if (e.name === '.content.xml') o.push(p); } })(root); return o; }
const toAem = rel => { const p = rel.split('/'); if (p[1] && p[1].includes('-')) p[1] = p[1].split('-')[0]; return p.join('/'); };

const CLEAN = new Set(['us/en', 'gr/el', 'nz/en']);
const files = walk('eds-xml');
const per = {};                 // region -> accumulator
let sampleShown = 0;
for (const ef of files) {
  const rel = ef.slice('eds-xml/'.length);
  const reg = rel.split('/').slice(0, 2).join('/');
  const af = 'content-xml/' + toAem(rel);
  if (!fs.existsSync(af)) continue;
  let C, E; try { C = convCanvasStats(af); E = edsStats(ef); } catch (e) { continue; }
  if (!C || !E || E.blocks.length + E.gcols.length === 0) continue;   // skip stubs
  const r = per[reg] = per[reg] || { n: 0, gridPages: 0, gridExact: 0, gridContent: 0, colHit: 0, colTot: 0, blkOverlap: 0, blkEds: 0, blkConv: 0 };
  r.n++;
  if (E.gcols.length || C.gcols.length) {
    r.gridPages++;
    if (C.gcols.join() === E.gcols.join()) r.gridExact++;
    if (content(C.gcols).join() === content(E.gcols).join()) r.gridContent++;
    const nmax = Math.max(C.gcols.length, E.gcols.length);
    for (let i = 0; i < nmax; i++) { r.colTot++; if (C.gcols[i] === E.gcols[i]) r.colHit++; }
  }
  r.blkOverlap += overlap(C.blocks, E.blocks); r.blkEds += E.blocks.length; r.blkConv += C.blocks.length;

  if (CLEAN.has(reg) && sampleShown < 6 && content(C.gcols).join() !== content(E.gcols).join()) {
    sampleShown++;
    console.log('MISS', rel.replace('/.content.xml', ''), '\n   conv:', C.gcols.join(','), '\n   eds :', E.gcols.join(','));
  }
}

const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : 'n/a';
console.log('\nregion    pages  gridPg  grid-exact  grid-content  col-hit  block-recall  block-precision');
const order = [...Object.keys(per)].sort((a, b) => per[b].n - per[a].n);
let clean = { gridPages: 0, gridContent: 0, blkOverlap: 0, blkEds: 0, blkConv: 0 };
for (const reg of order) {
  const r = per[reg];
  console.log(reg.padEnd(9), String(r.n).padStart(4), String(r.gridPages).padStart(6),
    pct(r.gridExact, r.gridPages).padStart(11), pct(r.gridContent, r.gridPages).padStart(13),
    pct(r.colHit, r.colTot).padStart(8), pct(r.blkOverlap, r.blkEds).padStart(13), pct(r.blkOverlap, r.blkConv).padStart(16));
  if (CLEAN.has(reg)) { clean.gridPages += r.gridPages; clean.gridContent += r.gridContent; clean.blkOverlap += r.blkOverlap; clean.blkEds += r.blkEds; clean.blkConv += r.blkConv; }
}
console.log('\nCLEAN REGIONS (us/en+gr/el+nz/en): grid-content ' + pct(clean.gridContent, clean.gridPages) +
  '  block-recall ' + pct(clean.blkOverlap, clean.blkEds) + '  block-precision ' + pct(clean.blkOverlap, clean.blkConv));
