// Read-only verification of AEM->EDS structural rules across every paired page.
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const P = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  trimValues: true,
  preserveOrder: true,
  isArray: () => false,
});

function walkFiles(root) {
  const out = [];
  (function r(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = d + '/' + e.name;
      if (e.isDirectory()) r(p);
      else if (e.name === '.content.xml') out.push(p);
    }
  })(root);
  return out;
}

// preserveOrder helpers: a node is { <tag>: [children], ':@': {attrs} }
function tagOf(node) { for (const k of Object.keys(node)) if (k !== ':@') return k; return null; }
function attrs(node) { return node[':@'] || {}; }
function kids(node) { const t = tagOf(node); return Array.isArray(node[t]) ? node[t] : []; }
function rt(node) { return attrs(node)['@sling:resourceType'] || ''; }
function last(rtStr) { return (rtStr || '').split('/').filter(Boolean).slice(-1)[0] || ''; }

// ---------- AEM extraction ----------
const AEM_LAYOUT = new Set(['responsivegrid', 'parsys', 'iparsys', 'root', 'page', 'remotepage']);
function aemLeafType(node) {
  const r = rt(node);
  const l = last(r);
  if (r.includes('/grid/')) return '__grid__';
  if (r.includes('/container/')) return '__container__';
  if (AEM_LAYOUT.has(l)) return null;
  if (l === 'columns') return null;
  if (l === 'experiencefragment') return '__xf__';
  return l; // title,text,button,image,separator,teaser,cardpagestory,linklist,header,quote,video,podcast...
}

function aemExtract(file) {
  const doc = P.parse(fs.readFileSync(file, 'utf8'));
  const res = { gridColSeq: [], bgColors: [], leaves: {}, hasContainer: 0, containerBgImg: 0 };
  function addLeaf(t) { if (!t) return; res.leaves[t] = (res.leaves[t] || 0) + 1; }
  function walk(node) {
    const a = attrs(node);
    const r = rt(node);
    if (r.includes('/container/')) {
      res.hasContainer++;
      if (a['@backgroundColor']) res.bgColors.push(a['@backgroundColor'].replace('#', '').toLowerCase());
      if (a['@backgroundImageReference'] || a['@fileReference'] && false) {}
      if (a['@backgroundImageReference']) res.containerBgImg++;
    }
    if (r.includes('/grid/')) {
      const rc = parseInt(a['@rowCount'] || '1') || 1;
      const ws = [];
      for (const c of kids(node)) {
        if (tagOf(c) === 'columns') {
          for (const it of kids(c)) {
            const w = attrs(it)['@columnWidth'];
            if (w != null) ws.push(String(w));
          }
        }
      }
      for (let i = 0; i < rc; i++) res.gridColSeq.push(...ws);
    }
    // leaf typing (skip layout/xf/grid/container/columns themselves for leaf counts)
    const r2 = rt(node);
    const l = last(r2);
    if (!r2.includes('/grid/') && !r2.includes('/container/') && l !== 'columns' &&
        !AEM_LAYOUT.has(l) && l !== 'experiencefragment' && l !== '') {
      addLeaf(l);
    }
    for (const c of kids(node)) walk(c);
  }
  // start at jcr:content
  function findContent(nodes) {
    for (const n of nodes) {
      if (tagOf(n) === 'jcr:content') return n;
      const f = findContent(kids(n));
      if (f) return f;
    }
    return null;
  }
  const content = findContent(doc);
  if (content) for (const c of kids(content)) walk(c);
  return res;
}

// ---------- EDS extraction ----------
function edsExtract(file) {
  const doc = P.parse(fs.readFileSync(file, 'utf8'));
  const res = { gridColSeq: [], bgClasses: [], models: {} };
  function addModel(m) { if (!m) return; res.models[m] = (res.models[m] || 0) + 1; }
  function walk(node) {
    const a = attrs(node);
    const model = a['@model'];
    const dyn = a['@style_customDynamicClass'] || a['@classes_customDynamicClass'] || '';
    if (model) addModel(model);
    if (model === 'grid-section') {
      const m = /grid-cols-(\d+)/.exec(dyn);
      res.gridColSeq.push(m ? m[1] : '?');
    }
    const bg = [...dyn.matchAll(/bg-([0-9a-fA-F]{6})/g)].map(x => x[1].toLowerCase());
    res.bgClasses.push(...bg);
    for (const c of kids(node)) walk(c);
  }
  function findContent(nodes) {
    for (const n of nodes) {
      if (tagOf(n) === 'jcr:content') return n;
      const f = findContent(kids(n));
      if (f) return f;
    }
    return null;
  }
  const content = findContent(doc);
  if (content) for (const c of kids(content)) walk(c);
  return res;
}

// ---------- run over all pairs ----------
const edsFiles = walkFiles('eds-xml');
let pairs = [];
for (const f of edsFiles) {
  const rel = f.slice('eds-xml/'.length);
  const cx = 'content-xml/' + rel;
  if (fs.existsSync(cx)) pairs.push({ rel, eds: f, aem: cx });
}

const BLOCK_MAP = {
  title: 'custom-title', text: 'text-container', button: 'cta', image: 'custom-image',
  quote: 'quote', video: 'video', podcast: 'brightcove-podcast-player', teaser: 'teaser',
  accordion: 'accordion', searchinput: 'search-input', linklist: 'linklist',
  cardpagestory: 'story-card', separator: 'separator',
};

const region = rel => rel.split('/').slice(0, 2).join('/');
const SPACER = new Set(['1', '11', '12']); // gutters(1) + full-width filler rows(11/12) EDS drops
const dropOnes = seq => seq.filter(x => !SPACER.has(x));

let S = {
  used: 0,
  aemHasGrid: 0, edsHasGrid: 0, bothGrid: 0, aemGridEdsNone: 0,
  exact: 0, exactNoSpacer: 0, colTotal: 0, colHit: 0,
  bgAll: 0, bgAllHit: 0, bgNonWhite: 0, bgNonWhiteHit: 0, whiteCount: 0,
  blockChecks: 0, blockMatch: 0,
  perType: {},            // aemType -> {checks, match, aemTot, edsTot}
  regionShell: {},        // region -> {aemGrid, edsNone}
  mism: [],
};

for (const pr of pairs) {
  let A, E;
  try { A = aemExtract(pr.aem); E = edsExtract(pr.eds); } catch (e) { continue; }
  if (Object.keys(E.models).length === 0) continue;
  S.used++;
  const reg = region(pr.rel);

  const aemG = A.gridColSeq.length > 0, edsG = E.gridColSeq.length > 0;
  if (aemG) S.aemHasGrid++;
  if (edsG) S.edsHasGrid++;
  if (aemG && !edsG) {
    S.aemGridEdsNone++;
    (S.regionShell[reg] = S.regionShell[reg] || { aemGrid: 0, edsNone: 0 }).edsNone++;
  }
  if (aemG) (S.regionShell[reg] = S.regionShell[reg] || { aemGrid: 0, edsNone: 0 }).aemGrid++;

  // Rule 1 tested ONLY where BOTH sides used grids (fair test of the rule itself)
  if (aemG && edsG) {
    S.bothGrid++;
    const a = A.gridColSeq.join(','), e = E.gridColSeq.join(',');
    const exact = a === e, noSp = dropOnes(A.gridColSeq).join(',') === dropOnes(E.gridColSeq).join(',');
    if (exact) S.exact++;
    if (noSp) S.exactNoSpacer++;
    else if (S.mism.length < 12) S.mism.push({ rel: pr.rel, aem: a, eds: e });
    const n = Math.max(A.gridColSeq.length, E.gridColSeq.length);
    for (let i = 0; i < n; i++) { S.colTotal++; if (A.gridColSeq[i] === E.gridColSeq[i]) S.colHit++; }
    const rr = (S.regGrid = S.regGrid || {})[reg] = S.regGrid[reg] || { n: 0, exact: 0, noSp: 0 };
    rr.n++; if (exact) rr.exact++; if (noSp) rr.noSp++;
  }

  // Rule 2: bg color -> class (split out white)
  const edsBg = new Set(E.bgClasses);
  for (const c of A.bgColors) {
    S.bgAll++; const hit = edsBg.has(c); if (hit) S.bgAllHit++;
    if (c === 'ffffff') { S.whiteCount++; }
    else { S.bgNonWhite++; if (hit) S.bgNonWhiteHit++; }
  }

  // Rule 3: block-map counts, per type
  for (const [aemT, edsM] of Object.entries(BLOCK_MAP)) {
    const ac = A.leaves[aemT] || 0; if (ac === 0) continue;
    const ec = E.models[edsM] || 0;
    S.blockChecks++; if (ec === ac) S.blockMatch++;
    const t = (S.perType[aemT] = S.perType[aemT] || { checks: 0, match: 0, aemTot: 0, edsTot: 0 });
    t.checks++; if (ec === ac) t.match++; t.aemTot += ac; t.edsTot += ec;
  }
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log('Pairs used (non-stub EDS):', S.used, 'of', pairs.length, '\n');

console.log('── STRUCTURAL SHAPE OF THE MIGRATION ──');
console.log('  AEM source has grids:', S.aemHasGrid, '| EDS result has grids:', S.edsHasGrid);
console.log('  AEM grids BUT EDS has none (restructured/shell):', S.aemGridEdsNone,
            '(' + pct(S.aemGridEdsNone, S.aemHasGrid) + ' of grid pages)');
console.log('  both sides use grids (rule is testable):', S.bothGrid);

console.log('\n── RULE 1: grid columns → grid-cols  (tested only where BOTH use grids) ──');
console.log('  exact sequence match:              ', S.exact, '(' + pct(S.exact, S.bothGrid) + ')');
console.log('  match IGNORING width-1 spacers:    ', S.exactNoSpacer, '(' + pct(S.exactNoSpacer, S.bothGrid) + ')');
console.log('  per-column positional hit:         ', pct(S.colHit, S.colTotal), `(${S.colHit}/${S.colTotal})`);

console.log('\n── RULE 2: container backgroundColor → bg-XXXXXX class ──');
console.log('  all bg colors:      ', pct(S.bgAllHit, S.bgAll), `(${S.bgAllHit}/${S.bgAll})`);
console.log('  #FFFFFF (white) seen:', S.whiteCount, '(EDS emits no class for white)');
console.log('  NON-white bg colors: ', pct(S.bgNonWhiteHit, S.bgNonWhite), `(${S.bgNonWhiteHit}/${S.bgNonWhite})`);

console.log('\n── RULE 3: block map, per AEM component type (count agreement) ──');
console.log('  overall:', pct(S.blockMatch, S.blockChecks), `(${S.blockMatch}/${S.blockChecks})`);
Object.entries(S.perType).sort((a, b) => b[1].checks - a[1].checks).forEach(([t, v]) =>
  console.log('   ', t.padEnd(14), '→', BLOCK_MAP[t].padEnd(22),
    pct(v.match, v.checks).padStart(6), `pages  (AEM ${v.aemTot} / EDS ${v.edsTot} instances)`));

console.log('\n── REGIONS where AEM has grids but EDS often has none (likely un-migrated shells) ──');
Object.entries(S.regionShell).filter(([, v]) => v.aemGrid >= 3)
  .map(([r, v]) => [r, v.edsNone, v.aemGrid, v.edsNone / v.aemGrid])
  .sort((a, b) => b[3] - a[3]).slice(0, 12)
  .forEach(([r, none, tot, frac]) => console.log('  ', r.padEnd(8), `${none}/${tot} shell (` + (100 * frac).toFixed(0) + '%)'));

console.log('\n── RULE 1 BY REGION (grid pages only; exact / spacer-tolerant) ──');
Object.entries(S.regGrid || {}).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n)
  .forEach(([r, v]) => console.log('  ', r.padEnd(8), `${String(v.n).padStart(3)} pages   exact ` +
    pct(v.exact, v.n).padStart(6) + '   no-spacer ' + pct(v.noSp, v.n).padStart(6)));

console.log('\n── sample grid MISMATCHES that survive spacer-drop (AEM vs EDS) ──');
for (const s of S.mism) console.log('  ', s.rel, '\n      AEM:', s.aem, '\n      EDS:', s.eds);
