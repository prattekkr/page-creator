const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'inner-grid-report.json'), 'utf8'));

function tableRows(examples, cols) {
  return examples.map((ex, i) => {
    const cells = cols.map(c => `<td>${ex[c] !== undefined ? ex[c] : ''}</td>`).join('');
    return `<tr><td>${i + 1}</td>${cells}</tr>`;
  }).join('');
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>inner-grid Scenarios Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #222; margin: 0; padding: 24px 32px; }
  h1 { font-size: 20px; color: #1a1a2e; border-bottom: 3px solid #0066f5; padding-bottom: 8px; margin-bottom: 4px; }
  .meta { font-size: 10px; color: #666; margin-bottom: 24px; }
  .summary { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
  .summary-card { background: #f0f4ff; border: 1px solid #c0d0f0; border-radius: 6px; padding: 10px 16px; min-width: 160px; }
  .summary-card .num { font-size: 28px; font-weight: 700; color: #0066f5; }
  .summary-card .label { font-size: 10px; color: #444; margin-top: 2px; }
  .scenario { page-break-inside: avoid; margin-bottom: 32px; }
  .scenario-header { background: #1a1a2e; color: #fff; padding: 8px 14px; border-radius: 6px 6px 0 0; }
  .scenario-header h2 { margin: 0; font-size: 13px; }
  .scenario-header .badge { display: inline-block; background: #0066f5; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 10px; margin-left: 8px; }
  .scenario-body { border: 1px solid #dde; border-top: none; border-radius: 0 0 6px 6px; padding: 12px 14px; }
  .desc-row { display: flex; gap: 24px; margin-bottom: 10px; flex-wrap: wrap; }
  .desc-block { flex: 1; min-width: 220px; }
  .desc-block .label { font-size: 9px; text-transform: uppercase; color: #888; font-weight: 600; margin-bottom: 3px; }
  .desc-block p { margin: 0; font-size: 10.5px; line-height: 1.5; }
  .eds-badge { background: #e8f5e9; border: 1px solid #a5d6a7; border-radius: 4px; padding: 4px 8px; font-family: monospace; font-size: 10px; color: #2e7d32; margin-bottom: 10px; display: inline-block; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #f5f7ff; text-align: left; padding: 5px 8px; border: 1px solid #dde; font-weight: 600; color: #333; }
  td { padding: 5px 8px; border: 1px solid #eee; vertical-align: top; word-break: break-all; }
  tr:nth-child(even) td { background: #fafbff; }
  .aem-path { color: #0050b3; font-family: monospace; font-size: 9.5px; }
  .node { color: #6a0dad; font-family: monospace; }
  .width { color: #d35400; font-weight: 600; font-size: 9.5px; }
  .par { color: #1565c0; font-family: monospace; }
  .note { color: #555; font-size: 9px; font-style: italic; }
  .footer { margin-top: 32px; border-top: 1px solid #dde; padding-top: 8px; font-size: 9px; color: #999; text-align: right; }
  @media print {
    body { padding: 16px 20px; }
    .scenario { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<h1>inner-grid Scenarios — AEM → EDS Migration Report</h1>
<p class="meta">Generated: ${report.generated} &nbsp;|&nbsp; Source: content-xml corpus (3,584 XML files) &nbsp;|&nbsp; Scanner: _inner-grid-report.js</p>

<div class="summary">
  <div class="summary-card">
    <div class="num">${report.summary.scenario1_topLevelWidthContainerWithGrid}</div>
    <div class="label">S1: Top-level width<br>container + grid</div>
  </div>
  <div class="summary-card">
    <div class="num">${report.summary.scenario2_nestedGridInsideParsysCell}</div>
    <div class="label">S2: Grid inside<br>parsys cell</div>
  </div>
  <div class="summary-card">
    <div class="num">${report.summary.scenario3_widthContainerInsideParsysCell}</div>
    <div class="label">S3: Width container<br>inside parsys cell</div>
  </div>
  <div class="summary-card">
    <div class="num">${report.summary.scenario4_heroContinuationBodyWithWidthContainerAndGrid}</div>
    <div class="label">S4: Hero continuation<br>body + width + grid</div>
  </div>
</div>

<!-- SCENARIO 1 -->
<div class="scenario">
  <div class="scenario-header">
    <h2>Scenario 1: ${report.scenarios.scenario1.title} <span class="badge">5 examples</span></h2>
  </div>
  <div class="scenario-body">
    <div class="desc-row">
      <div class="desc-block">
        <div class="label">Description</div>
        <p>${report.scenarios.scenario1.description}</p>
      </div>
      <div class="desc-block">
        <div class="label">Code Path</div>
        <p><code>emitNode()</code> → <code>containerHasWidthStyle() &amp;&amp; containerHasAnyGrid()</code> → <code>collectCellLeaves(node, blocks, 0, '')</code></p>
      </div>
    </div>
    <div class="eds-badge">EDS: ${report.scenarios.scenario1.edsBehaviour}</div>
    <table>
      <thead><tr><th>#</th><th>AEM Page Path</th><th>JCR Container Node</th><th>Width Class</th><th>Note</th></tr></thead>
      <tbody>
        ${report.scenarios.scenario1.examples.map((ex, i) => `
        <tr>
          <td>${i+1}</td>
          <td class="aem-path">${ex.aemPage}</td>
          <td class="node">${ex.containerNode}</td>
          <td class="width">${ex.widthClass}</td>
          <td class="note">${ex.note}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<!-- SCENARIO 2 -->
<div class="scenario">
  <div class="scenario-header">
    <h2>Scenario 2: ${report.scenarios.scenario2.title} <span class="badge">5 examples</span></h2>
  </div>
  <div class="scenario-body">
    <div class="desc-row">
      <div class="desc-block">
        <div class="label">Description</div>
        <p>${report.scenarios.scenario2.description}</p>
      </div>
      <div class="desc-block">
        <div class="label">Code Path</div>
        <p><code>collectCellLeaves()</code> → <code>isGrid(rt)</code> → <code>emitInnerGrid(child, out, depth+1)</code> → blocks get <code>ncol-N</code> class</p>
      </div>
    </div>
    <div class="eds-badge">EDS: ${report.scenarios.scenario2.edsBehaviour}</div>
    <table>
      <thead><tr><th>#</th><th>AEM Page Path</th><th>Par Cell (contains inner grid)</th><th>Total Grids on Page</th><th>Note</th></tr></thead>
      <tbody>
        ${report.scenarios.scenario2.examples.map((ex, i) => `
        <tr>
          <td>${i+1}</td>
          <td class="aem-path">${ex.aemPage}</td>
          <td class="par">${ex.parNode}</td>
          <td style="text-align:center">${ex.gridCount}</td>
          <td class="note">${ex.note}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<!-- SCENARIO 3 -->
<div class="scenario">
  <div class="scenario-header">
    <h2>Scenario 3: ${report.scenarios.scenario3.title} <span class="badge">5 examples</span></h2>
  </div>
  <div class="scenario-body">
    <div class="desc-row">
      <div class="desc-block">
        <div class="label">Description</div>
        <p>${report.scenarios.scenario3.description}</p>
      </div>
      <div class="desc-block">
        <div class="label">Code Path</div>
        <p><code>collectCellLeaves()</code> → <code>isContainer(rt) &amp;&amp; containerHasWidthStyle(child)</code> → emits <code>cols-12,widthClass</code> controller → content becomes <code>col-1</code> blocks</p>
      </div>
    </div>
    <div class="eds-badge">EDS: ${report.scenarios.scenario3.edsBehaviour}</div>
    <table>
      <thead><tr><th>#</th><th>AEM Page Path</th><th>JCR Container Node</th><th>Width Class</th><th>Inside Par Cell</th><th>Note</th></tr></thead>
      <tbody>
        ${report.scenarios.scenario3.examples.map((ex, i) => `
        <tr>
          <td>${i+1}</td>
          <td class="aem-path">${ex.aemPage}</td>
          <td class="node">${ex.containerNode}</td>
          <td class="width">${ex.widthClass}</td>
          <td class="par">${ex.parCell}</td>
          <td class="note">${ex.note}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<!-- SCENARIO 4 -->
<div class="scenario">
  <div class="scenario-header">
    <h2>Scenario 4: ${report.scenarios.scenario4.title} <span class="badge">5 examples</span></h2>
  </div>
  <div class="scenario-body">
    <div class="desc-row">
      <div class="desc-block">
        <div class="label">Description</div>
        <p>${report.scenarios.scenario4.description}</p>
      </div>
      <div class="desc-block">
        <div class="label">Code Path</div>
        <p><code>aemToCanvas()</code> hero merge → <code>bodyGroups</code> → <code>emitHeroContinuationSections()</code> or body group path → emits <code>cols-12,widthClass</code> inner-grid + <code>col-1</code> assignment</p>
      </div>
    </div>
    <div class="eds-badge">EDS: ${report.scenarios.scenario4.edsBehaviour}</div>
    <table>
      <thead><tr><th>#</th><th>AEM Page Path</th><th>JCR Container Node</th><th>Width Class</th><th>Note</th></tr></thead>
      <tbody>
        ${report.scenarios.scenario4.examples.map((ex, i) => `
        <tr>
          <td>${i+1}</td>
          <td class="aem-path">${ex.aemPage}</td>
          <td class="node">${ex.containerNode}</td>
          <td class="width">${ex.widthClass}</td>
          <td class="note">${ex.note}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<div class="footer">
  inner-grid-report.json &nbsp;|&nbsp; _inner-grid-report.js &nbsp;|&nbsp; aem-canvas.js &nbsp;|&nbsp; ACS Amplify
</div>

</body>
</html>`;

const htmlPath = path.join(__dirname, 'inner-grid-report.html');
fs.writeFileSync(htmlPath, html);
console.log('HTML written to inner-grid-report.html');

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  const pdfPath = path.join(__dirname, 'inner-grid-report.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });
  await browser.close();
  console.log('PDF written to inner-grid-report.pdf');
})();
