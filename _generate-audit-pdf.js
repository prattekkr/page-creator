const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const audit = JSON.parse(fs.readFileSync(path.join(__dirname, 'us-en-inner-grid-audit.json'), 'utf8'));
const s = audit.stats;

// ── Dominant pattern analysis ─────────────────────────────────────────────────
// Categorise the over-exploitation cases by the inner-grid classes pattern
const patternCount = {};
for (const r of audit.overExploitation) {
  for (const ig of r.generated.innerGridDetails) {
    const key = ig.classes.split(',').filter(c => /^cols-|^width-/.test(c)).sort().join(',') || ig.classes;
    patternCount[key] = (patternCount[key] || 0) + 1;
  }
}
const topPatterns = Object.entries(patternCount).sort((a, b) => b[1] - a[1]).slice(0, 10);

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const overTable = audit.overExploitation.slice(0, 40).map((r, i) => {
  const igs = r.generated.innerGridDetails.map(ig => `<code>${esc(ig.classes)}</code> <span style="color:#888">(in ${ig.parentType})</span>`).join('<br>');
  return `<tr>
    <td>${i + 1}</td>
    <td class="aem-path">${esc(r.aemPath)}</td>
    <td style="text-align:center">${r.generated.innerGridCount}</td>
    <td style="text-align:center">${r.twin.gridContainers}</td>
    <td>${igs}</td>
  </tr>`;
}).join('');

const matchTable = audit.matched.slice(0, 15).map((r, i) => `
  <tr>
    <td>${i + 1}</td>
    <td class="aem-path">${esc(r.aemPath)}</td>
    <td style="text-align:center">${r.generated.innerGridCount}</td>
    <td style="text-align:center">${r.twin.innerGrids}</td>
    <td class="note">${esc(r.verdictDetail)}</td>
  </tr>`).join('');

const patternRows = topPatterns.map(([k, v], i) => `
  <tr>
    <td>${i + 1}</td>
    <td><code>${esc(k)}</code></td>
    <td style="text-align:center;font-weight:700;color:#c0392b">${v}</td>
    <td class="note">${k === 'cols-12,width-large' || k === 'width-large' ? '⚠ Most common. Container-large inside grid cell → EDS twin simply uses grid-container + width class on grid-section. No inner-grid needed.' :
      k.startsWith('cols-12,width-') ? '⚠ Single-column inner-grid triggered by width-style container inside parsys cell.' :
      k.includes('cols-6-6') ? '✓ Legitimate 2-col split inside a section/grid-section.' :
      k.includes('cols-8-2-2') || k.includes('cols-5-1') ? '✓ Asymmetric layout — may be valid inner-grid or gutter pattern.' :
      'Review individually.'
    }</td>
  </tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>us/en inner-grid Deep Audit</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5px; color: #222; margin: 0; padding: 20px 28px; }
  h1 { font-size: 18px; color: #1a1a2e; border-bottom: 3px solid #c0392b; padding-bottom: 6px; margin-bottom: 4px; }
  h2 { font-size: 13px; color: #1a1a2e; border-left: 4px solid #0066f5; padding-left: 8px; margin: 20px 0 8px; }
  h3 { font-size: 11px; color: #555; margin: 12px 0 6px; }
  .meta { font-size: 9.5px; color: #666; margin-bottom: 16px; }
  .verdict-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .vc { border-radius: 6px; padding: 8px 14px; min-width: 120px; }
  .vc .num { font-size: 26px; font-weight: 700; }
  .vc .lbl { font-size: 9px; margin-top: 1px; }
  .vc.red { background: #fdecea; border: 1px solid #f5c6c2; }
  .vc.red .num { color: #c0392b; }
  .vc.green { background: #e8f5e9; border: 1px solid #a5d6a7; }
  .vc.green .num { color: #27ae60; }
  .vc.blue { background: #e3f2fd; border: 1px solid #90caf9; }
  .vc.blue .num { color: #1565c0; }
  .vc.grey { background: #f5f5f5; border: 1px solid #ddd; }
  .vc.grey .num { color: #555; }
  .vc.amber { background: #fff8e1; border: 1px solid #ffe082; }
  .vc.amber .num { color: #e67e00; }
  .finding { background: #fff8e1; border-left: 4px solid #f39c12; padding: 8px 12px; border-radius: 0 4px 4px 0; margin-bottom: 14px; font-size: 10px; line-height: 1.6; }
  .finding strong { color: #c0392b; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-bottom: 16px; }
  th { background: #1a1a2e; color: #fff; text-align: left; padding: 5px 7px; font-weight: 600; }
  td { padding: 4px 7px; border: 1px solid #eee; vertical-align: top; word-break: break-word; }
  tr:nth-child(even) td { background: #fafafa; }
  .aem-path { color: #0050b3; font-family: monospace; font-size: 8.5px; }
  .note { color: #555; font-size: 9px; font-style: italic; }
  code { background: #f0f0f0; border-radius: 2px; padding: 1px 4px; font-size: 9px; color: #c0392b; }
  .section-title { background: #1a1a2e; color: #fff; padding: 6px 12px; border-radius: 4px; font-size: 11px; font-weight: 700; margin: 18px 0 8px; }
  .footer { margin-top: 24px; border-top: 1px solid #dde; padding-top: 6px; font-size: 8.5px; color: #999; text-align: right; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 8.5px; font-weight: 600; }
  .pill-red { background: #fdecea; color: #c0392b; }
  .pill-green { background: #e8f5e9; color: #27ae60; }
  .pill-amber { background: #fff8e1; color: #e67e00; }
  @media print { body { padding: 12px 18px; } }
</style>
</head>
<body>

<h1>us/en inner-grid Deep Audit — AEM → EDS 1:1 Mapping</h1>
<p class="meta">Generated: ${audit.generated} &nbsp;|&nbsp; Pages analysed: ${s.total} us/en pages &nbsp;|&nbsp; Source: aemToCanvas() vs EDS twin XML &nbsp;|&nbsp; Tool: _deep-inner-grid-audit.js</p>

<!-- VERDICT SUMMARY -->
<div class="verdict-bar">
  <div class="vc grey"><div class="num">${s.total}</div><div class="lbl">Total us/en pages</div></div>
  <div class="vc red"><div class="num">${s.withInnerGrid}</div><div class="lbl">Pages generating inner-grid (${Math.round(s.withInnerGrid/s.total*100)}%)</div></div>
  <div class="vc red"><div class="num">${s.overInnerGrid}</div><div class="lbl">⚠ OVER_INNER_GRID<br>(twin uses grid-container)</div></div>
  <div class="vc green"><div class="num">${s.matchInnerGrid}</div><div class="lbl">✓ MATCH<br>(twin also uses it)</div></div>
  <div class="vc amber"><div class="num">${s.missingInnerGrid}</div><div class="lbl">MISSING<br>(twin has it, gen. doesn't)</div></div>
  <div class="vc blue"><div class="num">${s.noInnerGrid}</div><div class="lbl">No inner-grid<br>(correct)</div></div>
  <div class="vc grey"><div class="num">${s.pagesWithWidthContainerGrid}</div><div class="lbl">AEM pages with<br>width-container+grid</div></div>
</div>

<!-- KEY FINDING -->
<div class="finding">
  <strong>KEY FINDING — Confirmed over-exploitation of inner-grid:</strong><br>
  <strong>${s.overInnerGrid} out of ${s.withInnerGrid} pages (${Math.round(s.overInnerGrid/s.withInnerGrid*100)}%) that generate inner-grid do NOT have it in the EDS twin.</strong>
  The twin uses a regular <code>grid-container</code> / <code>grid-section</code> instead.<br><br>
  <strong>Root cause:</strong> When an AEM author puts a <code>container-large</code> (or any container-* width styleId) inside a grid cell parsys
  to constrain the text reading width, <code>aem-canvas.js</code> detects <em>containerHasWidthStyle() + containerHasAnyGrid()</em> and emits an
  <code>inner-grid {cols-12, width-large}</code> controller. But the EDS hand-crafted twin simply applies the width constraint directly on the
  enclosing <code>grid-section</code> — no inner-grid is created. This pattern dominates story pages (74 of 96 story pages affected).<br><br>
  <strong>The <code>cols-12,width-large</code> pattern is a single-column, full-row width-constraint — not a true multi-column inner layout.</strong>
  A <code>cols-12</code> inner-grid with one column is semantically equivalent to setting a width class on the grid-section itself.
</div>

<!-- DOMINANT PATTERNS -->
<div class="section-title">Top Inner-Grid Class Patterns in Over-Exploitation Cases</div>
<table>
  <thead><tr><th>#</th><th>inner-grid classes (cols + width)</th><th>Occurrences</th><th>Assessment</th></tr></thead>
  <tbody>${patternRows}</tbody>
</table>

<!-- OVER-EXPLOITATION TABLE -->
<div class="section-title">⚠ OVER_INNER_GRID — Generated inner-grid but twin uses grid-container (first 40 of ${s.overInnerGrid})</div>
<table>
  <thead><tr><th>#</th><th>AEM Page Path</th><th>Gen inner-grids</th><th>Twin grid-containers</th><th>Generated inner-grid classes</th></tr></thead>
  <tbody>${overTable}</tbody>
</table>
${s.overInnerGrid > 40 ? `<p class="note">... and ${s.overInnerGrid - 40} more pages. See us-en-inner-grid-audit.json for full list.</p>` : ''}

<!-- MATCH TABLE -->
<div class="section-title">✓ MATCH — Both generated and twin use inner-grid (${s.matchInnerGrid} pages)</div>
<table>
  <thead><tr><th>#</th><th>AEM Page Path</th><th>Gen inner-grids</th><th>Twin inner-grids</th><th>Detail</th></tr></thead>
  <tbody>${matchTable}</tbody>
</table>
${s.matchInnerGrid > 15 ? `<p class="note">... and ${s.matchInnerGrid - 15} more. See us-en-inner-grid-audit.json.</p>` : ''}

<!-- RECOMMENDATIONS -->
<h2>Recommendations — When to Use inner-grid vs grid-container</h2>

<h3>✓ Use inner-grid ONLY for these cases:</h3>
<table>
  <thead><tr><th>Pattern</th><th>Trigger condition</th><th>Example classes</th></tr></thead>
  <tbody>
    <tr><td><strong>True multi-column layout inside a grid cell</strong></td><td>Grid inside a parsys cell (par_RC) where columns ≥ 2 and widths are non-trivial (not cols-12)</td><td><code>cols-6-6</code>, <code>cols-8-2-2</code>, <code>cols-5-1-5-1</code></td></tr>
    <tr><td><strong>Asymmetric nested layout</strong></td><td>par_RC contains a grid with mixed column widths creating a visual side-by-side layout</td><td><code>cols-10-2</code>, <code>cols-5-1-6</code></td></tr>
    <tr><td><strong>Contact-us / migraine-friendly pattern</strong></td><td>Hero continuation body with width-style container + real multi-col grid</td><td><code>cols-12,width-medium</code> with col-1 and actual 2+ blocks</td></tr>
  </tbody>
</table>

<h3>✗ Do NOT use inner-grid for these cases (use grid-container instead):</h3>
<table>
  <thead><tr><th>Pattern</th><th>Current trigger (incorrect)</th><th>Correct EDS output</th></tr></thead>
  <tbody>
    <tr>
      <td><strong>Width-constraint on a single grid column</strong><br><code>container-large</code> wrapping all content inside a <code>cols-12</code> or single parsys cell</td>
      <td><code>containerHasWidthStyle() + containerHasAnyGrid()</code> fires even when it's a <code>cols-12</code> single column</td>
      <td>Apply <code>width-large</code> class directly to the parent <code>grid-section</code> — no inner-grid needed</td>
    </tr>
    <tr>
      <td><strong>Story page text/image layout</strong><br>Article body paragraphs in a <code>container-large</code> inside a single-column grid</td>
      <td>Every section of a story article generates a new <code>inner-grid {cols-12,width-large}</code></td>
      <td>Single <code>grid-container</code> with <code>grid-section {width-large}</code> blocks. EDS twin confirmed: 1 grid-container per article, 0 inner-grids</td>
    </tr>
    <tr>
      <td><strong>Top-level width-container with a grid that maps directly to EDS grid-container</strong></td>
      <td>Scenario 1: top-level container has width-styleId + grid → emitNode() fires inner-grid path</td>
      <td>If the inner grid has multi-column layout, it should be a <code>grid-container</code> + <code>grid-section</code> with the width class on the container props</td>
    </tr>
  </tbody>
</table>

<h3>Proposed fix in aem-canvas.js:</h3>
<table>
  <thead><tr><th>Location</th><th>Current behaviour</th><th>Proposed change</th></tr></thead>
  <tbody>
    <tr>
      <td><code>collectCellLeaves()</code> — Scenario 3</td>
      <td>Any <code>container-*</code> with <code>containerHasWidthStyle()</code> inside a parsys cell → emits <code>inner-grid {cols-12, widthClass}</code></td>
      <td>Only emit inner-grid when the container's grid has <strong>more than 1 column</strong> OR the grid width is not <code>cols-12</code>. If grid is single-column (<code>cols-12</code>), propagate the width class to the enclosing grid-section instead.</td>
    </tr>
    <tr>
      <td><code>emitNode()</code> — Scenario 1</td>
      <td>Top-level <code>container-*</code> with any grid → always routes to <code>collectCellLeaves()</code> (inner-grid path)</td>
      <td>Check whether the inner grid is multi-column. If single-column only, route to normal <code>grid-container</code> path with width class on props instead.</td>
    </tr>
  </tbody>
</table>

<div class="footer">
  _deep-inner-grid-audit.js &nbsp;|&nbsp; us-en-inner-grid-audit.json &nbsp;|&nbsp; aem-canvas.js &nbsp;|&nbsp; ACS Amplify
</div>

</body>
</html>`;

const htmlPath = path.join(__dirname, 'us-en-inner-grid-audit.html');
fs.writeFileSync(htmlPath, html);
console.log('HTML written to us-en-inner-grid-audit.html');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  const pdfPath = path.join(__dirname, 'us-en-inner-grid-audit.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
  });
  await browser.close();
  console.log('PDF written to us-en-inner-grid-audit.pdf');
})();
