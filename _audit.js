// Comprehensive AEM→EDS mapping audit: derive block types + prop renames from all
// migrated pairs by value-alignment, then diff against migration-map.json.
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const mm = require('./migration-map.json');
const cmap = mm.componentMap || {};
const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', trimValues: true, preserveOrder: true, isArray: () => false });

const tag = n => { for (const k of Object.keys(n)) if (k !== ':@') return k; };
const at = n => n[':@'] || {};
const kids = n => { const t = tag(n); return Array.isArray(n[t]) ? n[t] : []; };
const RT = n => at(n)['@sling:resourceType'] || '';
const lastSeg = s => (s || '').split('/').filter(Boolean).pop() || '';

const STRUCT = new Set(['section', 'grid-container', 'grid-section', 'root', 'page']);
const ITEMISH = m => /-item$|-text$|item$/.test(m);
const AEM_SKIP = new Set(['responsivegrid', 'parsys', 'iparsys', 'root', 'page', 'remotepage', 'columns']);
const SYS = k => k.startsWith('@jcr:') || k.startsWith('@cq:') || k === '@sling:resourceType' ||
  k === '@model' || k === '@aueComponentId' || k === '@modelFields' || k === '@filter' ||
  k === '@name' || k === '@language' || k === '@aueComponentId' || k.startsWith('@xmlns');

// normalize a value for cross-side equality (handles tags, entities, paths, youtube, arrays)
function norm(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/^\{[A-Za-z]+\}/, '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim();
  if (!s) return null;
  const ytm = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{6,})/.exec(s);
  if (ytm) return 'yt:' + ytm[1];
  if (/[/]/.test(s) && (s.startsWith('/content') || s.startsWith('http') || s.includes('/dam/') || s.includes('urn:'))) {
    // path/url → basename without extension (bridges AEM path vs EDS DM URL)
    let base = s.split('?')[0].replace(/\/$/, '').split('/').pop() || s;
    base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
    return base.length >= 3 ? 'p:' + base.toLowerCase() : null;
  }
  // text: strip tags + entities, collapse ws
  s = s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.length >= 3 ? s : null;
}

// gather AEM leaf components with own+descendant (prop,value) pairs
function aemComps(ef) {
  const doc = P.parse(fs.readFileSync(ef, 'utf8'));
  const out = [];
  (function w(ns) {
    for (const n of ns) {
      const rt = RT(n), l = lastSeg(rt);
      const isLeaf = rt && !rt.includes('/container/') && !rt.includes('/grid/') &&
        !AEM_SKIP.has(l) && !rt.startsWith('wcm/foundation/') && !rt.startsWith('foundation/components/') &&
        l !== 'experiencefragment';
      if (isLeaf) {
        const pairs = [];
        (function sub(m) { for (const [k, v] of Object.entries(at(m))) if (!SYS(k)) pairs.push([k.slice(1), v]); for (const c of kids(m)) sub(c); })(n);
        out.push({ rt, pairs });
      }
      w(kids(n));
    }
  })(doc);
  return out;
}
// gather EDS content blocks with own+descendant (prop,value) pairs
function edsBlocks(ef) {
  const doc = P.parse(fs.readFileSync(ef, 'utf8'));
  const out = [];
  (function w(ns) {
    for (const n of ns) {
      const m = at(n)['@model'];
      if (m && !STRUCT.has(m) && !ITEMISH(m)) {
        const pairs = [];
        (function sub(x) { for (const [k, v] of Object.entries(at(x))) if (!SYS(k)) pairs.push([k.slice(1), v]); for (const c of kids(x)) sub(c); })(n);
        out.push({ model: m, pairs });
      }
      w(kids(n));
    }
  })(doc);
  return out;
}
const valueSet = pairs => { const s = new Set(); for (const [, v] of pairs) { const n = norm(v); if (n) s.add(n); } return s; };

// ---- pass 1: collect all pairs, build df for idf weighting ----
function walk(root) { const o = []; (function r(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) r(p); else if (e.name === '.content.xml') o.push(p); } })(root); return o; }
const toAem = rel => { const p = rel.split('/'); if (p[1] && p[1].includes('-')) p[1] = p[1].split('-')[0]; return p.join('/'); };
const pairs = [];
for (const ef of walk('eds-xml')) { const rel = ef.slice('eds-xml/'.length); const af = 'content-xml/' + toAem(rel); if (fs.existsSync(af)) pairs.push({ af, ef }); }

const df = {};                       // value → #components containing it (both sides pooled)
const cache = [];
for (const pr of pairs) {
  let A, E; try { A = aemComps(pr.af); E = edsBlocks(pr.ef); } catch { continue; }
  if (!A.length || !E.length) continue;
  const Av = A.map(c => ({ ...c, vs: valueSet(c.pairs) }));
  const Ev = E.map(c => ({ ...c, vs: valueSet(c.pairs) }));
  for (const c of [...Av, ...Ev]) for (const v of c.vs) df[v] = (df[v] || 0) + 1;
  cache.push({ Av, Ev });
}
const N = pairs.length;
const idf = v => Math.log((N + 1) / (1 + (df[v] || 0)));

// ---- pass 2: align per pair (greedy weighted overlap), vote ----
const blockVote = {};                // aemRt → { edsModel → count }
const propVote = {};                 // aemRt → aemProp → { edsProp → count }
const aemPropSeen = {};              // aemRt → aemProp → count (how often present)
const bump = (o, a, b) => { (o[a] = o[a] || {})[b] = (o[a][b] || 0) + 1; };

for (const { Av, Ev } of cache) {
  // score all AEM×EDS pairs by shared idf-weighted values
  const cand = [];
  for (let i = 0; i < Av.length; i++) for (let j = 0; j < Ev.length; j++) {
    let s = 0; for (const v of Av[i].vs) if (Ev[j].vs.has(v)) s += idf(v);
    if (s > 0) cand.push([s, i, j]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  const usedA = new Set(), usedE = new Set();
  for (const [s, i, j] of cand) {
    if (usedA.has(i) || usedE.has(j) || s < 2.0) continue;   // threshold: need real shared content
    usedA.add(i); usedE.add(j);
    const A = Av[i], E = Ev[j];
    bump(blockVote, A.rt, E.model);
    // prop derivation: AEM (prop,val) that equals some EDS (prop,val)
    const edsByVal = {}; for (const [pk, pv] of E.pairs) { const nv = norm(pv); if (nv) (edsByVal[nv] = edsByVal[nv] || []).push(pk); }
    const seen = new Set();
    for (const [ak, av] of A.pairs) {
      (aemPropSeen[A.rt] = aemPropSeen[A.rt] || {})[ak] = (aemPropSeen[A.rt][ak] || 0) + (seen.has(ak) ? 0 : 1);
      seen.add(ak);
      const nv = norm(av); if (!nv) continue;
      // Only derive renames from DISTINCTIVE values — skip booleans/numbers/common tokens,
      // otherwise every "false" matches every other "false" and pollutes the votes.
      if (/^(true|false|yes|no|on|off|none|\d+)$/.test(nv)) continue;
      if (idf(nv) < 2.5) continue;                    // value must be reasonably rare
      const targets = new Set(edsByVal[nv] || []);
      for (const ek of targets) bump((propVote[A.rt] = propVote[A.rt] || {}), ak, ek);
    }
  }
}

// ---- report ----
const top = o => Object.entries(o || {}).sort((a, b) => b[1] - a[1])[0];
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
console.log('AUDIT — AEM component → EDS block, derived from', cache.length, 'pairs\n');

const rows = Object.keys(blockVote).sort((a, b) => {
  const ta = Object.values(blockVote[a]).reduce((x, y) => x + y, 0);
  const tb = Object.values(blockVote[b]).reduce((x, y) => x + y, 0);
  return tb - ta;
});
for (const rt of rows) {
  const votes = blockVote[rt]; const tot = Object.values(votes).reduce((a, b) => a + b, 0);
  if (tot < 4) continue;
  const [dm, dc] = top(votes);
  const cur = cmap[rt]?.edsType || '(unmapped)';
  const typeFlag = cur !== dm ? `   ⚠ current=${cur}` : '';
  const alt = Object.entries(votes).filter(([m]) => m !== dm).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([m, c]) => `${m}:${c}`).join(' ');
  console.log(`${lastSeg(rt).padEnd(18)} → ${dm.padEnd(24)} ${pct(dc, tot)}% n=${tot}${typeFlag}${alt ? '   (also ' + alt + ')' : ''}`);
  // prop renames
  const pv = propVote[rt] || {}; const cur_ren = cmap[rt]?.propRenames || {};
  const lines = [];
  for (const ak of Object.keys(pv)) {
    const [ek, ec] = top(pv[ak]); const seen = aemPropSeen[rt]?.[ak] || 0;
    if (ec < 3) continue;
    const curTo = cur_ren[ak];
    let flag = '';
    if (!curTo) flag = ek === ak ? '  (+ pass-through ok)' : '  ⚠ MISSING';
    else if (curTo !== ek) flag = `  ⚠ current→${curTo}`;
    if (flag) lines.push(`      ${ak} → ${ek}   ${pct(ec, seen)}% n=${ec}${flag}`);
  }
  for (const l of lines) console.log(l);
}
