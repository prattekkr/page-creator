#!/usr/bin/env node
/**
 * coverage-audit.js — runs the AEM→EDS converter over every page and flags the CLASSES of defect
 * that slip past pair-based validation (because the failure lives where we don't have a twin):
 *
 *   1. DROPPED CONTENT   — AEM nodes that carry real content/background but yield no EDS block
 *                          (this is how the color hero silently disappeared on 1241 pages).
 *   2. UNKNOWN PROPS     — a produced prop key that isn't a field on that block's EDS model
 *                          (this is how `fileReference` leaked onto the video block).
 *   3. INVALID CLASSES   — a classes_* token that never appears in ANY EDS twin
 *                          (this is how raw AEM classes like `cmp-accordion-large`/`bg-071d49` leak).
 *   4. FORCED DEFAULTS   — a value emitted on ~100% of a block's instances while the EDS twins show
 *                          real variety (this is the tell for a hardcoded variant: rows-with-arrows,
 *                          separator-standard, standard,bold-font).
 *
 * Usage:  node coverage-audit.js            (full report)
 *         node coverage-audit.js --top 40   (limit rows per section)
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');

const P = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });
const TOP = (() => { const i = process.argv.indexOf('--top'); return i > 0 ? parseInt(process.argv[i + 1]) || 30 : 30; })();
const migrationMap = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const contentDefaults = JSON.parse(fs.readFileSync('content-defaults.json', 'utf8'));

// ---- EDS model field sets (allowed prop keys per block) -------------------------------------
const MODELS = JSON.parse(fs.readFileSync('component-models.json', 'utf8'));
const MODEL_FIELDS = {};   // model id → Set(field names)
for (const m of (Array.isArray(MODELS) ? MODELS : MODELS.models || [])) {
  if (!m || !m.id) continue;
  MODEL_FIELDS[m.id] = new Set((m.fields || []).map(f => f && f.name).filter(Boolean));
}
// converter block.type → EDS model id (all match 1:1 today; keep the hook for future aliases)
const TYPE_TO_MODEL = {};
const modelFor = t => MODEL_FIELDS[TYPE_TO_MODEL[t] || t];
// converter/JCR scaffolding keys that are not model fields (don't flag these)
const SCAFFOLD = new Set(['filter', 'style_container', 'style_customDynamicClass', 'cq:panelTitle', 'classes', 'cq:styleIds']);

// ---- valid EDS class tokens (union of every classes_* token seen in the twins) --------------
function buildValidClasses() {
  const valid = new Set();
  const CLASS_KEYS = /(customDynamicClass|commonCustomClass|_container$|style_customDynamicClass)/;
  const files = grepFiles('classes_customDynamicClass', 'eds-xml');
  for (const f of files) {
    let t; try { t = P.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    (function w(o) {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (k[0] === '@' && CLASS_KEYS.test(k.slice(1)) && typeof o[k] === 'string')
          for (const c of o[k].split(',').map(s => s.trim()).filter(Boolean)) valid.add(c);
        else if (typeof o[k] === 'object') w(o[k]);
      }
    })(t);
  }
  return valid;
}
function grepFiles(pattern, dir) {
  try { return cp.execSync(`grep -rl "${pattern}" ${dir} --include=*.xml`, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim().split('\n').filter(Boolean); }
  catch { return []; }
}

// ---- walk helpers ---------------------------------------------------------------------------
function eachBlock(sections, fn) {
  const visit = b => { if (!b) return; fn(b); for (const c of (b.children || b.blocks || [])) visit(c); };
  for (const s of Object.values(sections)) { fn(s); for (const b of (s.blocks || [])) visit(b); }
}
function aemLeafTypes(jc) {                 // AEM leaf resourceTypes present on the page (mapped ones)
  const out = [];
  (function w(o) {
    if (!o || typeof o !== 'object') return;
    const rt = o['@sling:resourceType'];
    if (rt && migrationMap.componentMap[rt]) out.push({ rt, node: o });
    for (const k of Object.keys(o)) if (typeof o[k] === 'object') w(o[k]);
  })(jc);
  return out;
}

// ---- run over the corpus --------------------------------------------------------------------
console.error('Loading valid EDS classes from twins…');
const VALID_CLASSES = buildValidClasses();
console.error(`  ${VALID_CLASSES.size} distinct valid class tokens`);

const files = grepFiles('sling:resourceType', 'content-xml');
console.error(`Auditing ${files.length} AEM pages…`);

const unknownProps = {};      // "block.prop" → count
const invalidClasses = {};    // "block: token" → count
const droppedBg = [];         // pages with an AEM background that produced no hero
const blockValueCounts = {};  // block → field → value → count ; block → __n
let pages = 0;

for (const f of files) {
  const rel = f.replace(/^content-xml\//, '').replace(/[\\/]\.content\.xml$/, '').replace(/\\/g, '/');
  let jc, sections;
  try { jc = P.parse(fs.readFileSync(f, 'utf8'))['jcr:root']['jcr:content']; if (!jc) continue; sections = aemToCanvas(jc, { rel }); }
  catch { continue; }
  pages++;

  // (1) dropped background: AEM has a bg image/color-empty container but output has no hero-container
  let heroCount = 0; eachBlock(sections, b => { if (b.type === 'hero-container') heroCount++; });
  let aemBgHeroes = 0;
  const hasGridChild = o => Object.keys(o).some(k => k[0] !== '@' && o[k] && typeof o[k] === 'object'
    && (/\/grid/.test(o[k]['@sling:resourceType'] || '') || hasGridChild(o[k])));
  (function w(o) {
    if (!o || typeof o !== 'object') return;
    const rt = o['@sling:resourceType'] || '';
    if (/container/.test(rt)) {
      const col = (o['@backgroundColor'] || '').replace('#', '').toLowerCase();
      const empty = !Object.keys(o).some(k => k[0] !== '@' && o[k] && typeof o[k] === 'object');
      // a background container that contains a grid becomes a grid-container-with-background, NOT a
      // hero — only count hero-shaped ones (bg-image without a grid, or an empty color container).
      if ((o['@backgroundImageReference'] && !hasGridChild(o)) || (empty && col && col !== 'ffffff')) aemBgHeroes++;
    }
    for (const k of Object.keys(o)) if (typeof o[k] === 'object') w(o[k]);
  })(jc);
  // Only a TOTAL miss (AEM has a background but the page produced no hero at all) is high-signal;
  // a partial (2 bg containers → 1 hero) is usually a decorative mid-page band, not a dropped hero.
  if (aemBgHeroes > 0 && heroCount === 0) droppedBg.push({ rel, aem: aemBgHeroes, out: heroCount });

  // (2)(3)(4) prop + class + value checks on produced blocks
  eachBlock(sections, b => {
    if (!b.type || !b.props) return;
    const merged = { ...(contentDefaults[b.type] || {}), ...b.props };
    const fields = modelFor(b.type);
    blockValueCounts[b.type] = blockValueCounts[b.type] || { __n: 0 };
    blockValueCounts[b.type].__n++;
    for (const [k, v] of Object.entries(merged)) {
      // (2) unknown prop key
      if (fields && !fields.has(k) && !SCAFFOLD.has(k) && !k.startsWith('style_') && !k.startsWith('cq:'))
        unknownProps[`${b.type}.${k}`] = (unknownProps[`${b.type}.${k}`] || 0) + 1;
      // (3) invalid class token
      if (/(customDynamicClass|commonCustomClass)$/.test(k) && typeof v === 'string')
        for (const c of v.split(',').map(s => s.trim()).filter(Boolean))
          if (!VALID_CLASSES.has(c)) invalidClasses[`${b.type}: ${c}`] = (invalidClasses[`${b.type}: ${c}`] || 0) + 1;
      // (4) value-frequency (only for enum-ish short scalar props, for forced-default detection)
      if (typeof v === 'string' && v.length < 40 && !/customDynamicClass|text|title|link|image|uri|alt|Label|Heading|Description|homePagePath/i.test(k)) {
        const bf = blockValueCounts[b.type][k] = blockValueCounts[b.type][k] || {};
        bf[v] = (bf[v] || 0) + 1;
      }
    }
  });
}

// ---- forced-default detection: a content-default value on ≥98% of instances (n≥20) ----------
const forced = [];
for (const [block, fieldCounts] of Object.entries(blockValueCounts)) {
  const n = fieldCounts.__n;
  if (n < 20) continue;
  const cdef = contentDefaults[block] || {};
  for (const [field, counts] of Object.entries(fieldCounts)) {
    if (field === '__n') continue;
    for (const [val, c] of Object.entries(counts)) {
      if (c / n >= 0.98 && cdef[field] !== undefined && String(cdef[field]) === val)
        forced.push({ block, field, val, pct: Math.round(100 * c / n), n });
    }
  }
}

// ---- report ---------------------------------------------------------------------------------
const sortEntries = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
function section(title, note) { console.log(`\n${'='.repeat(78)}\n${title}\n${note ? '  ' + note + '\n' : ''}${'='.repeat(78)}`); }

console.log(`\nCOVERAGE AUDIT — ${pages} pages\n`);

section('1) DROPPED CONTENT — AEM background container with no hero-container in output',
        'Each row = a page where an AEM bg (image/empty-color container) produced fewer heroes than expected.');
if (!droppedBg.length) console.log('  none ✓');
else { console.log(`  ${droppedBg.length} page(s):`); droppedBg.slice(0, TOP).forEach(d => console.log(`    ${d.rel}  (aem bg=${d.aem}, heroes out=${d.out})`)); }

section('2) UNKNOWN PROPS — produced prop key not in the block\'s EDS model',
        'These props are ignored by EDS (leaking AEM/converter props). "block.prop → count".');
const up = sortEntries(unknownProps);
if (!up.length) console.log('  none ✓');
else up.slice(0, TOP).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));

section('3) INVALID CLASSES — classes_* token never seen in any EDS twin',
        'Likely a raw AEM class or malformed token. "block: token → count".');
const ic = sortEntries(invalidClasses);
if (!ic.length) console.log('  none ✓');
else ic.slice(0, TOP).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));

section('4) FORCED DEFAULTS — a content-default value emitted on ≥98% of instances',
        'Candidate hardcoded variants — verify against the twins whether they should be derived.');
if (!forced.length) console.log('  none ✓');
else forced.sort((a, b) => b.n - a.n).forEach(x => console.log(`  ${String(x.pct).padStart(3)}%  ${x.block}.${x.field} = "${x.val}"   (n=${x.n})`));

console.log('\nDone.\n');
