/**
 * Locale-parametric inner-grid audit.
 * Usage: node _locale-inner-grid-audit.js nz/en
 *
 * Runs aemToCanvas() on every page for the given locale, compares against
 * the EDS twin XML, detects:
 *   - OVER_INNER_GRID: generated inner-grid where twin uses grid-container
 *   - INNER_GRID_NOT_IN_TWIN: twin has no grid structure at all
 *   - MATCH: both sides agree
 *   - MISSING: twin has inner-grid but generated doesn't
 *   - FALSE_POSITIVE: generated inner-grid with cols-12 only (single-column
 *     width-constraint, not a real multi-column inner layout)
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');
const puppeteer = require('puppeteer');

const LOCALE = process.argv[2] || 'nz/en';
const CONTENT_XML_ROOT = path.join(__dirname, 'content-xml');
const EDS_XML_ROOT = path.join(__dirname, 'eds-xml');
const WIDTH_STYLE_IDS = new Set([
  '1653545825684','1653545825685','1653545825686','1653545825687',
  '1653545825688','1653545825689','1653545825690','1653545825692',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

function parseXml(filePath) {
  try { return parser.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function findJcrContent(parsed) {
  if (!parsed) return null;
  const root = parsed['jcr:root'] || parsed;
  return root?.['jcr:content'] || null;
}

// ── Walk generated canvas collecting every inner-grid ───────────────────────
function collectInnerGrids(sections) {
  const found = [];
  function walk(entity, sectionIdx, parentType) {
    if (!entity) return;
    if (entity.type === 'inner-grid') {
      const classes = entity.props?.classes_customDynamicClass || '';
      const cols = classes.split(',').find(c => c.startsWith('cols-')) || '';
      const widthCls = classes.split(',').filter(c => /^width-/.test(c)).join(',');
      const colParts = cols.replace('cols-', '').split('-').filter(Boolean);
      const isSingleCol = colParts.length === 1; // e.g. cols-12 = single column
      const isCols12 = cols === 'cols-12';
      found.push({
        classes, cols, widthCls, isSingleCol, isCols12,
        isFalsePositive: isCols12, // cols-12 width-constraint = false positive inner-grid
        parentType, sectionIdx,
      });
    }
    for (const child of (entity.children || entity.blocks || [])) {
      walk(child, sectionIdx, entity.type);
    }
  }
  sections.forEach((s, i) => walk(s, i, 'root'));
  return found;
}

function collectGridContainers(sections) {
  const found = [];
  sections.forEach((s, i) => {
    if (s.type === 'grid-container') {
      found.push({ sectionIdx: i, blockCount: (s.blocks || []).length });
    }
  });
  return found;
}

function collectEdsBlockTypes(edsXmlPath) {
  if (!fs.existsSync(edsXmlPath)) return null;
  const txt = fs.readFileSync(edsXmlPath, 'utf8');
  // Count inner-grid occurrences via various attribute patterns in EDS XML
  const innerGridCount = (txt.match(/"inner-grid"/g) || []).length
    + (txt.match(/filter="inner-grid"/g) || []).length;
  const gridContainerCount = (txt.match(/filter="grid-container"/g) || []).length;
  const gridSectionCount = (txt.match(/filter="grid-section"/g) || []).length;
  const blockTypes = [...new Set([...txt.matchAll(/filter="([^"]+)"/g)].map(m => m[1]))];
  return { innerGridCount, gridContainerCount, gridSectionCount, blockTypes };
}

// ── Get locale pages ──────────────────────────────────────────────────────────
const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, 'page-pairs.json'), 'utf8'));
const localePairs = pairs.filter(p => p.startsWith(LOCALE));

console.log(`\nLocale: ${LOCALE} — ${localePairs.length} pages to audit...\n`);

const results = [];
let processed = 0;

for (const rel of localePairs) {
  const aemDir = path.join(CONTENT_XML_ROOT, ...rel.split('/'));
  const aemXmlPath = [
    path.join(aemDir, '.content.xml'),
    path.join(CONTENT_XML_ROOT, rel + '.xml'),
  ].find(p => fs.existsSync(p));

  const edsDir = path.join(EDS_XML_ROOT, ...rel.split('/'));
  const edsXmlPath = [
    path.join(edsDir, '.content.xml'),
    path.join(EDS_XML_ROOT, rel + '.xml'),
  ].find(p => fs.existsSync(p));

  if (!aemXmlPath) { processed++; continue; }

  let generatedSections = [];
  let genError = null;
  try {
    const parsed = parseXml(aemXmlPath);
    const jcrContent = findJcrContent(parsed);
    if (jcrContent) generatedSections = aemToCanvas(jcrContent, { rel });
  } catch (e) { genError = e.message; }

  const genInnerGrids = collectInnerGrids(generatedSections);
  const genGridContainers = collectGridContainers(generatedSections);
  const falsePositives = genInnerGrids.filter(ig => ig.isFalsePositive);
  const legitimateInnerGrids = genInnerGrids.filter(ig => !ig.isFalsePositive);

  const twinData = edsXmlPath ? collectEdsBlockTypes(edsXmlPath) : null;

  const aemTxt = fs.readFileSync(aemXmlPath, 'utf8');
  const aemGridCount = (aemTxt.match(/sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/g) || []).length;
  const hasWidthContainerWithGrid = (() => {
    for (const m of [...aemTxt.matchAll(/<(\w+)\s[^/]*?sling:resourceType="abbvie-com2\/components\/container\/v2\/container"[^>]*>/g)]) {
      const tagEnd = aemTxt.indexOf('>', m.index);
      const tagText = aemTxt.slice(m.index, tagEnd + 1);
      const sm = tagText.match(/cq:styleIds="\[([^\]]+)\]"/);
      if (!sm) continue;
      const ids = sm[1].split(',').map(s => s.trim().replace(/"/g, ''));
      if (!ids.some(id => WIDTH_STYLE_IDS.has(id))) continue;
      const after = aemTxt.slice(m.index, m.index + 6000);
      if (/sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/.test(after)) return true;
    }
    return false;
  })();

  // ── Verdict ────────────────────────────────────────────────────────────────
  let verdict = 'no-inner-grid';
  let verdictDetail = '';
  const hasFP = falsePositives.length > 0;
  const hasLegit = legitimateInnerGrids.length > 0;

  if (genInnerGrids.length > 0 && twinData) {
    if (hasFP && !hasLegit && twinData.innerGridCount === 0 && twinData.gridContainerCount > 0) {
      verdict = 'FALSE_POSITIVE'; // all inner-grids are cols-12, twin uses grid-container
      verdictDetail = `All ${genInnerGrids.length} generated inner-grid(s) are cols-12 (single-column width-constraint) — FALSE POSITIVE. Twin uses ${twinData.gridContainerCount} grid-container(s) with 0 inner-grids.`;
    } else if (hasFP && !hasLegit && twinData.innerGridCount === 0 && twinData.gridContainerCount === 0) {
      verdict = 'FALSE_POSITIVE_NO_GRID';
      verdictDetail = `All ${genInnerGrids.length} inner-grid(s) are cols-12 — FALSE POSITIVE. Twin has NO grid structure at all.`;
    } else if (twinData.innerGridCount === 0 && twinData.gridContainerCount > 0) {
      verdict = 'OVER_INNER_GRID';
      verdictDetail = `Generated ${genInnerGrids.length} inner-grid(s) (${falsePositives.length} FP cols-12 + ${legitimateInnerGrids.length} legit) but twin uses ${twinData.gridContainerCount} grid-container(s) and 0 inner-grids.`;
    } else if (twinData.innerGridCount === 0 && twinData.gridContainerCount === 0) {
      verdict = 'INNER_GRID_NOT_IN_TWIN';
      verdictDetail = `Generated ${genInnerGrids.length} inner-grid(s) but twin has NO inner-grid and NO grid-container.`;
    } else if (twinData.innerGridCount > 0) {
      verdict = hasFP ? 'MATCH_WITH_FP' : 'MATCH';
      verdictDetail = `Both generated and twin use inner-grid. Gen: ${genInnerGrids.length} (${falsePositives.length} FP), twin: ${twinData.innerGridCount}. ${hasFP ? '⚠ Some generated cols-12 inner-grids may be false positives.' : ''}`;
    }
  } else if (genInnerGrids.length === 0 && twinData && twinData.innerGridCount > 0) {
    verdict = 'MISSING_INNER_GRID';
    verdictDetail = `Twin has ${twinData.innerGridCount} inner-grid(s) but generated output has none.`;
  } else if (genInnerGrids.length === 0) {
    verdict = 'no-inner-grid';
    verdictDetail = 'No inner-grid generated.';
  }

  results.push({
    page: rel,
    aemPath: `/content/abbvie-com2/${rel}`,
    aemXmlFile: aemXmlPath.replace(__dirname, '.'),
    edsXmlFile: edsXmlPath ? edsXmlPath.replace(__dirname, '.') : 'NOT FOUND',
    aemGridCount,
    hasWidthContainerWithGrid,
    generated: {
      innerGridTotal: genInnerGrids.length,
      falsePositiveCount: falsePositives.length,
      legitimateCount: legitimateInnerGrids.length,
      gridContainerCount: genGridContainers.length,
      totalSections: generatedSections.length,
      innerGridDetails: genInnerGrids,
      error: genError,
    },
    twin: twinData || { note: 'EDS twin not found' },
    verdict,
    verdictDetail,
  });

  processed++;
  if (processed % 10 === 0) process.stdout.write(`  ${processed}/${localePairs.length}\r`);
}

console.log(`\nProcessed ${processed} pages.\n`);

// ── Stats ──────────────────────────────────────────────────────────────────────
const stats = {
  total: results.length,
  withInnerGrid: results.filter(r => r.generated.innerGridTotal > 0).length,
  falsePositivePages: results.filter(r => r.verdict === 'FALSE_POSITIVE' || r.verdict === 'FALSE_POSITIVE_NO_GRID').length,
  overInnerGrid: results.filter(r => r.verdict === 'OVER_INNER_GRID').length,
  matchInnerGrid: results.filter(r => r.verdict === 'MATCH' || r.verdict === 'MATCH_WITH_FP').length,
  matchWithFP: results.filter(r => r.verdict === 'MATCH_WITH_FP').length,
  missingInnerGrid: results.filter(r => r.verdict === 'MISSING_INNER_GRID').length,
  innerGridNotInTwin: results.filter(r => r.verdict === 'INNER_GRID_NOT_IN_TWIN').length,
  noInnerGrid: results.filter(r => r.verdict === 'no-inner-grid').length,
  noEdsXml: results.filter(r => r.edsXmlFile === 'NOT FOUND').length,
  totalFalsePositiveInstances: results.reduce((acc, r) => acc + r.generated.falsePositiveCount, 0),
  totalLegitInnerGridInstances: results.reduce((acc, r) => acc + r.generated.legitimateCount, 0),
};

// Pattern frequency
const patternCount = {};
for (const r of results) {
  for (const ig of r.generated.innerGridDetails) {
    const key = ig.cols || 'no-cols';
    patternCount[key] = (patternCount[key] || { total: 0, fp: 0 });
    patternCount[key].total++;
    if (ig.isFalsePositive) patternCount[key].fp++;
  }
}

const output = {
  generated: new Date().toISOString(),
  locale: LOCALE,
  stats,
  patternFrequency: Object.entries(patternCount).sort((a, b) => b[1].total - a[1].total),
  falsePositives: results.filter(r => r.verdict === 'FALSE_POSITIVE' || r.verdict === 'FALSE_POSITIVE_NO_GRID'),
  overExploitation: results.filter(r => r.verdict === 'OVER_INNER_GRID'),
  matched: results.filter(r => r.verdict === 'MATCH' || r.verdict === 'MATCH_WITH_FP'),
  missingInnerGrid: results.filter(r => r.verdict === 'MISSING_INNER_GRID'),
  allResults: results,
};

const localeSlug = LOCALE.replace('/', '-');
const jsonPath = path.join(__dirname, `${localeSlug}-inner-grid-audit.json`);
fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

console.log(`=== ${LOCALE} inner-grid audit ===`);
console.log(`Total pages:                    ${stats.total}`);
console.log(`Pages generating inner-grid:    ${stats.withInnerGrid}`);
console.log(`  → FALSE_POSITIVE (cols-12):   ${stats.falsePositivePages}`);
console.log(`  → OVER_INNER_GRID:            ${stats.overInnerGrid}`);
console.log(`  → MATCH:                      ${stats.matchInnerGrid} (${stats.matchWithFP} with FP instances)`);
console.log(`  → MISSING:                    ${stats.missingInnerGrid}`);
console.log(`  → NOT_IN_TWIN:                ${stats.innerGridNotInTwin}`);
console.log(`Total FALSE_POSITIVE instances: ${stats.totalFalsePositiveInstances}`);
console.log(`Total LEGIT inner-grid:         ${stats.totalLegitInnerGridInstances}`);
console.log(`\nReport written to ${localeSlug}-inner-grid-audit.json`);

// ── PDF generation ─────────────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

const patternRows = output.patternFrequency.slice(0, 12).map(([k, v], i) => `
  <tr>
    <td>${i+1}</td>
    <td><code>${esc(k)}</code></td>
    <td style="text-align:center">${v.total}</td>
    <td style="text-align:center;color:${v.fp > 0 ? '#c0392b' : '#27ae60'};font-weight:700">${v.fp}</td>
    <td style="text-align:center">${v.total - v.fp}</td>
    <td class="note">${k === 'cols-12' ? '⚠ FALSE POSITIVE — single-column width-constraint. Use grid-section widthClass instead.' :
      k === 'no-cols' ? 'No cols class — review individually.' :
      k.split('-').length > 2 ? '✓ Multi-column — legitimate inner-grid use.' :
      'Single col (non-12) — review context.'
    }</td>
  </tr>`).join('');

const fpRows = output.falsePositives.concat(output.overExploitation).slice(0, 50).map((r, i) => {
  const igs = r.generated.innerGridDetails.map(ig =>
    `<code class="${ig.isFalsePositive ? 'fp' : 'legit'}">${esc(ig.classes)}</code>`
  ).join(' ');
  const verdictClass = r.verdict.startsWith('FALSE') ? 'fp-row' : 'over-row';
  return `<tr class="${verdictClass}">
    <td>${i+1}</td>
    <td class="aem-path">${esc(r.aemPath)}</td>
    <td style="text-align:center">${r.generated.innerGridTotal}</td>
    <td style="text-align:center;color:#c0392b">${r.generated.falsePositiveCount}</td>
    <td style="text-align:center;color:#27ae60">${r.generated.legitimateCount}</td>
    <td style="text-align:center">${(r.twin.gridContainerCount||0)}</td>
    <td style="font-size:8px"><span class="pill pill-${r.verdict.startsWith('FALSE')?'red':'amber'}">${r.verdict}</span></td>
    <td>${igs}</td>
  </tr>`;
}).join('');

const matchRows = output.matched.slice(0, 20).map((r, i) => {
  const hasFP = r.generated.falsePositiveCount > 0;
  return `<tr>
    <td>${i+1}</td>
    <td class="aem-path">${esc(r.aemPath)}</td>
    <td style="text-align:center">${r.generated.innerGridTotal}</td>
    <td style="text-align:center${hasFP ? ';color:#c0392b' : ''}">${r.generated.falsePositiveCount}</td>
    <td style="text-align:center">${r.twin.innerGridCount||0}</td>
    <td class="note">${esc(r.verdictDetail)}</td>
  </tr>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(LOCALE)} inner-grid audit</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5px; color: #222; margin: 0; padding: 20px 28px; }
  h1 { font-size: 17px; color: #1a1a2e; border-bottom: 3px solid #c0392b; padding-bottom: 6px; margin-bottom: 4px; }
  h2 { font-size: 12px; color: #1a1a2e; border-left: 4px solid #0066f5; padding-left: 8px; margin: 18px 0 6px; }
  .meta { font-size: 9.5px; color: #666; margin-bottom: 14px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .card { border-radius: 6px; padding: 7px 12px; min-width: 110px; }
  .card .num { font-size: 24px; font-weight: 700; }
  .card .lbl { font-size: 9px; }
  .red { background:#fdecea;border:1px solid #f5c6c2; } .red .num{color:#c0392b;}
  .green { background:#e8f5e9;border:1px solid #a5d6a7; } .green .num{color:#27ae60;}
  .blue { background:#e3f2fd;border:1px solid #90caf9; } .blue .num{color:#1565c0;}
  .grey { background:#f5f5f5;border:1px solid #ddd; } .grey .num{color:#555;}
  .amber { background:#fff8e1;border:1px solid #ffe082; } .amber .num{color:#e67e00;}
  .finding { background:#fff8e1;border-left:4px solid #f39c12;padding:8px 12px;border-radius:0 4px 4px 0;margin-bottom:12px;font-size:10px;line-height:1.6; }
  .finding strong { color:#c0392b; }
  table { width:100%;border-collapse:collapse;font-size:9.5px;margin-bottom:14px; }
  th { background:#1a1a2e;color:#fff;text-align:left;padding:5px 7px;font-weight:600; }
  td { padding:4px 7px;border:1px solid #eee;vertical-align:top;word-break:break-word; }
  tr:nth-child(even) td { background:#fafafa; }
  .fp-row td { background:#fff5f5!important; }
  .over-row td { background:#fff9f0!important; }
  .aem-path { color:#0050b3;font-family:monospace;font-size:8.5px; }
  .note { color:#555;font-size:9px;font-style:italic; }
  code { background:#f0f0f0;border-radius:2px;padding:1px 4px;font-size:9px;color:#c0392b; }
  code.legit { color:#27ae60; }
  code.fp { color:#c0392b;text-decoration:underline dotted; }
  .sec-hdr { background:#1a1a2e;color:#fff;padding:6px 12px;border-radius:4px;font-size:11px;font-weight:700;margin:16px 0 8px; }
  .pill { display:inline-block;padding:1px 6px;border-radius:10px;font-size:8px;font-weight:600; }
  .pill-red{background:#fdecea;color:#c0392b;}
  .pill-amber{background:#fff8e1;color:#e67e00;}
  .pill-green{background:#e8f5e9;color:#27ae60;}
  .footer{margin-top:20px;border-top:1px solid #dde;padding-top:6px;font-size:8.5px;color:#999;text-align:right;}
  @media print{body{padding:12px 18px;}}
</style>
</head>
<body>

<h1>${esc(LOCALE.toUpperCase())} inner-grid Deep Audit — AEM → EDS 1:1 Mapping</h1>
<p class="meta">Generated: ${output.generated} &nbsp;|&nbsp; ${stats.total} pages &nbsp;|&nbsp; aemToCanvas() vs EDS twin XML &nbsp;|&nbsp; Tool: _locale-inner-grid-audit.js</p>

<div class="cards">
  <div class="card grey"><div class="num">${stats.total}</div><div class="lbl">Total pages</div></div>
  <div class="card red"><div class="num">${stats.withInnerGrid}</div><div class="lbl">Generating inner-grid</div></div>
  <div class="card red"><div class="num">${stats.falsePositivePages}</div><div class="lbl">⚠ FALSE_POSITIVE<br>(cols-12 only)</div></div>
  <div class="card amber"><div class="num">${stats.overInnerGrid}</div><div class="lbl">OVER_INNER_GRID<br>(twin uses grid-cont.)</div></div>
  <div class="card green"><div class="num">${stats.matchInnerGrid}</div><div class="lbl">✓ MATCH</div></div>
  <div class="card blue"><div class="num">${stats.missingInnerGrid}</div><div class="lbl">MISSING in generated</div></div>
  <div class="card red"><div class="num">${stats.totalFalsePositiveInstances}</div><div class="lbl">Total FP instances<br>(cols-12 inner-grids)</div></div>
  <div class="card green"><div class="num">${stats.totalLegitInnerGridInstances}</div><div class="lbl">Total LEGIT<br>inner-grid instances</div></div>
</div>

<div class="finding">
  <strong>KEY FINDING for ${esc(LOCALE)}:</strong><br>
  <strong>FALSE POSITIVE inner-grids (cols-12 single-column width-constraint): ${stats.totalFalsePositiveInstances} instances across ${stats.falsePositivePages + stats.overInnerGrid} pages.</strong>
  These are generated where an AEM container with a width styleId wraps content inside a single-column grid cell.
  The converter emits <code>inner-grid {cols-12, width-*}</code> but the EDS twin simply applies the width class on the <code>grid-section</code> without any inner-grid.
  A <code>cols-12</code> inner-grid is semantically a no-op for layout — it's just a width constraint.<br><br>
  <strong>LEGITIMATE inner-grids (multi-column, e.g. cols-6-6, cols-8-2-2): ${stats.totalLegitInnerGridInstances} instances</strong> — these are correct and should be kept.
</div>

<div class="sec-hdr">Inner-Grid Class Pattern Frequency (FP = cols-12 false positives)</div>
<table>
  <thead><tr><th>#</th><th>cols class</th><th>Total instances</th><th>False Positive (cols-12)</th><th>Legitimate</th><th>Assessment</th></tr></thead>
  <tbody>${patternRows}</tbody>
</table>

<div class="sec-hdr">⚠ FALSE_POSITIVE + OVER_INNER_GRID pages (first 50 of ${stats.falsePositivePages + stats.overInnerGrid})</div>
<p style="font-size:9px;color:#666;margin-bottom:6px">
  <span style="background:#fff5f5;padding:2px 6px;border-radius:3px">Red rows = FALSE_POSITIVE</span> &nbsp;
  <span style="background:#fff9f0;padding:2px 6px;border-radius:3px">Orange rows = OVER_INNER_GRID</span> &nbsp;
  <code style="text-decoration:underline dotted">underlined code</code> = false positive instance &nbsp;
  <code class="legit">green code</code> = legitimate
</p>
<table>
  <thead><tr><th>#</th><th>AEM Page</th><th>Total IG</th><th>FP count</th><th>Legit count</th><th>Twin grid-cont.</th><th>Verdict</th><th>inner-grid classes</th></tr></thead>
  <tbody>${fpRows}</tbody>
</table>

<div class="sec-hdr">✓ MATCH — Generated and twin agree on inner-grid (${stats.matchInnerGrid} pages)</div>
<table>
  <thead><tr><th>#</th><th>AEM Page</th><th>Gen IG</th><th>FP in gen</th><th>Twin IG</th><th>Detail</th></tr></thead>
  <tbody>${matchRows}</tbody>
</table>

<h2>Fix Guide for aem-canvas.js</h2>
<table>
  <thead><tr><th>Broken path</th><th>Trigger</th><th>Correct output</th><th>Guard logic</th></tr></thead>
  <tbody>
    <tr>
      <td><code>collectCellLeaves()</code> S3</td>
      <td><code>container-*</code> inside parsys cell with any grid</td>
      <td>If resolved cols = <code>cols-12</code> → emit as normal <code>grid-section</code> with <code>widthClass</code> prop.<br>If cols ≠ <code>cols-12</code> → keep inner-grid (legit multi-col).</td>
      <td><code>if (resolvedCols === 'cols-12') { parentGridSection.props.widthClass = wc; return; }</code></td>
    </tr>
    <tr>
      <td><code>emitNode()</code> S1</td>
      <td>Top-level <code>container-*</code> with any nested grid</td>
      <td>Check if inner grid is truly multi-column. If <code>cols-12</code>, emit as <code>grid-container</code> with width on props.</td>
      <td><code>if (!isMultiColGrid(node)) return emitAsGridContainer(node, widthClass);</code></td>
    </tr>
    <tr>
      <td>Hero continuation body S4</td>
      <td>Body container with <code>container-*</code> + single-col grid</td>
      <td>Same — if grid is single-column, skip inner-grid and apply width class to the grid-section.</td>
      <td>Same guard as S3.</td>
    </tr>
  </tbody>
</table>

<div class="footer">_locale-inner-grid-audit.js &nbsp;|&nbsp; ${localeSlug}-inner-grid-audit.json &nbsp;|&nbsp; aem-canvas.js &nbsp;|&nbsp; ACS Amplify</div>

</body>
</html>`;

const htmlPath = path.join(__dirname, `${localeSlug}-inner-grid-audit.html`);
fs.writeFileSync(htmlPath, html);
console.log(`HTML written to ${localeSlug}-inner-grid-audit.html`);

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  const pdfPath = path.join(__dirname, `${localeSlug}-inner-grid-audit.pdf`);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
  });
  await browser.close();
  console.log(`PDF written to ${localeSlug}-inner-grid-audit.pdf`);
})();
